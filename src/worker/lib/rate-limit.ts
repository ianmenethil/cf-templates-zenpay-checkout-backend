import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';

/**
 * The visitor's IP address as Cloudflare saw it. A request without the header, such as one made under local
 * development, shares one allowance under `unknown`.
 * @param c - The request context.
 * @returns The address, or `unknown`.
 */
export const clientIp = (c: Context<AppEnv>): string => c.req.header('CF-Connecting-IP') ?? 'unknown';

/**
 * Builds a middleware that rate limits the shopper's page by IP address. The caller is a shopper's browser, which
 * has nothing else to tell visitors apart, so each visitor gets one allowance on the binding. Cloudflare advises
 * against IP keys where many people share one address; a shared address here means a shared allowance.
 * @param binding - Which rate limiter to count on.
 * @returns The middleware; it answers `429` once the visitor is over the limit.
 */
export const rateLimitByIp = (binding: 'CHECKOUT_LIMITER' | 'STATUS_LIMITER') =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { success } = await c.env[binding].limit({ key: `${binding}:${clientIp(c)}` });
    if (!success) {
      return c.json({ error: 'Too many requests' }, 429);
    }
    await next();
  });

/**
 * Counts one callback against its payment's allowance, so one payment being flooded cannot block the others.
 * @param env - The Worker's bindings.
 * @param key - The payment ID, or the sender's IP address when the callback address names no payment.
 * @returns `true` while the key is within the limit.
 */
export const withinCallbackLimit = async (env: CloudflareBindings, key: string): Promise<boolean> =>
  (await env.CALLBACK_LIMITER.limit({ key: `CALLBACK_LIMITER:${key}` })).success;
