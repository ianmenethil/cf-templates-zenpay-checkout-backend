import {
  ZP_PAYMENT_STATUS,
  ZpAuthoriseRequestSchema,
  createZpCallbackUrlToken,
  createZpFingerprint,
  isZpPaymentSuccessful,
  verifyZpCallback,
  verifyZpCallbackUrlToken,
  type ZpVerifyCallbackInput,
} from '@zp-hcp/server';
import { createMiddleware } from 'hono/factory';
import type { CheckoutLaunch, PaymentMode, PaymentState, StartCheckoutRequest } from '../../shared/types';
import type { AppEnv } from '../env';

/**
 * What a public route answers when the Worker's own settings are wrong. The setting names go to the log, not to the
 * caller: the caller is a shopper's browser or ZenPay, and cannot fix them.
 */
export const NOT_CONFIGURED_MESSAGE = 'Not configured';

/** Path of the callback address ZenPay posts to, below this Worker's origin. */
const CALLBACK_PATH = '/callbacks/zenpay';

/** Shortest `CALLBACK_TOKEN_SECRET` the token library accepts, in bytes. */
const MIN_TOKEN_SECRET_BYTES = 32;

/**
 * How long a callback address stays readable. The token only carries launch context (mode, amount, payment ID), and a
 * short life would make a late signed callback unverifiable. Replays are not fully harmless: ZenPay's `validationCode`
 * covers the mode, amount, payment ID and reference but not `paymentStatus` or `preauthStatus`, so anyone holding one
 * signed body and its callback address can repost it with a different status. That is a limit of ZenPay's protocol,
 * which the one-way `succeeded` and `failed` states only narrow; confirm high-value results through ZenPay's API.
 */
const CALLBACK_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** Settings that must be set before a checkout can start. */
export const CHECKOUT_SETTINGS = [
  'ZENPAY_API_KEY',
  'ZENPAY_USERNAME',
  'ZENPAY_PASSWORD',
  'ZENPAY_MERCHANT_CODE',
  'ZENPAY_CHECKOUT_URL',
  'REDIRECT_URL',
  'CALLBACK_TOKEN_SECRET',
] as const;

/** Settings that must be set before a callback can be checked. */
export const CALLBACK_SETTINGS = ['ZENPAY_API_KEY', 'ZENPAY_USERNAME', 'ZENPAY_PASSWORD', 'CALLBACK_TOKEN_SECRET'] as const;

/** A setting this Worker reads from its variables or secrets. */
type Setting = (typeof CHECKOUT_SETTINGS)[number];

/** `paymentStatus` and `preauthStatus` values that end a payment unsuccessfully: Error, Failed, Cancelled, Suppressed. */
const FAILED_STATUSES: readonly number[] = [
  ZP_PAYMENT_STATUS.Error,
  ZP_PAYMENT_STATUS.Failed,
  ZP_PAYMENT_STATUS.Cancelled,
  ZP_PAYMENT_STATUS.Suppressed,
];

/** What `readCallbackToken` hands back: the launch context the token carries. */
type CallbackLaunch = {
  mode: PaymentMode;
  merchantUniquePaymentId: string;
  /** Dollars, as the checkout route put it in the token. */
  paymentAmount: string | number;
};

/** What a callback body amounts to. */
type CallbackVerdict =
  | { outcome: 'verified'; state: PaymentState; reference: string; gatewayStatus: number | null }
  | { outcome: 'unsigned' }
  | { outcome: 'rejected'; reason: string };

/**
 * The result of building a launch: the launch, a `400` with what is wrong with the request, or a `500` with what is
 * wrong with the Worker's settings, which is for the log and not for the caller.
 */
type LaunchResult =
  { ok: true; launch: CheckoutLaunch } | { ok: false; status: 400; error: string } | { ok: false; status: 500; detail: string };

/**
 * Names the settings that are missing, empty, or too weak.
 * @param env - The Worker's bindings.
 * @param names - The settings the route needs.
 * @returns The problems, one per setting; empty when all are fine.
 */
const configProblems = (env: CloudflareBindings, names: readonly Setting[]): string[] =>
  names.flatMap((name) => {
    const value = env[name]?.trim() ?? '';
    if (value === '') {
      return [name];
    }
    // The callback token library refuses a signing secret under 32 bytes.
    if (name === 'CALLBACK_TOKEN_SECRET' && new TextEncoder().encode(env[name]).byteLength < MIN_TOKEN_SECRET_BYTES) {
      return [`${name} (at least ${MIN_TOKEN_SECRET_BYTES} bytes)`];
    }
    return [];
  });

