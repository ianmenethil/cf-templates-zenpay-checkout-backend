import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach } from 'vitest';

// The tests run against the same tables as a deployment: migrations/ is applied to the test database.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// The ZenPay fixtures fix each payment's ID, so every test starts with empty tables.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM callbacks'), env.DB.prepare('DELETE FROM payments')]);
});
