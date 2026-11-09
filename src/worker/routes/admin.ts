import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import type { AdminProfile, CallbackList, CallbackResponse, PaymentList, PaymentResponse } from '../../shared/types';
import type { AppEnv } from '../env';
import { requireAccess } from '../lib/access';
import { callbacksQuerySchema, paymentsQuerySchema } from '../lib/admin-queries';
import { getCallback, listCallbacks } from '../lib/callbacks';
import { deletePayment, getPayment, listPayments } from '../lib/payments';
import { rejectInvalid } from '../lib/validation';

/**
 * Admin panel, its JSON API and its files, mounted at `/admin` and only reachable through Cloudflare Access.
 * `run_worker_first` in `wrangler.jsonc` sends every `/admin` request here, so the panel's own page
 * and script are behind the same Access check as the API.
 *
 * The two list routes read their query string with `sValidator` and answer `400` with `{ error }` when a parameter is
 * not valid; a parameter they do not know is ignored.
 */
export const admin = new Hono<AppEnv>();

/**
 * Where the panel's page may load scripts from. `vite dev` adds an inline script (React's hot reload). Vite replaces
 * `import.meta.env.DEV` with `false` in a build, so the production Worker allows only the page's own scripts.
 */
const scriptSrc = import.meta.env.DEV ? ["'self'", "'unsafe-inline'"] : ["'self'"];

/** Where the panel's page may load styles from. shadcn's toast (Sonner) and dialog (Radix) add <style> tags and style attributes at runtime. */
const styleSrc = ["'self'", "'unsafe-inline'"];

admin.use(requireAccess);
admin.use(
  secureHeaders({
    // The panel is never shown inside another page, so the older header says so too; the CSP's
    // `frame-ancestors 'none'` below is the modern form of the same rule.
    xFrameOptions: 'DENY',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc,
      styleSrc,
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'none'"],
    },
  }),
);
// The API answers only this panel. It sends no CORS headers, so browsers stop other sites from reading it, and a
// cross-site change that needs a preflight (a JSON body, or DELETE) fails there. csrf() adds a check for the requests
// that need none: it refuses a cross-site change whose content type is a form type, text/plain, or missing.
admin.use('/api/*', csrf());
// Answers hold the signed-in user's data and callback bodies, so no cache keeps a copy.
admin.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

admin.get('/api/me', (c) => c.json<AdminProfile>({ email: c.get('adminEmail'), brand: c.env.BRAND_NAME }));

admin.get('/api/payments', sValidator('query', paymentsQuerySchema, rejectInvalid), async (c) =>
  c.json<PaymentList>(await listPayments(c.env.DB, c.req.valid('query'))),
);

admin.get('/api/payments/:id', async (c) => {
  const payment = await getPayment(c.env.DB, c.req.param('id'));
  return payment ? c.json<PaymentResponse>({ payment }) : c.json({ error: 'Not found' }, 404);
});

admin.delete('/api/payments/:id', async (c) => {
  await deletePayment(c.env.DB, c.req.param('id'));
  return c.body(null, 204);
});

admin.get('/api/callbacks', sValidator('query', callbacksQuerySchema, rejectInvalid), async (c) =>
  c.json<CallbackList>(await listCallbacks(c.env.DB, c.req.valid('query'))),
);

admin.get('/api/callbacks/:id', async (c) => {
  const callback = await getCallback(c.env.DB, c.req.param('id'));
  return callback ? c.json<CallbackResponse>({ callback }) : c.json({ error: 'Not found' }, 404);
});

// An API path that matches nothing above answers JSON, not the panel's page.
admin.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// Everything else under /admin is the React app: its page and bundled files.
admin.get('*', async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status === 404) {
    return c.notFound();
  }
  // Asset responses have immutable headers; a copy lets secureHeaders add its own.
  return new Response(asset.body, asset);
});
