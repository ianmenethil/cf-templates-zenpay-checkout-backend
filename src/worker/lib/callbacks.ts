import type { CallbackDetail, CallbackList, CallbackOutcome, CallbackRecord } from '../../shared/types';
import { PAGE_SIZE, formatCursor, type Cursor } from './cursor';
import { retentionCutoff } from './retention';

/** Columns of a callback list row; the body is read only for one callback. */
const RECORD_COLUMNS = 'id, payment_id, received_at, last_received_at, deliveries, outcome, reason, size';

/** A callback list row as `RECORD_COLUMNS` reads it from the database. */
type RecordRow = {
  id: string;
  payment_id: string | null;
  received_at: string;
  last_received_at: string;
  deliveries: number;
  outcome: CallbackOutcome;
  reason: string | null;
  size: number;
};

/** A callback row with its body, for the one callback or the payment's callbacks the admin API shows whole. */
type DetailRow = RecordRow & { body: string };

/** What the callback route hands over to be stored. */
export type NewCallback = {
  /** The payment it belongs to, or `null` when there is none to point at. */
  paymentId: string | null;
  outcome: CallbackOutcome;
  /** Why it was rejected, or `null` when it was not. */
  reason: string | null;
  /** Length in bytes of the body as received. */
  size: number;
  /** The body as received, as text; `storeCallback` cuts it when the callback is not worth keeping whole. */
  body: string;
  /** SHA-256 of the body's bytes in hex; with the payment it identifies a repeat. */
  bodyHash: string;
};

/**
 * Turns a database row into what the admin API returns.
 * @param row - A callback row, without its body.
 * @returns The callback record.
 */
const toRecord = (row: RecordRow): CallbackRecord => ({
  id: row.id,
  paymentId: row.payment_id,
  receivedAt: row.received_at,
  lastReceivedAt: row.last_received_at,
  deliveries: row.deliveries,
  outcome: row.outcome,
  reason: row.reason,
  size: row.size,
});

/**
 * Hashes a body so a repeat of it can be recognised.
 * @param bytes - The body exactly as received.
 * @returns SHA-256 in lower-case hex.
 */
export const hashBody = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Most distinct bodies kept for one payment; the public callback address would otherwise let anyone fill the database. */
const MAX_BODIES_PER_PAYMENT = 10;

/** Most bytes of a body kept for a rejected callback or one with no payment; `size` and `body_hash` still describe the whole body. */
const MAX_REJECTED_BODY_BYTES = 4096;

/**
 * Keeps the first bytes of a body that is not worth keeping whole. The cut falls on a character boundary, so a
 * character that straddles the limit is dropped whole instead of being turned into a 3 byte replacement character:
 * the result never takes more than 4096 bytes.
 * @param body - The body as text.
 * @returns The body, or its longest start that fits in 4096 bytes when it is longer.
 */
const truncatedBody = (body: string): string => {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength <= MAX_REJECTED_BODY_BYTES) {
    return body;
  }
  // A UTF-8 continuation byte is 0b10xxxxxx; the cut goes back to the byte that starts the character it would split.
  let end = MAX_REJECTED_BODY_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
};

/**
 * Builds the statement that stores a callback, or counts it when the same body already arrived for the same
 * payment. One statement does both: a body the payment already holds hits the unique index on
 * `(payment_id, body_hash)` and adds 1 to `deliveries` instead of inserting a row, so two deliveries that arrive
 * at the same moment still produce one row. Callbacks with no payment never conflict and are always stored.
 * A payment keeps at most 10 distinct bodies: past that nothing new is stored, but a repeat of a stored body still counts.
 * A rejected callback, or one with no payment, keeps only the first 4096 bytes of its body.
 * @param db - The `DB` database.
 * @param callback - The callback to store.
 * @returns The statement, to run alone or in a batch with the payment's change.
 */
