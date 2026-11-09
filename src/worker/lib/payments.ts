import {
  type PaymentDetail,
  type PaymentList,
  type PaymentMode,
  type PaymentState,
  type PaymentStatus,
  type PaymentSummary,
} from '../../shared/types';
import { listCallbacksOf } from './callbacks';
import { PAGE_SIZE, formatCursor, type Cursor } from './cursor';
import { retentionCutoff } from './retention';

/**
 * Columns of a payment list row. `callback_count` adds up the deliveries of the payment's callbacks from
 * `callbacks_payment_received`, which holds `deliveries`, so no callback row is read.
 */
const SUMMARY_COLUMNS = `p.id, p.mode, p.amount_cents, p.customer_name, p.customer_email, p.customer_reference,
  p.state, p.reference, p.gateway_status, p.created_at, p.updated_at,
  (SELECT COALESCE(SUM(c.deliveries), 0) FROM callbacks c WHERE c.payment_id = p.id) AS callback_count`;

/** A payment list row as `SUMMARY_COLUMNS` reads it from the database. */
type SummaryRow = {
  id: string;
  mode: PaymentMode;
  amount_cents: number;
  customer_name: string;
  customer_email: string;
  customer_reference: string;
  state: PaymentState;
  reference: string | null;
  gateway_status: number | null;
  created_at: string;
  updated_at: string;
  callback_count: number;
};

/** What the checkout route stores when a payment starts. */
type NewPayment = {
  id: string;
  mode: PaymentMode;
  amountCents: number;
  customerName: string;
  customerEmail: string;
  customerReference: string;
};

/** What a verified callback changes on a payment. */
type VerifiedChange = { state: PaymentState; reference: string; gatewayStatus: number | null };

/** Filters of the payment list. `q` is already cut to the longest search text the admin API accepts. */
type PaymentFilter = { state?: PaymentState; q?: string; before?: Cursor };

/**
 * Turns a database row into what the admin API returns.
 * @param row - A payment row with its callback count.
 * @returns The payment summary.
 */
const toSummary = (row: SummaryRow): PaymentSummary => ({
  id: row.id,
  mode: row.mode,
  paymentAmount: row.amount_cents / 100,
  customerName: row.customer_name,
  customerEmail: row.customer_email,
  customerReference: row.customer_reference,
  state: row.state,
  reference: row.reference,
  gatewayStatus: row.gateway_status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  callbackCount: row.callback_count,
});

/**
 * Stores a payment that has just started, in state `pending`.
 * @param db - The `DB` database.
 * @param payment - The attempt's launch values.
 */
export const insertPayment = async (db: D1Database, payment: NewPayment): Promise<void> => {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO payments (id, mode, amount_cents, customer_name, customer_email, customer_reference, state, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)`,
    )
    .bind(payment.id, payment.mode, payment.amountCents, payment.customerName, payment.customerEmail, payment.customerReference, now)
    .run();
};

/**
 * Reads the amount a payment started with, which also tells whether the payment exists.
 * @param db - The `DB` database.
 * @param id - The merchantUniquePaymentId.
 * @returns The amount in whole cents, or `null` when there is no payment with that ID.
 */
export const findPaymentAmountCents = async (db: D1Database, id: string): Promise<number | null> =>
  (await db.prepare('SELECT amount_cents FROM payments WHERE id = ?').bind(id).first<{ amount_cents: number }>())?.amount_cents ?? null;

/**
 * Reads what the shopper's page may know about a payment. For Tokenise (mode 1) the reference is the saved payment
 * method's token, which the public status route does not hand out, so it is `null` there; the admin API keeps it.
 * @param db - The `DB` database.
 * @param id - The merchantUniquePaymentId.
 * @returns Its state and ZenPay's reference, or `null` when there is none with that ID.
 */
export const getPaymentStatus = async (db: D1Database, id: string): Promise<PaymentStatus | null> => {
  const row = await db
    .prepare('SELECT id, mode, state, reference FROM payments WHERE id = ?')
    .bind(id)
    .first<{ id: string; mode: PaymentMode; state: PaymentState; reference: string | null }>();
  return row ? { merchantUniquePaymentId: row.id, state: row.state, reference: row.mode === 1 ? null : row.reference } : null;
};

/**
 * Builds the statement that applies a verified callback. `succeeded` and `failed` are final, so the
 * statement leaves a payment in either state exactly as it is. The check and the change are one `UPDATE`,
 * so two callbacks arriving together cannot overwrite each other's final state.
 * @param db - The `DB` database.
 * @param id - The merchantUniquePaymentId.
 * @param change - The state, ZenPay's reference and status from the verified callback.
 * @returns The statement, to run in a batch with the callback's own row.
 */
export const verifiedChange = (db: D1Database, id: string, change: VerifiedChange): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE payments SET state = ?2, reference = ?3, gateway_status = ?4, updated_at = ?5
       WHERE id = ?1 AND state NOT IN ('succeeded', 'failed')`,
    )
    .bind(id, change.state, change.reference, change.gatewayStatus, new Date().toISOString());

