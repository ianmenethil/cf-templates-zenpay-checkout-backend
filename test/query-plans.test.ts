import { env } from 'cloudflare:workers';
import { createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { serveAccessKeys } from './helpers/access';
import { adminApi } from './helpers/admin';
import { SCENARIOS } from './helpers/zenpay-fixtures';
import { callbackBody, getStatus, postCallback, seedCallbacks, seedPayments, startCheckout } from './helpers/zenpay';

/** One row of `EXPLAIN QUERY PLAN`. */
type PlanStep = { detail: string };

/**
 * Runs something and returns the SQL statements the Worker prepared meanwhile.
 * @param run - What to run.
 * @returns The statements, in the order they were prepared.
 */
const sqlDuring = async (run: () => Promise<unknown>): Promise<string[]> => {
  const statements: string[] = [];
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, 'prepare').mockImplementation((sql) => {
    statements.push(sql);
    return prepare(sql);
  });
  await run();
  vi.restoreAllMocks();
  return statements;
};

/**
 * Runs an admin API call that must succeed and returns the SQL statements the Worker prepared for it.
 * @param path - Path below `/admin/api`.
 * @returns The statements.
 */
const sqlOfAdmin = (path: string): Promise<string[]> => sqlDuring(async () => expect((await adminApi(path)).status).toBe(200));

/**
 * Finds the statement that reads from a table in a list of statements.
 * @param statements - What the Worker prepared.
 * @param fragment - Text the statement holds.
 * @returns The statement.
 */
const statementWith = (statements: string[], fragment: string): string => {
  const found = statements.find((sql) => sql.includes(fragment));
  expect(found, `a statement with "${fragment}"`).toBeDefined();
  return found!;
};

/**
 * Counts the parameters of a statement: the highest number of its `?1`, `?2` parameters, or how many plain `?` it holds.
 * @param sql - The statement.
 * @returns How many values it takes.
 */
const parameterCount = (sql: string): number => {
  const numbered = Array.from(sql.matchAll(/\?(\d+)/g), (match) => Number(match[1]));
  return numbered.length > 0 ? Math.max(...numbered) : Array.from(sql.matchAll(/\?/g)).length;
};

/**
 * Reads how SQLite runs a statement exactly as the Worker prepared it. Every parameter gets a text value, which is
 * enough to plan with.
 * @param sql - The statement the Worker prepared.
 * @returns The plan's steps as text.
 */
const planOf = async (sql: string): Promise<string[]> => {
  const values = Array.from({ length: parameterCount(sql) }, () => '2026-01-01T00:00:00.000Z');
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...values)
    .all<PlanStep>();
  return results.map((step) => step.detail);
};

/**
 * Tells whether a plan sorts in a temporary tree.
 * @param plan - The plan's steps.
 * @returns `true` when it does.
 */
const sorts = (plan: string[]): boolean => plan.some((step) => step.includes('TEMP B-TREE'));

/**
 * Tells whether a plan goes through a whole table or index instead of looking rows up by key. A list that is read in
 * index order and stops at its page size starts with such a scan on purpose, so only lookups by key are checked with this.
 * @param plan - The plan's steps.
 * @returns `true` when some step scans: `SCAN t`, or `SCAN t USING INDEX i`, with or without `COVERING`. `SCAN CONSTANT ROW`,
 * the one row of an `INSERT … SELECT` of parameters, reads no table and does not count.
 */
const scans = (plan: string[]): boolean => plan.some((step) => step.startsWith('SCAN ') && !step.startsWith('SCAN CONSTANT ROW'));

