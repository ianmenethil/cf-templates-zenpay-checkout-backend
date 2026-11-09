import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CALLBACK_OUTCOMES, PAYMENT_MODES, PAYMENT_STATES } from '../src/shared/types';

/**
 * Reads the values a column's `CHECK (<column> IN (...))` allows, from the table as the database holds it.
 * @param table - The table's name.
 * @param column - The column's name.
 * @returns The allowed values, as written in the SQL without quotes, in their order.
 */
const allowedValues = async (table: string, column: string): Promise<string[]> => {
  const row = await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(table).first<{ sql: string }>();
  const match = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(row?.sql ?? '');
  expect(match, `a CHECK (${column} IN (...)) on ${table}`).not.toBeNull();
  return (match?.[1] ?? '').split(',').map((value) => value.trim().replaceAll("'", ''));
};

// The lists in src/shared/types.ts and the CHECK constraints in migrations/ are written twice. The constraints come
// from the migration the database was built with, so a value added to one and not the other fails here.
describe('shared types and the migration agree', () => {
  it('on the payment modes', async () => {
    expect(await allowedValues('payments', 'mode')).toEqual(PAYMENT_MODES.map(String));
  });

  it('on the payment states', async () => {
    expect(await allowedValues('payments', 'state')).toEqual([...PAYMENT_STATES]);
  });

  it('on the callback outcomes', async () => {
    expect(await allowedValues('callbacks', 'outcome')).toEqual([...CALLBACK_OUTCOMES]);
  });
});
