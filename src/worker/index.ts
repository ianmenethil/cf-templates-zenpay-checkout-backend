import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env';
import { purgeOldOrphanCallbacks } from './lib/callbacks';
import { purgeOldPayments } from './lib/payments';
import { admin } from './routes/admin';
import { callbacks } from './routes/callbacks';
import { checkout } from './routes/checkout';

/** The Worker's HTTP routes: the checkout API, ZenPay's callbacks and the admin panel, with one JSON shape for every error. */
const app = new Hono<AppEnv>();

// The bare address opens the admin panel, so the URL a dev server or a new domain shows leads somewhere.
app.get('/', (c) => c.redirect('/admin/'));
app.route('/api/checkout', checkout);
app.route('/callbacks', callbacks);
app.route('/admin', admin);

// Every error answer is `{ error }`, so the shopper's page, ZenPay and the admin panel read one shape: the routes
// answer it themselves, and the errors Hono throws (a refused cross-site request) are turned into it here.
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError(async (error, c) => {
  if (error instanceof HTTPException) {
    // `csrf()` throws with a ready-made response and no message; its body is the status text.
    return c.json({ error: error.message || (await error.res?.text()) || 'Error' }, error.status);
  }
  console.error(error);
  return c.json({ error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch,
  /**
   * Runs on the daily Cron Trigger in `wrangler.jsonc`: deletes payments and callbacks older than `RETENTION_DAYS`.
   * @param _controller - The Cron Trigger event; not read.
   * @param env - The Worker's bindings.
   * @returns Resolves once both deletions are done; rejects when either fails, which marks the cron run failed.
   */
  async scheduled(_controller, env) {
    // Awaited, not handed to `ctx.waitUntil`, so a failed purge fails the cron run instead of vanishing.
    const payments = await purgeOldPayments(env.DB, env.RETENTION_DAYS);
    const orphans = await purgeOldOrphanCallbacks(env.DB, env.RETENTION_DAYS);
    console.log(`Deleted ${payments} expired payments and ${orphans} expired callbacks that belonged to no payment.`);
  },
} satisfies ExportedHandler<CloudflareBindings>;