beforeEach(serveAccessKeys);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('query plans', () => {
  it('lists all payments from the created index, with no sorting step', async () => {
    await seedPayments([{}]);
    const plan = await planOf(statementWith(await sqlOfAdmin('/payments'), 'FROM payments p'));
    expect(plan.some((step) => step.includes('payments_created'))).toBe(true);
    expect(sorts(plan)).toBe(false);
  });

  it('lists the payments of one state from the state index, with no sorting step', async () => {
    await seedPayments([{}]);
    const plan = await planOf(statementWith(await sqlOfAdmin('/payments?state=pending'), 'FROM payments p'));
    expect(plan.some((step) => step.includes('payments_state_created'))).toBe(true);
    expect(sorts(plan)).toBe(false);
  });

  it('pages payments without sorting', async () => {
    await seedPayments([{}]);
    const plan = await planOf(
      statementWith(await sqlOfAdmin(`/payments?before=${encodeURIComponent('2099-01-01T00:00:00.000Z_x')}`), 'FROM payments p'),
    );
    expect(sorts(plan)).toBe(false);
    expect(plan.some((step) => step.includes('payments_created'))).toBe(true);
  });

  it('adds up each payment’s callbacks from an index that holds the deliveries, never reading the callbacks table', async () => {
    const [id] = await seedPayments([{}]);
    await seedCallbacks([{ paymentId: id }]);
    const plan = await planOf(statementWith(await sqlOfAdmin('/payments'), 'FROM payments p'));
    expect(plan.some((step) => step.includes('SEARCH c USING COVERING INDEX callbacks_payment_received (payment_id=?)'))).toBe(true);
    expect(scans(plan.filter((step) => step.includes(' c ')))).toBe(false);
  });

  it('lists all callbacks from the received index, with no sorting step', async () => {
    await seedCallbacks([{}]);
    const plan = await planOf(statementWith(await sqlOfAdmin('/callbacks'), 'FROM callbacks'));
    expect(plan.some((step) => step.includes('callbacks_received'))).toBe(true);
    expect(sorts(plan)).toBe(false);
  });

  it('lists the callbacks of one outcome from the outcome index, with no sorting step', async () => {
    await seedCallbacks([{}]);
    const plan = await planOf(statementWith(await sqlOfAdmin('/callbacks?outcome=rejected'), 'FROM callbacks'));
    expect(plan.some((step) => step.includes('callbacks_outcome_received'))).toBe(true);
    expect(sorts(plan)).toBe(false);
  });

  it('reads a payment’s callbacks from the payment index, newest first, with no sorting step', async () => {
    const [id] = await seedPayments([{}]);
    await seedCallbacks([{ paymentId: id }]);
    const statements = await sqlOfAdmin(`/payments/${id}`);
    const plan = await planOf(statementWith(statements, 'FROM callbacks WHERE payment_id = ?'));
    expect(plan.some((step) => step.includes('callbacks_payment_received (payment_id=?)'))).toBe(true);
    expect(sorts(plan)).toBe(false);
  });

  it('reads a payment, a callback and a status by key, never scanning a table', async () => {
    const [id] = await seedPayments([{}]);
    const [callbackId] = await seedCallbacks([{ paymentId: id }]);
    const statuses = await sqlDuring(async () => expect((await getStatus(id)).status).toBe(200));
    const reads = [
      statementWith(statuses, 'FROM payments WHERE id = ?'),
      statementWith(await sqlOfAdmin(`/callbacks/${callbackId}`), 'FROM callbacks WHERE id = ?'),
      statementWith(await sqlOfAdmin(`/payments/${id}`), 'FROM payments p WHERE p.id = ?'),
    ];
    for (const sql of reads) {
      expect(scans(await planOf(sql))).toBe(false);
    }
  });

  it('finds the payment a callback belongs to by key when a callback arrives', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const statements = await sqlDuring(async () =>
      expect((await postCallback(launch.callbackUrl, callbackBody(scenario))).status).toBe(200),
    );
    for (const fragment of ['SELECT amount_cents FROM payments WHERE id = ?', 'UPDATE payments SET state']) {
      expect(scans(await planOf(statementWith(statements, fragment)))).toBe(false);
    }
  });

  it('stores a callback with its per-payment limit and repeat check running from the unique index', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const statements = await sqlDuring(async () =>
      expect((await postCallback(launch.callbackUrl, callbackBody(scenario))).status).toBe(200),
    );
    // The statement the Worker prepared, with its count and repeat subqueries, planned as it is.
    const plan = await planOf(statementWith(statements, 'INSERT INTO callbacks'));
    expect(scans(plan)).toBe(false);
    expect(plan.some((step) => step.includes('callbacks_payment_body (payment_id=? AND body_hash=?)'))).toBe(true);
    expect(plan.some((step) => /USING (COVERING )?INDEX callbacks_payment_(body|received) \(payment_id=\?\)/.test(step))).toBe(true);
  });

  it('finds expired payments from the updated index and expired orphan callbacks from the partial index', async () => {
    const statements = await sqlDuring(() => worker.scheduled(createScheduledController({ cron: '0 3 * * *' }), env));
    const payments = await planOf(statementWith(statements, 'DELETE FROM payments'));
    expect(payments.some((step) => step.includes('payments_updated'))).toBe(true);
    const counted = await planOf(statementWith(statements, 'SELECT COUNT(*) AS expired FROM payments'));
    expect(counted.some((step) => step.includes('USING COVERING INDEX payments_updated (updated_at<?)'))).toBe(true);
    const orphans = await planOf(statementWith(statements, 'DELETE FROM callbacks'));
    expect(orphans.some((step) => step.includes('callbacks_orphan_last_received'))).toBe(true);
  });

  it('deletes a payment by key', async () => {
    const [id] = await seedPayments([{}]);
    const statements = await sqlDuring(async () => expect((await adminApi(`/payments/${id}`, { method: 'DELETE' })).status).toBe(204));
    const plan = await planOf(statementWith(statements, 'DELETE FROM payments WHERE id = ?'));
    expect(plan.some((step) => step.includes('SEARCH payments USING INDEX'))).toBe(true);
    expect(scans(plan)).toBe(false);
  });

  // The callbacks go with their payment through the foreign key, which looks them up by `payment_id`. That lookup is made
  // by SQLite inside the delete, so no plan shows it; what makes it cheap is an index that starts with `payment_id`.
  it('lets the foreign key find a deleted payment’s callbacks from an index that starts with payment_id', async () => {
    const { results } = await env.DB.prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'callbacks' AND (type = 'index' OR type = 'table')`,
    ).all<{ type: string; name: string; sql: string | null }>();
    expect(results.find((row) => row.type === 'table')?.sql).toContain('REFERENCES payments (id) ON DELETE CASCADE');
    const leading = results.filter((row) => row.type === 'index' && /\(payment_id[,)]/.test(row.sql ?? ''));
    expect(leading.map((row) => row.name).sort()).toEqual(['callbacks_payment_body', 'callbacks_payment_received']);
  });

  it('keeps a repeated body for a payment unique, so a repeat counts instead of adding a row', async () => {
    const { results } = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'callbacks_payment_body'`).all<{
      sql: string;
    }>();
    expect(results[0]?.sql).toContain('UNIQUE INDEX');
    expect(results[0]?.sql).toContain('(payment_id, body_hash)');
  });
});
