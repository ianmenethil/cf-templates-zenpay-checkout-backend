import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import type { CheckoutLaunch, PaymentMode, PaymentState, StartCheckoutRequest } from '../../src/shared/types';
import worker from '../../src/worker/index';
import { ORIGIN } from './constants';
import { FROZEN_CLOCK, SHOP_ORIGIN, type Scenario } from './zenpay-fixtures';

/** A payment row as stored, for checks that go behind the APIs. */
export type PaymentRow = {
  id: string;
  mode: PaymentMode;
  amount_cents: number;
  customer_name: string;
  customer_email: string;
  customer_reference: string;
  state: PaymentState;
  reference: string | null;
  gateway_status: number | null;
  created_at: string;
  updated_at: string;
};

/** A callback row as stored. */
export type CallbackRow = {
  id: string;
  payment_id: string | null;
  body_hash: string;
  received_at: string;
  last_received_at: string;
  deliveries: number;
  outcome: 'verified' | 'unsigned' | 'rejected';
  reason: string | null;
  size: number;
  body: string;
};

/** How a test calls a public route. */
type SendOptions = {
  /** The `Origin` header; `null` sends none. Defaults to the first allowed shop. */
  origin?: string | null;
  /** The visitor's address; each call gets its own unless a test sets one, so tests never share a rate limit. */
  ip?: string;
  /** Settings that replace the test environment's, for a call that must see a different configuration. */
  vars?: Partial<CloudflareBindings>;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
};

/**
 * Makes an address no other call in the test run uses.
 * @returns An IPv4 address in 10.0.0.0/8.
 */
