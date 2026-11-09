import type { CallbackDetail, CallbackRecord, PaymentDetail, PaymentSummary } from '../../src/shared/types';

/** A payment as the admin list shows it; pass the fields a test cares about. */
export const makePayment = (overrides: Partial<PaymentSummary> = {}): PaymentSummary => ({
  id: 'pay-1',
  mode: 0,
  paymentAmount: 49.9,
  customerName: 'Jane Citizen',
  customerEmail: 'jane@example.com',
  customerReference: 'CUST-1',
  state: 'pending',
  reference: null,
  gatewayStatus: null,
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T09:30:00.000Z',
  callbackCount: 0,
  ...overrides,
});

/** A callback as the admin list shows it. */
export const makeCallback = (overrides: Partial<CallbackRecord> = {}): CallbackRecord => ({
  id: 'cb-1',
  paymentId: 'pay-1',
  receivedAt: '2026-11-09T09:10:00.000Z',
  lastReceivedAt: '2026-11-09T09:10:00.000Z',
  deliveries: 1,
  outcome: 'verified',
  reason: null,
  size: 120,
  ...overrides,
});

/** A callback with its body. */
export const makeCallbackDetail = (overrides: Partial<CallbackDetail> = {}): CallbackDetail => ({
  ...makeCallback(),
  body: '{"validationCode":"abc","response":{"paymentStatus":2}}',
  ...overrides,
});

/** A payment with its callbacks. */
export const makePaymentDetail = (overrides: Partial<PaymentDetail> = {}): PaymentDetail => ({
  ...makePayment(),
  callbacks: [],
  ...overrides,
});

/** An ISO 8601 time this many milliseconds before now, so a test can name a relative age. */
export const isoAgo = (milliseconds: number): string => new Date(Date.now() - milliseconds).toISOString();

/** The address a `fetch` call was made for, as text. */
export const addressOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** A deferred promise, so a test decides when and how a fetch settles. */
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/** Makes a {@link Deferred}. */
export const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
