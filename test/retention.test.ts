import { env } from 'cloudflare:workers';
import { createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { serveAccessKeys } from './helpers/access';
import { callbackRows, paymentRow, seedCallbacks, seedPayments } from './helpers/zenpay';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Builds an ISO time some days ago.
 * @param days - How many days back.
 * @returns The time as the Worker writes it.
 */
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

/**
 * Runs the daily clean-up the way the Cron Trigger does.
 * @param vars - Settings and bindings that replace the test environment's, such as a database that fails.
 */
const runScheduled = (vars: Partial<CloudflareBindings> = {}): Promise<void> =>
  worker.scheduled(createScheduledController({ cron: '0 3 * * *' }), { ...env, ...vars });

/**
 * Lists the IDs of the stored payments.
 * @returns The IDs, sorted.
 */
const paymentIds = async (): Promise<string[]> =>
  (await env.DB.prepare('SELECT id FROM payments ORDER BY id').all<{ id: string }>()).results.map((row) => row.id);

/**
 * Wraps the test database so that preparing a statement that holds some text fails, and every other statement runs on
 * the real database.
 * @param failOn - Text in the statement that makes it fail.
 * @returns A database for the Worker's bindings.
 */
const databaseFailingOn = (failOn: string): D1Database =>
  ({
    prepare: (sql: string) => {
      if (sql.includes(failOn)) {
        throw new Error('D1 is down');
      }
      return env.DB.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  }) as unknown as D1Database;

beforeEach(serveAccessKeys);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('daily clean-up', () => {
  it('fails the run when the purge fails, so the cron run is marked failed, and leaves the rows as they were', async () => {
    await seedPayments([{ id: 'expired', createdAt: daysAgo(40) }]);
    const failing = {
      prepare: () => {
        throw new Error('D1 is down');
      },
    } as unknown as D1Database;
    await expect(runScheduled({ DB: failing })).rejects.toThrow('D1 is down');
    expect(await paymentIds()).toEqual(['expired']);
  });

  it('has already deleted the expired payments when the purge of callbacks that belong to no payment fails, and says nothing of success', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedPayments([{ id: 'expired', createdAt: daysAgo(40) }]);
    await seedCallbacks([
      { id: 'expired-callback', paymentId: 'expired', receivedAt: daysAgo(40) },
      { id: 'orphan-expired', paymentId: null, receivedAt: daysAgo(40) },
    ]);
    await expect(runScheduled({ DB: databaseFailingOn('callbacks_orphan_last_received') })).rejects.toThrow('D1 is down');
    // The payment purge ran first and is kept; the run is marked failed, so the next day's run finishes the job.
    expect(await paymentIds()).toEqual([]);
    expect(await callbackRows('expired')).toHaveLength(0);
    expect((await callbackRows(null)).map((row) => row.id)).toEqual(['orphan-expired']);
    expect(logged).not.toHaveBeenCalled();
  });

  it('deletes payments whose state last changed more than 30 days ago, the default of wrangler.jsonc, and keeps the rest', async () => {
    await seedPayments([
      { id: 'expired', createdAt: daysAgo(40), updatedAt: daysAgo(31) },
      { id: 'recent', createdAt: daysAgo(40), updatedAt: daysAgo(29) },
      { id: 'fresh', createdAt: daysAgo(0) },
    ]);
    await runScheduled();
    expect(await paymentIds()).toEqual(['fresh', 'recent']);
  });

  it('keeps an old payment whose state changed recently', async () => {
    await seedPayments([{ id: 'late-callback', createdAt: daysAgo(60), updatedAt: daysAgo(1), state: 'succeeded' }]);
    await runScheduled();
    expect(await paymentRow('late-callback')).not.toBeNull();
  });

  it('deletes the callbacks of an expired payment with it, and keeps the callbacks of a kept one', async () => {
    await seedPayments([
      { id: 'gone', createdAt: daysAgo(50), updatedAt: daysAgo(50) },
      { id: 'kept', createdAt: daysAgo(50), updatedAt: daysAgo(2) },
    ]);
    await seedCallbacks([
      { paymentId: 'gone', receivedAt: daysAgo(50) },
      { paymentId: 'gone', receivedAt: daysAgo(49) },
      // Older than the retention period, but its payment is kept, so it is too.
      { paymentId: 'kept', receivedAt: daysAgo(50) },
    ]);
    await runScheduled();
    expect(await callbackRows('gone')).toHaveLength(0);
    expect(await callbackRows('kept')).toHaveLength(1);
  });

  it('deletes callbacks that belong to no payment once their latest delivery is older than RETENTION_DAYS', async () => {
    await seedCallbacks([
      { id: 'orphan-old', paymentId: null, receivedAt: daysAgo(45), lastReceivedAt: daysAgo(40) },
      { id: 'orphan-recent', paymentId: null, receivedAt: daysAgo(10) },
      { id: 'orphan-retried', paymentId: null, receivedAt: daysAgo(60), lastReceivedAt: daysAgo(1) },
    ]);
    await runScheduled();
    expect((await callbackRows(null)).map((row) => row.id).sort()).toEqual(['orphan-recent', 'orphan-retried']);
  });

  it('uses RETENTION_DAYS from the settings', async () => {
    await seedPayments([
      { id: 'ten-days', createdAt: daysAgo(10) },
      { id: 'two-days', createdAt: daysAgo(2) },
    ]);
    await seedCallbacks([
      { id: 'orphan-ten', paymentId: null, receivedAt: daysAgo(10) },
      { id: 'orphan-two', paymentId: null, receivedAt: daysAgo(2) },
    ]);
    await runScheduled({ RETENTION_DAYS: '7' });
    expect(await paymentIds()).toEqual(['two-days']);
    expect((await callbackRows(null)).map((row) => row.id)).toEqual(['orphan-two']);
  });

  it.each(['abc', '0', '-5', '', '1.5', '1e400'])(
    'falls back to 30 days when RETENTION_DAYS is "%s", never deleting everything',
    async (value) => {
      await seedPayments([
        { id: 'forty', createdAt: daysAgo(40) },
        { id: 'twenty', createdAt: daysAgo(20) },
        { id: 'fresh', createdAt: daysAgo(0) },
      ]);
      await seedCallbacks([
        { id: 'orphan-forty', paymentId: null, receivedAt: daysAgo(40) },
        { id: 'orphan-twenty', paymentId: null, receivedAt: daysAgo(20) },
      ]);
      await runScheduled({ RETENTION_DAYS: value });
      expect(await paymentIds()).toEqual(['fresh', 'twenty']);
      expect((await callbackRows(null)).map((row) => row.id)).toEqual(['orphan-twenty']);
    },
  );

  it('falls back to 30 days when RETENTION_DAYS is not in the configuration at all', async () => {
    await seedPayments([
      { id: 'forty', createdAt: daysAgo(40) },
      { id: 'twenty', createdAt: daysAgo(20) },
    ]);
    await runScheduled({ RETENTION_DAYS: undefined });
    expect(await paymentIds()).toEqual(['twenty']);
  });

  // `new Date(...).toISOString()` throws for a date past the year 275760, which RETENTION_DAYS of 999999999 would
  // reach. A value above 3650 days (10 years) counts as 3650, so the run still works and keeps what is newer.
  it.each(['999999999', '3651', '1e9', '3650'])(
    'clamps a RETENTION_DAYS of "%s" to 3650 days, and the run does not fail',
    async (value) => {
      await seedPayments([
        { id: 'twelve-years', createdAt: daysAgo(4400) },
        { id: 'eight-years', createdAt: daysAgo(2900) },
        { id: 'fresh', createdAt: daysAgo(0) },
      ]);
      await seedCallbacks([
        { id: 'orphan-twelve-years', paymentId: null, receivedAt: daysAgo(4400) },
        { id: 'orphan-eight-years', paymentId: null, receivedAt: daysAgo(2900) },
      ]);
      await runScheduled({ RETENTION_DAYS: value });
      expect(await paymentIds()).toEqual(['eight-years', 'fresh']);
      expect((await callbackRows(null)).map((row) => row.id)).toEqual(['orphan-eight-years']);
    },
  );

  it('logs how many payments and how many callbacks that belonged to no payment it deleted', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedPayments([
      { id: 'expired-1', createdAt: daysAgo(40) },
      { id: 'expired-2', createdAt: daysAgo(41) },
      { id: 'fresh', createdAt: daysAgo(0) },
    ]);
    await seedCallbacks([
      // These go with their payments and are not counted as callbacks that belonged to no payment.
      { paymentId: 'expired-1', receivedAt: daysAgo(40) },
      { paymentId: 'expired-2', receivedAt: daysAgo(41) },
      { paymentId: null, receivedAt: daysAgo(40) },
      { paymentId: null, receivedAt: daysAgo(45) },
      { paymentId: null, receivedAt: daysAgo(50) },
      { paymentId: null, receivedAt: daysAgo(3) },
    ]);
    await runScheduled();
    expect(logged).toHaveBeenCalledExactlyOnceWith('Deleted 2 expired payments and 3 expired callbacks that belonged to no payment.');
  });

  it('deletes nothing and logs two zeros when nothing has expired', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedPayments([{ id: 'fresh', createdAt: daysAgo(1) }]);
    await seedCallbacks([
      { id: 'fresh-callback', paymentId: 'fresh', receivedAt: daysAgo(1) },
      { id: 'fresh-orphan', paymentId: null, receivedAt: daysAgo(1) },
    ]);
    await runScheduled();
    expect(logged).toHaveBeenCalledExactlyOnceWith('Deleted 0 expired payments and 0 expired callbacks that belonged to no payment.');
    expect(await paymentIds()).toEqual(['fresh']);
    expect(await callbackRows('fresh')).toHaveLength(1);
    expect(await callbackRows(null)).toHaveLength(1);
  });
});