export const randomIp = (): string =>
  `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

/**
 * Calls the Worker the way the shopper's browser or ZenPay does.
 * @param path - Path and query, such as `/api/checkout`.
 * @param options - Method, body, headers, origin, visitor address and replacement settings.
 * @returns The Worker's response.
 */
export const send = (path: string, options: SendOptions = {}): Promise<Response> => {
  const { origin = SHOP_ORIGIN, ip = randomIp(), vars, method = 'GET', headers = {}, body } = options;
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'CF-Connecting-IP': ip, ...(origin === null ? {} : { Origin: origin }), ...headers },
    body,
  });
  // With replacement settings the Worker is called directly, with an environment that has them.
  return vars ? Promise.resolve(worker.fetch(request, { ...env, ...vars }, createExecutionContext())) : exports.default.fetch(request);
};

/**
 * Posts a checkout request as the shopper's page does.
 * @param body - The JSON body; a string is sent as it is, to test malformed bodies.
 * @param options - Origin, visitor address and replacement settings.
 * @returns The Worker's response.
 */
export const postCheckout = (body: unknown, options: SendOptions = {}): Promise<Response> =>
  send('/api/checkout', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/**
 * Asks for a payment's status as the shopper's page does.
 * @param id - The merchantUniquePaymentId.
 * @param options - Origin, visitor address and replacement settings.
 * @returns The Worker's response.
 */
export const getStatus = (id: string, options: SendOptions = {}): Promise<Response> => send(`/api/checkout/${id}`, options);

/**
 * A valid checkout request for a scenario.
 * @param scenario - The mode and amount.
 * @param overrides - Fields that replace the defaults.
 * @returns The request body.
 */
export const requestFor = (scenario: Scenario, overrides: Partial<StartCheckoutRequest> = {}): StartCheckoutRequest => ({
  mode: scenario.mode,
  paymentAmount: scenario.paymentAmount,
  customerName: 'Leah Adria',
  customerEmail: 'leah@example.com',
  customerReference: 'CUST-1001',
  ...overrides,
});

/**
 * Runs a function with the Worker's clock set to a time. Only `Date` is faked. The time stays fixed while `run`
 * runs, and the clock the test had before is put back afterwards.
 * @param time - The time to set.
 * @param run - What to run.
 * @returns What it returned.
 */
export const atTime = async <T>(time: string | number, run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(time));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/**
 * Runs a function while `Date` reads `shiftMs` later than the real clock does, which is what the suite sees on any
 * day after today. Only `Date` is changed, and it is put back afterwards.
 * @param shiftMs - How far ahead of the real clock to set it.
 * @param run - What to run.
 * @returns What it returned.
 */
export const withClockAhead = async <T>(shiftMs: number, run: () => Promise<T>): Promise<T> => {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(value?: number | string | Date) {
      super(value === undefined ? RealDate.now() + shiftMs : value);
    }
    static override now(): number {
      return RealDate.now() + shiftMs;
    }
  } as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
};

/**
 * Starts a checkout whose payment ID and clock are fixed to the scenario's, so the fingerprint it returns is the
 * one the fixture holds and a callback with the fixture's `validationCode` belongs to it. It goes through the real
 * route, so the payment row and the callback address token are the ones the Worker makes.
 * @param scenario - The mode and amount.
 * @param overrides - Request fields that replace the defaults.
 * @returns What the shopper's page would get.
 */
export const startCheckout = async (scenario: Scenario, overrides: Partial<StartCheckoutRequest> = {}): Promise<CheckoutLaunch> => {
  const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(scenario.mupid);
  try {
    const response = await atTime(FROZEN_CLOCK, () => postCheckout(requestFor(scenario, overrides)));
    expect(response.status).toBe(200);
    return await response.json<CheckoutLaunch>();
  } finally {
    randomUuid.mockRestore();
  }
};

/**
 * Builds the body ZenPay posts for a scenario, signed with the fixture's `validationCode`.
 * @param scenario - The mode and reference.
 * @param options - `status` is the `paymentStatus` or `preauthStatus` (3 by default; `null` leaves it out; ignored for
 * Mode 1), `response` replaces fields of `response`, `validationCode` replaces the signature, and `unsigned` leaves it out.
 * @returns The body as an object.
 */
export const callbackBody = (
  scenario: Scenario,
  options: { status?: number | string | null; response?: Record<string, unknown>; validationCode?: string; unsigned?: boolean } = {},
): Record<string, unknown> => {
  const { status = 3, response = {}, validationCode = scenario.validationCode.sha3, unsigned = false } = options;
  const common = { merchantUniquePaymentId: scenario.mupid, merchantCode: 'TestMerchant1' };
  const inner: Record<string, unknown> =
    scenario.mode === 1
      ? { ...common, token: scenario.reference, cardType: 'UnionPay', doRedirect: true }
      : scenario.mode === 3
        ? { ...common, preauthReference: scenario.reference, ...(status === null ? {} : { preauthStatus: status }) }
        : {
            ...common,
            paymentReference: scenario.reference,
            // ZenPay reports the amount it charged; a test removes it with `response: { baseAmount: undefined }`.
            baseAmount: scenario.paymentAmount,
            ...(status === null ? {} : { paymentStatus: status }),
          };
  return { response: { ...inner, ...response }, ...(unsigned ? {} : { validationCode }) };
};

/**
 * Milliseconds after `FROZEN_CLOCK` at which the last callback was posted. Each callback is posted a second after the
 * one before it, so the rows of a test keep their order.
 */
let lastCallbackOffsetMs = 0;

/** How many callbacks are being posted on the timeline at this moment; the clock goes back to the real one when the last finishes. */
let callbacksInFlight = 0;

/**
 * Runs a callback post on the tests' fixed timeline: a second after the previous callback, counted from
 * `FROZEN_CLOCK`. Posts that overlap share the clock, which the last one to finish puts back. A test that already set
 * a time with `atTime` keeps its time.
 * @param run - The post.
 * @returns What it returned.
 */
const onTimeline = async <T>(run: () => Promise<T>): Promise<T> => {
  if (callbacksInFlight === 0) {
    if (vi.isFakeTimers()) {
      return run();
    }
    vi.useFakeTimers({ toFake: ['Date'] });
  }
  callbacksInFlight += 1;
  lastCallbackOffsetMs += 1000;
  vi.setSystemTime(Date.parse(FROZEN_CLOCK) + lastCallbackOffsetMs);
  try {
    return await run();
  } finally {
    callbacksInFlight -= 1;
    if (callbacksInFlight === 0) {
      vi.useRealTimers();
    }
  }
};

/** A callback rate limiter that never refuses, so tests that reuse a fixed payment ID do not count against its allowance. */
const unlimited = { limit: () => Promise.resolve({ success: true }) } as unknown as RateLimit;

/**
 * Posts a callback to a launch's callback address, as ZenPay does. The callback rate limiter is replaced by one
 * that never refuses, because the fixtures reuse payment IDs across tests; pass `limited: true` for the real one.
 *
 * The callback is posted on the same fixed timeline as `startCheckout`, not at the real clock: the address token that
 * `startCheckout` made at `FROZEN_CLOCK` expires 7 days after it, so a callback posted at today's clock would be
 * refused from the eighth day on. A test that already set a time with `atTime` keeps its time.
 * @param callbackUrl - `callbackUrl` of the launch, or any other address.
 * @param body - The body; a string or bytes are sent as they are.
 * @param options - Visitor address, replacement settings, and `limited` to keep the real rate limiter.
 * @returns The Worker's response.
 */
export const postCallback = (callbackUrl: string, body: unknown, options: SendOptions & { limited?: boolean } = {}): Promise<Response> => {
  const url = new URL(callbackUrl);
  const { limited = false, ...sendOptions } = options;
  const post = (): Promise<Response> =>
    send(`${url.pathname}${url.search}`, {
      origin: null,
      ...sendOptions,
      vars: limited ? sendOptions.vars : { CALLBACK_LIMITER: unlimited, ...sendOptions.vars },
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    });
  return onTimeline(post);
};

/**
 * Reads a stored payment straight from the database.
 * @param id - The merchantUniquePaymentId.
 * @returns The row, or `null`.
 */
export const paymentRow = (id: string): Promise<PaymentRow | null> =>
  env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<PaymentRow>();

/**
 * Reads the stored callbacks of a payment straight from the database, oldest first.
 * @param paymentId - The merchantUniquePaymentId, or `null` for the callbacks that belong to no payment.
 * @returns Its rows.
 */
export const callbackRows = async (paymentId: string | null): Promise<CallbackRow[]> =>
  (
    await (
      paymentId === null
        ? env.DB.prepare('SELECT * FROM callbacks WHERE payment_id IS NULL ORDER BY received_at, id')
        : env.DB.prepare('SELECT * FROM callbacks WHERE payment_id = ? ORDER BY received_at, id').bind(paymentId)
    ).all<CallbackRow>()
  ).results;

/** What a test sets on a payment it puts into the database directly. */
export type SeedPayment = {
  id?: string;
  mode?: PaymentMode;
  amountCents?: number;
  customerName?: string;
  customerEmail?: string;
  customerReference?: string;
  state?: PaymentState;
  reference?: string | null;
  gatewayStatus?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Puts payments into the database directly, so a test can choose their IDs, states and times.
 * @param payments - The payments to add.
 * @returns Their IDs.
 */
export const seedPayments = async (payments: SeedPayment[]): Promise<string[]> => {
  const insert = env.DB.prepare(
    `INSERT INTO payments (id, mode, amount_cents, customer_name, customer_email, customer_reference, state, reference, gateway_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids: string[] = [];
  await env.DB.batch(
    payments.map(
      ({
        id = crypto.randomUUID(),
        mode = 0,
        amountCents = 5000,
        customerName = 'Test Customer',
        customerEmail = 'test@example.com',
        customerReference = 'REF-1',
        state = 'pending',
        reference = null,
        gatewayStatus = null,
        createdAt = '2026-02-01T00:00:00.000Z',
        updatedAt = createdAt,
      }) => {
        ids.push(id);
        return insert.bind(
          id,
          mode,
          amountCents,
          customerName,
          customerEmail,
          customerReference,
          state,
          reference,
          gatewayStatus,
          createdAt,
          updatedAt,
        );
      },
    ),
  );
  return ids;
};