/**
 * Builds a middleware that refuses a request while a setting the route needs is missing, empty or too weak. It answers
 * `500` with a message that names nothing, so the failure is visible to the sender, which may try again once the
 * operator has fixed the settings (ZenPay's documentation does not say whether it retries), and logs which settings are
 * wrong.
 * @param names - The settings the route needs.
 * @returns The middleware.
 */
export const requireSettings = (names: readonly Setting[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const problems = configProblems(c.env, names);
    if (problems.length > 0) {
      console.error(`Not configured: set ${problems.join(', ')}.`);
      return c.json({ error: NOT_CONFIGURED_MESSAGE }, 500);
    }
    await next();
  });

/**
 * Writes a time as ZenPay wants it in the fingerprint: UTC, no milliseconds, no zone.
 * @param date - The time.
 * @returns `YYYY-MM-DDTHH:mm:ss`.
 */
const zenpayTimestamp = (date: Date): string => date.toISOString().slice(0, 19);

/**
 * Converts dollars with at most two decimals to whole cents.
 * @param dollars - The amount.
 * @returns Whole cents.
 */
export const toCents = (dollars: number): number => Math.round(dollars * 100);

/**
 * Makes everything the shopper's page needs to open the ZenPay checkout: a new payment ID, the fingerprint and the
 * signed callback address. It does not store anything.
 * @param env - The Worker's bindings.
 * @param request - The validated request from the shopper's page.
 * @param origin - This Worker's origin, which the callback address is built on.
 * @returns The launch, or what is wrong: `400` for something the request caused, `500` for the Worker's settings.
 */
export const buildLaunch = (env: CloudflareBindings, request: StartCheckoutRequest, origin: string): LaunchResult => {
  const merchantUniquePaymentId = crypto.randomUUID();
  const timestamp = zenpayTimestamp(new Date());

  const fingerprint = createZpFingerprint({
    apiKey: env.ZENPAY_API_KEY,
    username: env.ZENPAY_USERNAME,
    password: env.ZENPAY_PASSWORD,
    mode: request.mode,
    paymentAmount: request.paymentAmount,
    merchantUniquePaymentId,
    timestamp,
  });
  if (!fingerprint.isSuccess || !fingerprint.fingerprint) {
    return { ok: false, status: 500, detail: `Not configured: ${fingerprint.message ?? 'the fingerprint could not be made.'}` };
  }

  const token = createZpCallbackUrlToken(
    { mode: request.mode, merchantUniquePaymentId, timestamp, paymentAmount: request.paymentAmount },
    env.CALLBACK_TOKEN_SECRET,
    { expiresInSeconds: CALLBACK_TOKEN_LIFETIME_SECONDS },
  );
  const callbackUrl = new URL(CALLBACK_PATH, origin);
  callbackUrl.searchParams.set('t', token);

  // `REDIRECT_URL` is a required setting (`CHECKOUT_SETTINGS`): ZenPay's launch rules need a `redirectUrl`, because a
  // launch without one leaves the modal open after the payment.
  const launch: CheckoutLaunch = {
    url: env.ZENPAY_CHECKOUT_URL.trim(),
    apiKey: env.ZENPAY_API_KEY,
    merchantCode: env.ZENPAY_MERCHANT_CODE.trim(),
    fingerprint: fingerprint.fingerprint,
    timestamp,
    merchantUniquePaymentId,
    mode: request.mode,
    paymentAmount: request.paymentAmount,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    customerReference: request.customerReference,
    callbackUrl: callbackUrl.toString(),
    redirectUrl: env.REDIRECT_URL.trim(),
  };

  // ZenPay's own rules for a launch are the last guard before it leaves: a bad address in the settings is the
  // operator's to fix (500), anything else came from the request (400).
  const guard = ZpAuthoriseRequestSchema.safeParse(launch);
  if (!guard.success) {
    const [issue] = guard.error.issues;
    const field = String(issue?.path[0] ?? '');
    const message = issue?.message ?? 'The launch is not valid.';
    return field === 'url' || field === 'redirectUrl'
      ? { ok: false, status: 500, detail: `Not configured: ${field === 'url' ? 'ZENPAY_CHECKOUT_URL' : 'REDIRECT_URL'}. ${message}` }
      : { ok: false, status: 400, error: message };
  }
  return { ok: true, launch };
};

/**
 * Reads the launch context out of a callback address token.
 * @param token - The `t` query value, if there is one.
 * @param secret - `CALLBACK_TOKEN_SECRET`.
 * @returns The launch the token carries, or why it cannot be used.
 */
