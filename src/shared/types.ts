/**
 * Types shared by the Worker, the shopper's page and the admin panel: the requests and answers of
 * the checkout API and the admin API.
 */

/** ZenPay plugin modes: 0 Make Payment, 1 Tokenise, 2 Custom Payment, 3 Preauthorisation. */
export const PAYMENT_MODES = [0, 1, 2, 3] as const;

/** A ZenPay plugin mode. */
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * Where a payment stands, as far as this Worker can prove.
 * - `pending`: started, no callback yet.
 * - `unverified`: only callbacks without a `validationCode` arrived; they cannot be trusted, so nothing is fulfilled.
 * - `processing`: a verified callback says ZenPay is still working on it (status Pending or InProgress).
 * - `succeeded`: a verified callback says it succeeded (for Tokenise: the payment method was saved).
 * - `failed`: a verified callback says it failed, errored, was cancelled or was suppressed.
 *
 * `succeeded` and `failed` are final: no later callback changes them.
 */
export const PAYMENT_STATES = ['pending', 'unverified', 'processing', 'succeeded', 'failed'] as const;

/** Where a payment stands. */
export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * What the Worker made of one callback POST.
 * - `verified`: the callback URL token and the `validationCode` both check out.
 * - `unsigned`: the token checks out but the body has no `validationCode`; a notification only.
 * - `rejected`: the callback is stored but changes nothing. The cause is one of: the callback address token is missing,
 *   changed or expired; the token names a payment that does not exist; the body is not JSON or not a JSON object; the
 *   body's `merchantUniquePaymentId` differs from the token's; the `validationCode` is not text or does not match; or,
 *   for Custom Payment (mode 2), `response.baseAmount` is missing or differs from the amount the payment started with.
 *   `CallbackRecord.reason` says which.
 */
export const CALLBACK_OUTCOMES = ['verified', 'unsigned', 'rejected'] as const;

/** What the Worker made of one callback POST. */
export type CallbackOutcome = (typeof CALLBACK_OUTCOMES)[number];

/**
 * Body of `POST /api/checkout`, sent by the shopper's page when the Pay button is pressed, as `application/json`.
 * A field that is not listed here is ignored. Every field below must be present; the text fields are trimmed, then checked.
 */
export type StartCheckoutRequest = {
  mode: PaymentMode;
  /**
   * Amount in dollars as a number with at most 2 decimals and at most 10,000,000, for example `49.9`. It must be above 0
   * for modes 0, 2 and 3; mode 1 accepts 0.
   */
  paymentAmount: number;
  /** The customer's name: at most 100 characters, no control characters. It may be empty for modes 1 and 3, not for 0 and 2. */
  customerName: string;
  /** The customer's email address: at most 254 characters, one `@`, no spaces, a dot in the domain, no control characters. Required for every mode. */
  customerEmail: string;
  /** The merchant's own reference for the customer: at most 100 characters, no control characters. It may be empty for modes 1 and 3, not for 0 and 2. */
  customerReference: string;
};

/**
 * Answer of `POST /api/checkout`: the signed options the shopper's page passes to `zpPayment(...)`.
 * The ZenPay username and password are used only inside the fingerprint and never appear here.
 */
export type CheckoutLaunch = {
  /** The ZenPay hosted checkout address. */
  url: string;
  apiKey: string;
  merchantCode: string;
  /** SHA3-512 fingerprint, 128 hex characters. Valid for 15 minutes from `timestamp`. */
  fingerprint: string;
  /** UTC time the fingerprint was made, `YYYY-MM-DDTHH:mm:ss`. */
  timestamp: string;
  /** This payment attempt's ID, new for every attempt. The shopper's page uses it to ask for the status. */
  merchantUniquePaymentId: string;
  mode: PaymentMode;
  paymentAmount: number;
  customerName: string;
  customerEmail: string;
  customerReference: string;
  /** Where ZenPay posts the result: this Worker's callback address with a signed `t` token. */
  callbackUrl: string;
  /** Where ZenPay sends the shopper's browser after payment: `REDIRECT_URL`. ZenPay's launch rules require it, so the modal closes. */
  redirectUrl: string;
};

/** Answer of `GET /api/checkout/:merchantUniquePaymentId`, polled by the shopper's page. */
export type PaymentStatus = {
  merchantUniquePaymentId: string;
  state: PaymentState;
  /**
   * ZenPay's payment reference or preauth reference from the verified callback. `null` until verified, and always `null`
   * for Tokenise (mode 1), whose reference is the saved payment method's token: the admin API shows it, this route does not.
   */
  reference: string | null;
};

/** A payment attempt as the admin list shows it. */
export type PaymentSummary = {
  /** The `merchantUniquePaymentId`; also used in admin API paths. */
  id: string;
  mode: PaymentMode;
  /** The launch amount in dollars, for example `49.9`. */
  paymentAmount: number;
  customerName: string;
  customerEmail: string;
  customerReference: string;
  state: PaymentState;
  /** ZenPay's reference from the verified callback, or `null`. */
  reference: string | null;
  /** ZenPay's numeric status from the latest verified callback (`paymentStatus` or `preauthStatus`), or `null`. */
  gatewayStatus: number | null;
  /** ISO 8601 time the payment was started. */
  createdAt: string;
  /** ISO 8601 time its state last changed. */
  updatedAt: string;
  /** How many callback POSTs reached it: the sum of the `deliveries` of its stored callbacks, so a repeated body counts each time. */
  callbackCount: number;
};

/** One stored callback POST. A repeat of the same body for the same payment adds to `deliveries` instead of a new row. */
export type CallbackRecord = {
  /** Identifier used in admin API paths. */
  id: string;
  /** The payment it belongs to, or `null` when its callback URL token could not be read or names a payment that does not exist. */
  paymentId: string | null;
  /** ISO 8601 time of the first delivery. */
  receivedAt: string;
  /** ISO 8601 time of the latest delivery of the same body. */
  lastReceivedAt: string;
  deliveries: number;
  outcome: CallbackOutcome;
  /** Why it was rejected, or `null` when it was not. */
  reason: string | null;
  /** Size in bytes of the body as received, even when the stored body is cut short. */
  size: number;
};

/** A stored callback with its body. */
export type CallbackDetail = CallbackRecord & {
  /** The body as received, as text; only the first 4096 bytes for a rejected callback or one with no payment (`size` is the full length). */
  body: string;
};

/** A payment with all its callbacks, newest first. */
export type PaymentDetail = PaymentSummary & { callbacks: CallbackDetail[] };

/** Answer of `GET /admin/api/me`. */
export type AdminProfile = { email: string; brand: string };

/**
 * Answer of `GET /admin/api/payments?state=<state>&q=<text>&before=<cursor>`, newest first.
 * `q` matches the payment ID, customer name, email or reference, or ZenPay's reference.
 * Pass `nextBefore` as `before` for the next page; `null` means no more.
 */
export type PaymentList = { payments: PaymentSummary[]; nextBefore: string | null };

/** Answer of `GET /admin/api/payments/:id`. */
export type PaymentResponse = { payment: PaymentDetail };

/** Answer of `GET /admin/api/callbacks?outcome=<outcome>&before=<cursor>`, newest first, every payment's callbacks plus those that belong to no payment (no readable token, or a payment that does not exist). */
export type CallbackList = { callbacks: CallbackRecord[]; nextBefore: string | null };

/** Answer of `GET /admin/api/callbacks/:id`. */
export type CallbackResponse = { callback: CallbackDetail };

/** Answer of a `POST /callbacks/zenpay` that was accepted, signed or not; only verified ones change the payment. */
export type CallbackReceipt = { received: true };
