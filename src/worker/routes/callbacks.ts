import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { CallbackReceipt } from '../../shared/types';
import type { AppEnv } from '../env';
import { hashBody, storeCallback } from '../lib/callbacks';
import { findPaymentAmountCents, unverifiedChange, verifiedChange } from '../lib/payments';
import { clientIp, withinCallbackLimit } from '../lib/rate-limit';
import { CALLBACK_SETTINGS, judgeCallback, readCallbackToken, requireSettings } from '../lib/zenpay';

/**
 * Largest callback body accepted, in bytes. The largest ZenPay callback captured in ZenPay's published callback
 * examples is under 4.7 KB (the capture files include test metadata, so the bodies are smaller), which leaves a margin
 * of more than 3 times.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Receives ZenPay's callbacks: `POST /callbacks/zenpay?t=<token>`, mounted at `/callbacks`. It is public on
 * purpose, outside Cloudflare Access, because ZenPay cannot sign in. Only a callback whose address token and
 * `validationCode` both check out changes a payment.
 *
 * It answers:
 * - `200` with `{ received: true }` for every callback it stored or counted, whether it verified or not, so a
 *   sender that resends failures has no reason to resend it;
 * - `413` for a body over 16 KB, which is not stored;
 * - `429` for a callback that does not verify, once its payment (or its sender, when the address names no payment)
 *   has sent more than 60 of them in a minute;
 * - `500` while the Worker's settings are incomplete, or when the database fails, so the failure is visible and a sender that retries can try again once it is fixed (ZenPay's
 *   documentation does not say whether it retries).
 *
 * The body is judged before the rate limit is applied, and only callbacks that do not verify count against it: junk
 * posted to a payment's address cannot make ZenPay's genuine callback answer `429`.
 */
export const callbacks = new Hono<AppEnv>();

callbacks.post(
  '/zenpay',
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Payload too large' }, 413) }),
  requireSettings(CALLBACK_SETTINGS),
  async (c) => {
    const { DB } = c.env;

    // Read once, as bytes. They are hashed as received, then stored and searched as text: `ignoreBOM` keeps a
    // leading byte order mark in the text, and bytes that are not valid UTF-8 become U+FFFD; `size` stays the real length.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const stored = {
      size: raw.byteLength,
      body: new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(raw),
      bodyHash: await hashBody(raw),
    };

    // The token is checked first: it says which payment this is, and which mode to verify against.
    const token = readCallbackToken(c.req.query('t'), c.env.CALLBACK_TOKEN_SECRET);
    let paymentId: string | null = null;
    let verdict: ReturnType<typeof judgeCallback>;
    if (!token.ok) {
      verdict = { outcome: 'rejected', reason: token.reason };
    } else {
      const amountCents = await findPaymentAmountCents(DB, token.launch.merchantUniquePaymentId);
      if (amountCents === null) {
        verdict = { outcome: 'rejected', reason: 'The callback address names a payment that does not exist.' };
      } else {
        paymentId = token.launch.merchantUniquePaymentId;
        verdict = judgeCallback(c.env, token.launch, amountCents, stored.body);
      }
    }

    if (verdict.outcome !== 'verified') {
      const limitKey = token.ok ? token.launch.merchantUniquePaymentId : clientIp(c);
      if (!(await withinCallbackLimit(c.env, limitKey))) {
        return c.json({ error: 'Too many requests' }, 429);
      }
    }

    // The callback row and the payment's change go in together, so a payment never changes without its callback on record.
    // `unsigned` and `verified` verdicts only come from a payment that exists, so `paymentId` is set for them.
    switch (verdict.outcome) {
      case 'rejected':
        await storeCallback(DB, { ...stored, paymentId, outcome: 'rejected', reason: verdict.reason }).run();
        break;
      case 'unsigned':
        await DB.batch([storeCallback(DB, { ...stored, paymentId, outcome: 'unsigned', reason: null }), unverifiedChange(DB, paymentId!)]);
        break;
      case 'verified':
        await DB.batch([
          storeCallback(DB, { ...stored, paymentId, outcome: 'verified', reason: null }),
          verifiedChange(DB, paymentId!, verdict),
        ]);
        break;
    }
    return c.json<CallbackReceipt>({ received: true });
  },
);