export const readCallbackToken = (
  token: string | undefined,
  secret: string,
): { ok: true; launch: CallbackLaunch } | { ok: false; reason: string } => {
  if (!token) {
    return { ok: false, reason: 'The callback address has no token.' };
  }
  const result = verifyZpCallbackUrlToken(token, secret);
  if (!result.ok) {
    const why = { malformed: 'not one this Worker made', 'bad-signature': 'not signed with this Worker’s secret', expired: 'expired' };
    return { ok: false, reason: `The callback address token is ${why[result.reason]}.` };
  }
  const { mode, merchantUniquePaymentId, paymentAmount } = result.payload;
  if (paymentAmount === undefined) {
    return { ok: false, reason: 'The callback address token carries no amount.' };
  }
  return { ok: true, launch: { mode, merchantUniquePaymentId, paymentAmount } };
};

/**
 * Turns ZenPay's numeric status into a payment state.
 * @param status - `paymentStatus` or `preauthStatus` from a verified callback; anything but a number counts as missing.
 * @returns `succeeded` for 3 only, `failed` for 1, 4, 5 and 6, and `processing` for the rest (0 Pending, 7 InProgress, missing).
 */
const stateOfStatus = (status: unknown): PaymentState => {
  if (typeof status !== 'number') {
    return 'processing';
  }
  if (isZpPaymentSuccessful(status)) {
    return 'succeeded';
  }
  return FAILED_STATUSES.includes(status) ? 'failed' : 'processing';
};

/**
 * Tells whether a value is a JSON object.
 * @param value - Anything.
 * @returns `true` for a non-null, non-array object.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decides what a callback body amounts to, using the mode and amount from the callback address token.
 * A body that names a different payment is rejected before anything else, signed or not. The `validationCode` is
 * then looked for on the raw JSON, because the package's schemas require it: an unsigned notification would
 * otherwise fail to parse and look like a bad signature.
 *
 * ZenPay hashes a Custom Payment's amount as `0`, so for mode 2 the `validationCode` does not bind the amount and a
 * shopper can change it in the browser before the plugin opens. A verified mode 2 callback is therefore accepted
 * only when the amount it reports charged (`response.baseAmount`) equals the amount the payment started with.
 * @param env - The Worker's bindings.
 * @param launch - What the callback address token carries.
 * @param amountCents - The amount the payment started with, in whole cents.
 * @param text - The body as received.
 * @returns `verified` with the payment's new state, `unsigned` for a notification only, or `rejected` with the reason.
 */
export const judgeCallback = (env: CloudflareBindings, launch: CallbackLaunch, amountCents: number, text: string): CallbackVerdict => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { outcome: 'rejected', reason: 'The body is not JSON.' };
  }
  if (!isRecord(body)) {
    return { outcome: 'rejected', reason: 'The body is not a JSON object.' };
  }

  const response = isRecord(body.response) ? body.response : {};
  if (response.merchantUniquePaymentId !== undefined && response.merchantUniquePaymentId !== launch.merchantUniquePaymentId) {
    return { outcome: 'rejected', reason: 'merchantUniquePaymentId does not match the callback address.' };
  }

  const code = body.validationCode;
  if (code === undefined || code === null) {
    return { outcome: 'unsigned' };
  }
  if (typeof code !== 'string') {
    return { outcome: 'rejected', reason: 'validationCode is not text.' };
  }

  // The package checks the body's shape itself, so the body goes in as parsed.
  const result = verifyZpCallback({ mode: launch.mode, body } as unknown as ZpVerifyCallbackInput, {
    apiKey: env.ZENPAY_API_KEY,
    username: env.ZENPAY_USERNAME,
    password: env.ZENPAY_PASSWORD,
    paymentAmount: launch.paymentAmount,
    merchantUniquePaymentId: launch.merchantUniquePaymentId,
  });
  if (!result.isValid) {
    return { outcome: 'rejected', reason: result.message ?? 'The callback did not verify.' };
  }

  if (launch.mode === 2) {
    const charged = response.baseAmount;
    if (typeof charged !== 'number') {
      return {
        outcome: 'rejected',
        reason: 'The callback has no baseAmount, so the amount charged cannot be checked against the launch amount.',
      };
    }
    if (Math.round(charged * 100) !== amountCents) {
      return { outcome: 'rejected', reason: 'The amount charged (baseAmount) differs from the launch amount.' };
    }
  }

  // Tokenise returns a token, not a payment: a verified one means the payment method was saved.
  if (launch.mode === 1) {
    return { outcome: 'verified', state: 'succeeded', reference: String(response.token), gatewayStatus: null };
  }
  const preauth = launch.mode === 3;
  const status = response[preauth ? 'preauthStatus' : 'paymentStatus'];
  return {
    outcome: 'verified',
    state: stateOfStatus(status),
    reference: String(response[preauth ? 'preauthReference' : 'paymentReference']),
    gatewayStatus: typeof status === 'number' ? status : null,
  };
};
