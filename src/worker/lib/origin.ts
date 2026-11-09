import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { NOT_CONFIGURED_MESSAGE } from './zenpay';

/**
 * Reads `ALLOWED_ORIGINS`: origins separated by commas, with no path. An entry that is a URL is reduced to its origin:
 * the scheme and host in lower case, the port unless it is the scheme's default, and no path. An entry that is not a
 * URL is kept as written, so it matches only an `Origin` header with exactly that text.
 * @param value - The variable.
 * @returns The origins; empty when the variable holds no entry.
 */
const parseAllowedOrigins = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return entry;
      }
    });

/**
 * Lets a request through only from a website listed in `ALLOWED_ORIGINS`. Until the variable is set, every request
 * is refused. A browser always sends `Origin` on a request from another site, so a request without it (or from an
 * origin not listed) is refused too. This keeps other sites' pages from using the checkout; it is not a login, since
 * anything outside a browser can send any `Origin`.
 */
export const requireAllowedOrigin = createMiddleware<AppEnv>(async (c, next) => {
  // A variable that was left out of the configuration reads as undefined, which counts as not set.
  const allowed = parseAllowedOrigins(c.env.ALLOWED_ORIGINS ?? '');
  if (allowed.length === 0) {
    console.error('Not configured: set ALLOWED_ORIGINS.');
    return c.json({ error: NOT_CONFIGURED_MESSAGE }, 403);
  }
  const origin = c.req.header('Origin');
  if (!origin || !allowed.includes(origin)) {
    return c.json({ error: 'Origin not allowed' }, 403);
  }
  await next();
});

/**
 * Answers the browser's CORS preflight and adds the CORS headers for an allowed origin. It runs after
 * `requireAllowedOrigin`, so only an allowed origin ever reaches it.
 */
export const checkoutCors = cors({
  origin: (origin, c) => (parseAllowedOrigins((c.env as CloudflareBindings).ALLOWED_ORIGINS ?? '').includes(origin) ? origin : null),
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 600,
});
