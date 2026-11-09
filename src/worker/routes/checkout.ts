import { sValidator } from '@hono/standard-validator';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { CheckoutLaunch, PaymentStatus } from '../../shared/types';
import type { AppEnv } from '../env';
import { checkoutCors, requireAllowedOrigin } from '../lib/origin';
import { getPaymentStatus, insertPayment } from '../lib/payments';
import { rateLimitByIp } from '../lib/rate-limit';
import { startCheckoutSchema } from '../lib/start-checkout';
import { rejectInvalid } from '../lib/validation';
import { CHECKOUT_SETTINGS, NOT_CONFIGURED_MESSAGE, buildLaunch, requireSettings, toCents } from '../lib/zenpay';

/** Largest request body accepted, in bytes; a checkout request is a few hundred. */
const MAX_BODY_BYTES = 8 * 1024;

/** The merchantUniquePaymentId this Worker makes (`crypto.randomUUID()`). */
const PAYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Answers `404` to an ID that is not shaped like the ones this Worker makes, before the database sees it. A request
 * that fails here can never belong to a payment, so it costs no query.
 */
const wellFormedPaymentId: MiddlewareHandler<AppEnv, '/:merchantUniquePaymentId'> = async (c, next) => {
  if (!PAYMENT_ID_PATTERN.test(c.req.param('merchantUniquePaymentId'))) {
    return c.json({ error: 'Not found' }, 404);
  }
  await next();
};

/**
 * The checkout API the shopper's page calls, mounted at `/api/checkout`. It is public in the sense that shoppers
 * are not signed in, so what protects it is the list of allowed origins, the rate limits and the validation of
 * every request.
 *
 * `POST /` answers, in this order: `403` for an origin that is not allowed, `429` over the rate limit, `413` for a
 * body over 8 KB, `500` while the Worker's settings are wrong, `400` for a body that is not valid JSON (it must be
 * sent with `Content-Type: application/json`) or breaks the rules of `startCheckoutSchema`, `500` when ZenPay's launch
 * rules refuse the Worker's own settings, `400` when they refuse the request, and `200` with the launch.
 * `GET /:merchantUniquePaymentId` answers `200` with the status, `404` for an ID that is unknown or not shaped like
 * the ones this Worker makes, and `429` over the rate limit.
 */
export const checkout = new Hono<AppEnv>();

checkout.use(requireAllowedOrigin, checkoutCors);
// The launch holds a fingerprint and the status is live, so no cache keeps a copy.
checkout.use(async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

checkout.post(
  '/',
  rateLimitByIp('CHECKOUT_LIMITER'),
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Payload too large' }, 413) }),
  requireSettings(CHECKOUT_SETTINGS),
  sValidator('json', startCheckoutSchema, rejectInvalid),
  async (c) => {
    const built = buildLaunch(c.env, c.req.valid('json'), new URL(c.req.url).origin);
    if (!built.ok) {
      if (built.status === 500) {
        console.error(built.detail);
        return c.json({ error: NOT_CONFIGURED_MESSAGE }, 500);
      }
      return c.json({ error: built.error }, built.status);
    }
    const { launch } = built;
    await insertPayment(c.env.DB, {
      id: launch.merchantUniquePaymentId,
      mode: launch.mode,
      amountCents: toCents(launch.paymentAmount),
      customerName: launch.customerName,
      customerEmail: launch.customerEmail,
      customerReference: launch.customerReference,
    });
    return c.json<CheckoutLaunch>(launch);
  },
);

checkout.get('/:merchantUniquePaymentId', wellFormedPaymentId, rateLimitByIp('STATUS_LIMITER'), async (c) => {
  const status = await getPaymentStatus(c.env.DB, c.req.param('merchantUniquePaymentId'));
  return status ? c.json<PaymentStatus>(status) : c.json({ error: 'Not found' }, 404);
});