export const storeCallback = (db: D1Database, callback: NewCallback): D1PreparedStatement => {
  const now = new Date().toISOString();
  const keepAll = callback.outcome !== 'rejected' && callback.paymentId !== null;
  return db
    .prepare(
      `INSERT INTO callbacks (id, payment_id, body_hash, received_at, last_received_at, outcome, reason, size, body)
       SELECT ?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8
       WHERE ?2 IS NULL
         OR (SELECT COUNT(*) FROM callbacks WHERE payment_id = ?2) < ${MAX_BODIES_PER_PAYMENT}
         OR EXISTS (SELECT 1 FROM callbacks WHERE payment_id = ?2 AND body_hash = ?3)
       ON CONFLICT (payment_id, body_hash) DO UPDATE SET
         deliveries = deliveries + 1,
         last_received_at = excluded.last_received_at`,
    )
    .bind(
      crypto.randomUUID(),
      callback.paymentId,
      callback.bodyHash,
      now,
      callback.outcome,
      callback.reason,
      callback.size,
      keepAll ? callback.body : truncatedBody(callback.body),
    );
};

/**
 * Lists callbacks newest first, a page at a time.
 * @param db - The `DB` database.
 * @param filter - Limit to one outcome, or to those after a cursor.
 * @returns One page, and the cursor of the next one or `null` when this was the last.
 */
export const listCallbacks = async (db: D1Database, filter: { outcome?: CallbackOutcome; before?: Cursor }): Promise<CallbackList> => {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.outcome) {
    where.push('outcome = ?');
    values.push(filter.outcome);
  }
  if (filter.before) {
    where.push('(received_at < ? OR (received_at = ? AND id < ?))');
    values.push(filter.before.time, filter.before.time, filter.before.id);
  }
  // One row more than a page tells whether another page exists.
  const { results } = await db
    .prepare(
      `SELECT ${RECORD_COLUMNS}
       FROM callbacks
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY received_at DESC, id DESC
       LIMIT ${PAGE_SIZE + 1}`,
    )
    .bind(...values)
    .all<RecordRow>();
  const page = results.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    callbacks: page.map(toRecord),
    nextBefore: results.length > PAGE_SIZE && last ? formatCursor({ time: last.received_at, id: last.id }) : null,
  };
};

/**
 * Lists all of one payment's callbacks with their bodies, newest first.
 * @param db - The `DB` database.
 * @param paymentId - The merchantUniquePaymentId.
 * @returns The callbacks.
 */
export const listCallbacksOf = async (db: D1Database, paymentId: string): Promise<CallbackDetail[]> => {
  const { results } = await db
    .prepare(`SELECT ${RECORD_COLUMNS}, body FROM callbacks WHERE payment_id = ? ORDER BY received_at DESC, id DESC`)
    .bind(paymentId)
    .all<DetailRow>();
  return results.map((row) => ({ ...toRecord(row), body: row.body }));
};

/**
 * Reads one callback with its body.
 * @param db - The `DB` database.
 * @param id - The callback's ID.
 * @returns The callback, or `null` when there is none with that ID.
 */
export const getCallback = async (db: D1Database, id: string): Promise<CallbackDetail | null> => {
  const row = await db.prepare(`SELECT ${RECORD_COLUMNS}, body FROM callbacks WHERE id = ?`).bind(id).first<DetailRow>();
  return row ? { ...toRecord(row), body: row.body } : null;
};

/**
 * Deletes callbacks that belong to no payment and whose latest delivery is older than the retention period.
 * Callbacks of a payment go with the payment.
 * @param db - The `DB` database.
 * @param retentionDays - The `RETENTION_DAYS` variable.
 * @returns How many callbacks were deleted.
 */
export const purgeOldOrphanCallbacks = async (db: D1Database, retentionDays: string): Promise<number> => {
  // `INDEXED BY` pins the partial index: without table statistics SQLite prefers the index on `payment_id`, which
  // would read every orphan row to check its time.
  const { meta } = await db
    .prepare('DELETE FROM callbacks INDEXED BY callbacks_orphan_last_received WHERE payment_id IS NULL AND last_received_at < ?')
    .bind(retentionCutoff(retentionDays))
    .run();
  return meta.changes;
};