/** What a test sets on a callback it puts into the database directly. */
export type SeedCallback = {
  id?: string;
  paymentId?: string | null;
  outcome?: CallbackRow['outcome'];
  reason?: string | null;
  receivedAt?: string;
  lastReceivedAt?: string;
  deliveries?: number;
  body?: string;
};

/**
 * Puts callbacks into the database directly, so a test can choose their IDs, outcomes and times.
 * @param callbacks - The callbacks to add.
 * @returns Their IDs.
 */
export const seedCallbacks = async (callbacks: SeedCallback[]): Promise<string[]> => {
  const insert = env.DB.prepare(
    `INSERT INTO callbacks (id, payment_id, body_hash, received_at, last_received_at, deliveries, outcome, reason, size, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids: string[] = [];
  await env.DB.batch(
    callbacks.map(
      ({
        id = crypto.randomUUID(),
        paymentId = null,
        outcome = 'verified',
        reason = null,
        receivedAt = '2026-02-01T00:00:00.000Z',
        lastReceivedAt = receivedAt,
        deliveries = 1,
        body = '{}',
      }) => {
        ids.push(id);
        // A unique body hash for each row, so seeded rows of one payment never collide.
        return insert.bind(id, paymentId, `seed-${id}`, receivedAt, lastReceivedAt, deliveries, outcome, reason, body.length, body);
      },
    ),
  );
  return ids;
};