/**
 * Builds the statement that notes an unsigned callback arrived. Only a payment still `pending` moves, to
 * `unverified`: an unsigned callback proves nothing, so it never changes anything else.
 * @param db - The `DB` database.
 * @param id - The merchantUniquePaymentId.
 * @returns The statement, to run in a batch with the callback's own row.
 */
export const unverifiedChange = (db: D1Database, id: string): D1PreparedStatement =>
  db
    .prepare(`UPDATE payments SET state = 'unverified', updated_at = ?2 WHERE id = ?1 AND state = 'pending'`)
    .bind(id, new Date().toISOString());

/**
 * Lists payments newest first, a page at a time.
 * @param db - The `DB` database.
 * @param filter - Limit to one state, to payments matching `q`, or to those after a cursor.
 * @returns One page, and the cursor of the next one or `null` when this was the last.
 */
export const listPayments = async (db: D1Database, filter: PaymentFilter): Promise<PaymentList> => {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (filter.state) {
    where.push('p.state = ?');
    values.push(filter.state);
  }
  if (filter.q) {
    // `instr` finds the text itself, with no wildcards to escape, and D1 does not limit its argument as it
    // limits a `LIKE` pattern (50 bytes). `lower` makes it ignore case for ASCII letters, as `LIKE` does.
    const text = filter.q;
    where.push(
      `(instr(lower(p.id), lower(?)) > 0 OR instr(lower(p.customer_name), lower(?)) > 0
        OR instr(lower(p.customer_email), lower(?)) > 0 OR instr(lower(p.customer_reference), lower(?)) > 0
        OR instr(lower(p.reference), lower(?)) > 0)`,
    );
    values.push(text, text, text, text, text);
  }
  if (filter.before) {
    where.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
    values.push(filter.before.time, filter.before.time, filter.before.id);
  }
  // One row more than a page tells whether another page exists.
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}
       FROM payments p
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${PAGE_SIZE + 1}`,
    )
    .bind(...values)
    .all<SummaryRow>();
  const page = results.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    payments: page.map(toSummary),
    nextBefore: results.length > PAGE_SIZE && last ? formatCursor({ time: last.created_at, id: last.id }) : null,
  };
};

/**
 * Reads one payment with all its callbacks.
 * @param db - The `DB` database.
 * @param id - The merchantUniquePaymentId.
 * @returns The payment, or `null` when there is none with that ID.
 */
export const getPayment = async (db: D1Database, id: string): Promise<PaymentDetail | null> => {
  const row = await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM payments p WHERE p.id = ?`).bind(id).first<SummaryRow>();
  return row ? { ...toSummary(row), callbacks: await listCallbacksOf(db, id) } : null;
};

/**
 * Deletes one payment and, through the foreign key, its callbacks.
 * @param db - The `DB` database.
 * @param id - The merchantUniquePaymentId. Deleting one that does not exist does nothing.
 */
export const deletePayment = async (db: D1Database, id: string): Promise<void> => {
  await db.prepare('DELETE FROM payments WHERE id = ?').bind(id).run();
};

/**
 * Deletes payments whose state last changed before the retention period, with their callbacks.
 * @param db - The `DB` database.
 * @param retentionDays - The `RETENTION_DAYS` variable.
 * @returns How many payments were deleted. Their callbacks are not counted.
 */
export const purgeOldPayments = async (db: D1Database, retentionDays: string): Promise<number> => {
  const cutoff = retentionCutoff(retentionDays);
  // D1's `meta.changes` of the delete adds the callbacks removed with the payments, so the payments are counted by a
  // query of their own, in the same batch and so the same transaction.
  const [counted] = await db.batch<{ expired: number }>([
    db.prepare('SELECT COUNT(*) AS expired FROM payments WHERE updated_at < ?').bind(cutoff),
    db.prepare('DELETE FROM payments WHERE updated_at < ?').bind(cutoff),
  ]);
  return counted.results[0]?.expired ?? 0;
};
