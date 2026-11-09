import { env, exports } from 'cloudflare:workers';
import { createZpCallbackUrlToken } from '@zp-hcp/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallbackReceipt, PaymentMode } from '../src/shared/types';
import { ORIGIN } from './helpers/constants';
import { CALLBACK_TOKEN_SECRET, FROZEN_CLOCK, FROZEN_TIMESTAMP, SCENARIOS, TOKENISE_WITH_AMOUNT } from './helpers/zenpay-fixtures';
import {
  atTime,
  callbackBody,
  callbackRows,
  paymentRow,
  postCallback,
  postCheckout,
  randomIp,
  requestFor,
  send,
  startCheckout,
  withClockAhead,
} from './helpers/zenpay';

const MODES: PaymentMode[] = [0, 1, 2, 3];
const DAY = 24 * 60 * 60 * 1000;
const CALLBACK_PATH = `${ORIGIN}/callbacks/zenpay`;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Changes the last character of a hex string, keeping it hex.
 * @param hex - The hex text.
 * @returns A different hex text of the same length.
 */
const wrongHex = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;

/**
 * Hashes a body as the Worker hashes it.
 * @param body - The body as received.
 * @returns SHA-256 in lower-case hex.
 */
const sha256 = async (body: string | Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', typeof body === 'string' ? new TextEncoder().encode(body) : body)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

/**
 * Counts the stored callbacks of every payment and of none.
 * @returns How many rows there are.
 */
const countCallbacks = async (): Promise<number> =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM callbacks').first<{ n: number }>())?.n ?? 0;

/**
 * Replaces one character of a callback address token.
 * @param callbackUrl - The launch's callback address.
 * @param index - Where in the token to change a character; negative counts from the end.
 * @returns The address with the changed token.
 */
const withChangedToken = (callbackUrl: string, index: number): string => {
  const url = new URL(callbackUrl);
  const token = url.searchParams.get('t') ?? '';
  const at = index < 0 ? token.length + index : index;
  url.searchParams.set('t', `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`);
  return url.toString();
};

describe('POST /callbacks/zenpay: verified callbacks', () => {
  it.each(MODES)('marks a mode %i payment succeeded on a callback whose validationCode matches the fixture', async (mode) => {
    const scenario = SCENARIOS[mode];
    const launch = await startCheckout(scenario);
    const response = await postCallback(launch.callbackUrl, callbackBody(scenario));
    expect(response.status).toBe(200);
    expect(await response.json<CallbackReceipt>()).toEqual({ received: true });
    expect(await paymentRow(scenario.mupid)).toMatchObject({
      state: 'succeeded',
      reference: scenario.reference,
      gateway_status: mode === 1 ? null : 3,
    });
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ outcome: 'verified', reason: null, deliveries: 1 }]);
  });

  it('verifies a mode 1 callback launched with an amount above 0 against a code hashed in whole cents', async () => {
    const scenario = TOKENISE_WITH_AMOUNT;
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'succeeded', reference: 'TOK-1002', gateway_status: null });
  });

  it('stores the body exactly as received, with its size in bytes', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const text = JSON.stringify(callbackBody(scenario, { response: { customerName: 'Zoë Ünal' } }), null, 2);
    await postCallback(launch.callbackUrl, text);
    const [row] = await callbackRows(scenario.mupid);
    expect(row?.body).toBe(text);
    expect(row?.size).toBe(new TextEncoder().encode(text).byteLength);
    expect(row?.size).toBeGreaterThan(text.length);
  });

  it('ignores an amount sent in the body: the validationCode is checked against the amount in the callback address', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const body = callbackBody(scenario, { response: { baseAmount: 1, processedAmount: 1 } });
    await postCallback(launch.callbackUrl, body);
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });

  it('checks the validationCode against the amount in the callback address, not the stored one', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    // The stored amount differs from the one in the address; a mode 0 code binds the address's amount only.
    await env.DB.prepare('UPDATE payments SET amount_cents = 99 WHERE id = ?').bind(scenario.mupid).run();
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });

  describe('state from ZenPay’s status', () => {
    // 3 Successful; 1 Error, 4 Failed, 5 Cancelled, 6 Suppressed; 0 Pending, 7 InProgress; 2 is a code ZenPay does not
    // define, and null leaves the status out.
    it.each([
      [3, 'succeeded'],
      [1, 'failed'],
      [4, 'failed'],
      [5, 'failed'],
      [6, 'failed'],
      [0, 'processing'],
      [7, 'processing'],
      [2, 'processing'],
      [null, 'processing'],
    ])('mode 0 with paymentStatus %s is %s', async (status, state) => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status }));
      expect(await paymentRow(scenario.mupid)).toMatchObject({
        state,
        reference: scenario.reference,
        gateway_status: status,
      });
    });

    it.each([
      [3, 'succeeded'],
      [4, 'failed'],
      [7, 'processing'],
      [null, 'processing'],
    ])('mode 3 reads preauthStatus %s as %s', async (status, state) => {
      const scenario = SCENARIOS[3];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status }));
      expect(await paymentRow(scenario.mupid)).toMatchObject({ state, reference: scenario.reference, gateway_status: status });
    });

    it('reads paymentStatus for mode 2 and ignores a preauthStatus in the body', async () => {
      const scenario = SCENARIOS[2];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 4, response: { preauthStatus: 3 } }));
      expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'failed', gateway_status: 4 });
    });
  });

  describe('final states', () => {
    it('keeps a payment failed when a valid success callback follows', async () => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 4 }));
      const response = await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
      expect(response.status).toBe(200);
      expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'failed', gateway_status: 4, reference: scenario.reference });
      expect((await callbackRows(scenario.mupid)).map((row) => row.outcome)).toEqual(['verified', 'verified']);
    });

    it('keeps a payment succeeded when a valid failure callback follows', async () => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 5 }));
      expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'succeeded', gateway_status: 3 });
    });

    it('keeps a final payment untouched, its time too, when a processing callback follows', async () => {
      const scenario = SCENARIOS[3];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
      const before = await paymentRow(scenario.mupid);
      await atTime(Date.parse(FROZEN_CLOCK) + DAY, () => postCallback(launch.callbackUrl, callbackBody(scenario, { status: 7 })));
      expect(await paymentRow(scenario.mupid)).toEqual(before);
    });

    it('moves a payment from processing to a final state', async () => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 7 }));
      expect((await paymentRow(scenario.mupid))?.state).toBe('processing');
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
      expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
    });

    it('moves a payment from unverified to the verified state', async () => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { unsigned: true }));
      expect((await paymentRow(scenario.mupid))?.state).toBe('unverified');
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
      expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
    });
  });

  describe('duplicates', () => {
    it('counts a repeat of the same body for the same payment instead of storing it again', async () => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      const body = JSON.stringify(callbackBody(scenario));
      await postCallback(launch.callbackUrl, body);
      await postCallback(launch.callbackUrl, body);
      const rows = await callbackRows(scenario.mupid);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deliveries).toBe(2);
    });

    it('stores a different body for the same payment as a second callback', async () => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 7 }));
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
      expect(await callbackRows(scenario.mupid)).toHaveLength(2);
    });

    it('counts a repeat of an unsigned or a rejected body too', async () => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      const unsigned = JSON.stringify(callbackBody(scenario, { unsigned: true }));
      const rejected = JSON.stringify(callbackBody(scenario, { validationCode: wrongHex(scenario.validationCode.sha3) }));
      for (const body of [unsigned, unsigned, rejected, rejected, rejected]) {
        await postCallback(launch.callbackUrl, body);
      }
      const rows = await callbackRows(scenario.mupid);
      expect(rows.map((row) => [row.outcome, row.deliveries]).sort()).toEqual([
        ['rejected', 3],
        ['unsigned', 2],
      ]);
    });

    it('keeps the same body posted for two different payments apart', async () => {
      const first = await (await postCheckout(requestFor(SCENARIOS[0]))).json<{ callbackUrl: string; merchantUniquePaymentId: string }>();
      const second = await (await postCheckout(requestFor(SCENARIOS[0]))).json<{ callbackUrl: string; merchantUniquePaymentId: string }>();
      const body = JSON.stringify({ response: { note: 'same' } });
      await postCallback(first.callbackUrl, body);
      await postCallback(second.callbackUrl, body);
      expect(await callbackRows(first.merchantUniquePaymentId)).toHaveLength(1);
      expect(await callbackRows(second.merchantUniquePaymentId)).toHaveLength(1);
    });

    it('stores every callback that belongs to no payment, even identical ones', async () => {
      const body = JSON.stringify({ response: { note: 'same' } });
      await postCallback(CALLBACK_PATH, body);
      await postCallback(CALLBACK_PATH, body);
      const rows = await callbackRows(null);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.deliveries === 1)).toBe(true);
    });
  });
});

describe('POST /callbacks/zenpay: callbacks that do not verify', () => {
  it.each(MODES)('rejects a mode %i callback whose validationCode does not match, and changes nothing', async (mode) => {
    const scenario = SCENARIOS[mode];
    const launch = await startCheckout(scenario);
    const response = await postCallback(
      launch.callbackUrl,
      callbackBody(scenario, { validationCode: wrongHex(scenario.validationCode.sha3) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json<CallbackReceipt>()).toEqual({ received: true });
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
    expect(await callbackRows(scenario.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'validationCode does not match the computed hash' },
    ]);
  });

  it('rejects a callback for a different reference than the one the code was made for', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { paymentReference: 'PR-OTHER' } }));
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
    expect((await callbackRows(scenario.mupid))[0]?.outcome).toBe('rejected');
  });

  it('rejects a callback whose code was made for another amount than the one in the address', async () => {
    const scenario = SCENARIOS[0];
    // The fixture's validationCode hashes 15053 cents; this payment was started for 150.54.
    const launch = await startCheckout(scenario, { paymentAmount: 150.54 });
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
    expect((await callbackRows(scenario.mupid))[0]?.outcome).toBe('rejected');
  });

  it('rejects a signed body whose merchantUniquePaymentId is not the payment in the address', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { merchantUniquePaymentId: SCENARIOS[1].mupid } }));
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
    expect(await callbackRows(scenario.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'merchantUniquePaymentId does not match the callback address.' },
    ]);
  });

  it('rejects a signed body whose merchantUniquePaymentId is not text', async () => {
    const scenario = SCENARIOS[1];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { merchantUniquePaymentId: null } }));
    expect((await callbackRows(scenario.mupid))[0]?.outcome).toBe('rejected');
  });

  it('accepts a signed body that leaves merchantUniquePaymentId out, as the package allows', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const body = callbackBody(scenario);
    delete (body.response as Record<string, unknown>).merchantUniquePaymentId;
    await postCallback(launch.callbackUrl, body);
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });

  it.each([0, 2, 3] as const)(
    'rejects a signed mode %i body whose status is text, which is not the shape of its mode, and never reads it as success',
    async (mode) => {
      const scenario = SCENARIOS[mode];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 'Successful' }));
      expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'pending', gateway_status: null });
      expect(await callbackRows(scenario.mupid)).toMatchObject([{ outcome: 'rejected', reason: 'malformed callback body' }]);
    },
  );

  it('rejects a body that is not JSON, keeping it for the admin to read', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const response = await postCallback(launch.callbackUrl, 'not json at all');
    expect(response.status).toBe(200);
    expect(await callbackRows(scenario.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'The body is not JSON.', body: 'not json at all', size: 15 },
    ]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"x"'],
    ['null', 'null'],
  ])('rejects JSON that is %s, not an object', async (_case, body) => {
    const launch = await startCheckout(SCENARIOS[0]);
    await postCallback(launch.callbackUrl, body);
    expect(await callbackRows(SCENARIOS[0].mupid)).toMatchObject([{ outcome: 'rejected', reason: 'The body is not a JSON object.' }]);
  });

  it('rejects a validationCode that is not text', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    await postCallback(launch.callbackUrl, { response: {}, validationCode: 5 });
    expect(await callbackRows(SCENARIOS[0].mupid)).toMatchObject([{ outcome: 'rejected', reason: 'validationCode is not text.' }]);
  });

  it('rejects an empty or short validationCode', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { validationCode: '' }));
    await postCallback(launch.callbackUrl, callbackBody(scenario, { validationCode: 'abc123' }));
    expect((await callbackRows(scenario.mupid)).map((row) => row.outcome)).toEqual(['rejected', 'rejected']);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('does not let a rejected callback change a payment that is already final', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 4 }));
    await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3, validationCode: wrongHex(scenario.validationCode.sha3) }));
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'failed', gateway_status: 4 });
  });

  it('refuses a body over 16 KB with 413 and stores nothing, and accepts one just under it', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const over = await postCallback(launch.callbackUrl, JSON.stringify({ response: { note: 'x'.repeat(16 * 1024) } }));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: 'Payload too large' });
    expect(await countCallbacks()).toBe(0);
    const under = await postCallback(launch.callbackUrl, JSON.stringify({ response: { note: 'x'.repeat(16 * 1024 - 100) } }));
    expect(under.status).toBe(200);
    expect(await countCallbacks()).toBe(1);
  });

  it('rejects a body that names a different payment before looking at its signature', async () => {
    const first = SCENARIOS[0];
    const launch = await startCheckout(first);
    // Signed for payment 1, posted to payment 0's address.
    await postCallback(launch.callbackUrl, callbackBody(SCENARIOS[1]));
    expect(await callbackRows(first.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'merchantUniquePaymentId does not match the callback address.' },
    ]);
  });
});

describe('POST /callbacks/zenpay: mode 2 amount', () => {
  // ZenPay hashes a Custom Payment's amount as 0, so the validationCode does not bind it and the shopper can change the
  // amount in the browser. The amount ZenPay reports charged (`baseAmount`) must equal the launch amount.
  const scenario = SCENARIOS[2];

  it('accepts a verified callback whose baseAmount equals the launch amount', async () => {
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount: 49.9 } }));
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'succeeded', gateway_status: 3 });
  });

  it.each([0.01, 49.89, 49.91, 4990])(
    'rejects a verified callback whose baseAmount is %s, leaving the payment pending',
    async (baseAmount) => {
      const launch = await startCheckout(scenario);
      const response = await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount } }));
      expect(response.status).toBe(200);
      expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'pending', reference: null, gateway_status: null });
      expect(await callbackRows(scenario.mupid)).toMatchObject([
        { outcome: 'rejected', reason: 'The amount charged (baseAmount) differs from the launch amount.' },
      ]);
    },
  );

  it('rejects a verified callback with no baseAmount, leaving the payment pending', async () => {
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount: undefined } }));
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
    const [row] = await callbackRows(scenario.mupid);
    expect(row).toMatchObject({ outcome: 'rejected' });
    expect(row?.reason).toContain('no baseAmount');
  });

  it('leaves a payment that already succeeded alone when a later callback reports another amount', async () => {
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount: 0.01 } }));
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'succeeded' });
  });

  it('still succeeds on the correct callback after one with the wrong amount', async () => {
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount: 0.01 } }));
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });

  it('does not ask modes 0, 1 and 3 for baseAmount: their validationCode already binds the amount', async () => {
    for (const mode of [0, 1, 3] as const) {
      const other = SCENARIOS[mode];
      const launch = await startCheckout(other);
      await postCallback(launch.callbackUrl, callbackBody(other, { response: { baseAmount: undefined } }));
      expect((await paymentRow(other.mupid))?.state).toBe('succeeded');
    }
  });
});

describe('POST /callbacks/zenpay: storage limits', () => {
  /**
   * Posts a body that no payment can verify, so it is stored as unsigned.
   * @param callbackUrl - The launch's callback address.
   * @param index - Makes the body different from the others.
   * @returns The response.
   */
  const postNote = (callbackUrl: string, index: number): Promise<Response> =>
    postCallback(callbackUrl, { response: { note: `note-${index}` } });

  it('keeps at most 10 distinct bodies for a payment, answers 200 for the rest, and still counts a repeat of a stored body', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    for (let index = 0; index < 12; index += 1) {
      expect((await postNote(launch.callbackUrl, index)).status).toBe(200);
    }
    expect(await callbackRows(scenario.mupid)).toHaveLength(10);
    // A stored body counts again; one that was not stored still stores nothing.
    expect((await postNote(launch.callbackUrl, 0)).status).toBe(200);
    expect((await postNote(launch.callbackUrl, 11)).status).toBe(200);
    const rows = await callbackRows(scenario.mupid);
    expect(rows).toHaveLength(10);
    expect(rows.find((row) => row.body.includes('note-0'))?.deliveries).toBe(2);
    expect(rows.some((row) => row.body.includes('note-11'))).toBe(false);
  });

  it('keeps the limit per payment, not for all of them', async () => {
    const full = await startCheckout(SCENARIOS[0]);
    const other = await startCheckout(SCENARIOS[2]);
    for (let index = 0; index < 11; index += 1) {
      await postNote(full.callbackUrl, index);
    }
    await postNote(other.callbackUrl, 0);
    expect(await callbackRows(SCENARIOS[0].mupid)).toHaveLength(10);
    expect(await callbackRows(SCENARIOS[2].mupid)).toHaveLength(1);
  });

  it('still applies a verified callback to a payment that already holds 10 bodies, without storing it', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    for (let index = 0; index < 10; index += 1) {
      await postNote(launch.callbackUrl, index);
    }
    expect((await postCallback(launch.callbackUrl, callbackBody(scenario))).status).toBe(200);
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
    expect(await callbackRows(scenario.mupid)).toHaveLength(10);
  });

  it('keeps the first 4 KB of a rejected body, with its real size and the hash of the whole body', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const text = `not json ${'x'.repeat(10_000)}`;
    await postCallback(launch.callbackUrl, text);
    const [row] = await callbackRows(scenario.mupid);
    expect(row).toMatchObject({ outcome: 'rejected', size: text.length, body_hash: await sha256(text) });
    expect(row?.body).toBe(text.slice(0, 4096));
  });

  it('keeps the first 4 KB of a callback that belongs to no payment too, cutting at bytes', async () => {
    const text = 'ü'.repeat(5000);
    await postCallback(CALLBACK_PATH, text);
    const [row] = await callbackRows(null);
    expect(row?.size).toBe(10_000);
    expect(new TextEncoder().encode(row?.body ?? '').byteLength).toBeLessThanOrEqual(4096);
    expect(row?.body.length).toBeGreaterThan(2000);
    expect(row?.body_hash).toBe(await sha256(text));
  });

  it('keeps the whole body of an unsigned or a verified callback', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const unsigned = JSON.stringify({ response: { note: 'x'.repeat(8000) } });
    await postCallback(launch.callbackUrl, unsigned);
    const verified = JSON.stringify(callbackBody(scenario, { response: { note: 'y'.repeat(8000) } }));
    await postCallback(launch.callbackUrl, verified);
    const rows = await callbackRows(scenario.mupid);
    expect(rows.map((row) => row.body).sort()).toEqual([unsigned, verified].sort());
  });

  it('keeps the hash of a truncated body, so a repeat of it still counts instead of adding a row', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const text = `not json ${'x'.repeat(10_000)}`;
    await postCallback(launch.callbackUrl, text);
    await postCallback(launch.callbackUrl, text);
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ deliveries: 2 }]);
  });
});

describe('POST /callbacks/zenpay: unsigned callbacks', () => {
  it.each(MODES)('stores a mode %i callback with no validationCode as unsigned and moves the payment to unverified only', async (mode) => {
    const scenario = SCENARIOS[mode];
    const launch = await startCheckout(scenario);
    const response = await postCallback(launch.callbackUrl, callbackBody(scenario, { unsigned: true }));
    expect(response.status).toBe(200);
    expect(await response.json<CallbackReceipt>()).toEqual({ received: true });
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'unverified', reference: null, gateway_status: null });
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ outcome: 'unsigned', reason: null }]);
  });

  it('never marks a payment succeeded on an unsigned callback that says Successful', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { unsigned: true, status: 3 }));
    expect((await paymentRow(scenario.mupid))?.state).toBe('unverified');
  });

  it('stores a mode 3 unsigned notification whose preauthStatus is the text "Successful", exactly as sent', async () => {
    const scenario = SCENARIOS[3];
    const launch = await startCheckout(scenario);
    const text = JSON.stringify({
      response: { merchantUniquePaymentId: scenario.mupid, preauthReference: scenario.reference, preauthStatus: 'Successful' },
    });
    const response = await postCallback(launch.callbackUrl, text);
    expect(response.status).toBe(200);
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ outcome: 'unsigned', body: text }]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('unverified');
  });

  it('rejects an unsigned body that names a different payment, and leaves this payment pending', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(SCENARIOS[1], { unsigned: true }));
    expect(await callbackRows(scenario.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'merchantUniquePaymentId does not match the callback address.' },
    ]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('treats a validationCode of null as no validationCode', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    await postCallback(launch.callbackUrl, { response: {}, validationCode: null });
    expect((await callbackRows(SCENARIOS[0].mupid))[0]?.outcome).toBe('unsigned');
  });

  it('changes nothing on a payment that has succeeded', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
    const before = await paymentRow(scenario.mupid);
    await atTime(Date.parse(FROZEN_CLOCK) + DAY, () =>
      postCallback(launch.callbackUrl, callbackBody(scenario, { unsigned: true, status: 4 })),
    );
    expect(await paymentRow(scenario.mupid)).toEqual(before);
    expect((await callbackRows(scenario.mupid)).map((row) => row.outcome).sort()).toEqual(['unsigned', 'verified']);
  });

  it('changes nothing on a payment that has failed, or that is processing', async () => {
    for (const [status, state] of [
      [4, 'failed'],
      [7, 'processing'],
    ] as const) {
      const scenario = SCENARIOS[status === 4 ? 0 : 2];
      const launch = await startCheckout(scenario);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { status }));
      const before = await paymentRow(scenario.mupid);
      await postCallback(launch.callbackUrl, callbackBody(scenario, { unsigned: true, status: 3 }));
      expect(await paymentRow(scenario.mupid)).toEqual(before);
      expect(before?.state).toBe(state);
    }
  });

  it('keeps a payment unverified when another unsigned callback arrives', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { unsigned: true, status: 7 }));
    await postCallback(launch.callbackUrl, callbackBody(scenario, { unsigned: true, status: 4 }));
    expect((await paymentRow(scenario.mupid))?.state).toBe('unverified');
    expect(await callbackRows(scenario.mupid)).toHaveLength(2);
  });
});

describe('POST /callbacks/zenpay: the callback address token', () => {
  it('rejects a callback with no token, storing it with no payment', async () => {
    const scenario = SCENARIOS[0];
    await startCheckout(scenario);
    const response = await postCallback(CALLBACK_PATH, callbackBody(scenario));
    expect(response.status).toBe(200);
    expect(await response.json<CallbackReceipt>()).toEqual({ received: true });
    expect(await callbackRows(null)).toMatchObject([{ outcome: 'rejected', reason: 'The callback address has no token.' }]);
    expect(await callbackRows(scenario.mupid)).toHaveLength(0);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('rejects a callback with an empty token', async () => {
    await postCallback(`${CALLBACK_PATH}?t=`, {});
    expect(await callbackRows(null)).toMatchObject([{ reason: 'The callback address has no token.' }]);
  });

  // A token of 32 characters or fewer is shorter than a signature, so the library calls it malformed; a longer one
  // with the wrong signature is bad-signature, whatever else is wrong with it.
  it.each([
    ['abc', 'The callback address token is not one this Worker made.'],
    ['not.a.token', 'The callback address token is not one this Worker made.'],
    ['x'.repeat(200), 'The callback address token is not signed with this Worker’s secret.'],
  ])('rejects the token %s with the reason %s', async (token, reason) => {
    await postCallback(`${CALLBACK_PATH}?t=${token}`, {});
    expect(await callbackRows(null)).toMatchObject([{ outcome: 'rejected', reason }]);
  });

  it('rejects a token whose content was changed, without trusting the payment it names', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(withChangedToken(launch.callbackUrl, 10), callbackBody(scenario));
    expect(await callbackRows(null)).toMatchObject([
      { outcome: 'rejected', reason: 'The callback address token is not signed with this Worker’s secret.' },
    ]);
    expect(await callbackRows(scenario.mupid)).toHaveLength(0);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('rejects a token whose signature was changed', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(withChangedToken(launch.callbackUrl, -1), callbackBody(scenario));
    expect(await callbackRows(null)).toMatchObject([
      { outcome: 'rejected', reason: 'The callback address token is not signed with this Worker’s secret.' },
    ]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('rejects a token signed with another secret', async () => {
    const scenario = SCENARIOS[0];
    await startCheckout(scenario);
    const token = createZpCallbackUrlToken(
      { mode: 0, merchantUniquePaymentId: scenario.mupid, timestamp: FROZEN_TIMESTAMP, paymentAmount: scenario.paymentAmount },
      'a-different-secret-that-is-also-32-bytes',
    );
    await postCallback(`${CALLBACK_PATH}?t=${token}`, callbackBody(scenario));
    expect(await callbackRows(null)).toMatchObject([
      { outcome: 'rejected', reason: 'The callback address token is not signed with this Worker’s secret.' },
    ]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('rejects an expired token, 7 days after it was made, and accepts it until then', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const madeAt = Date.parse(FROZEN_CLOCK);
    await atTime(madeAt + 7 * DAY + 2000, () => postCallback(launch.callbackUrl, callbackBody(scenario)));
    expect(await callbackRows(null)).toMatchObject([{ outcome: 'rejected', reason: 'The callback address token is expired.' }]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');

    await atTime(madeAt + 7 * DAY - 2000, () => postCallback(launch.callbackUrl, callbackBody(scenario)));
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });

  it('rejects a valid token for a payment that does not exist, storing it with no payment', async () => {
    const scenario = SCENARIOS[0];
    const token = createZpCallbackUrlToken(
      { mode: 0, merchantUniquePaymentId: scenario.mupid, timestamp: FROZEN_TIMESTAMP, paymentAmount: scenario.paymentAmount },
      CALLBACK_TOKEN_SECRET,
    );
    const response = await postCallback(`${CALLBACK_PATH}?t=${token}`, callbackBody(scenario));
    expect(response.status).toBe(200);
    expect(await callbackRows(null)).toMatchObject([
      { outcome: 'rejected', reason: 'The callback address names a payment that does not exist.' },
    ]);
  });

  it('rejects a valid token that carries no amount', async () => {
    const scenario = SCENARIOS[0];
    await startCheckout(scenario);
    const token = createZpCallbackUrlToken(
      { mode: 0, merchantUniquePaymentId: scenario.mupid, timestamp: FROZEN_TIMESTAMP },
      CALLBACK_TOKEN_SECRET,
    );
    await postCallback(`${CALLBACK_PATH}?t=${token}`, callbackBody(scenario));
    expect(await callbackRows(null)).toMatchObject([{ reason: 'The callback address token carries no amount.' }]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('cannot be used by one payment’s token to change another payment', async () => {
    const first = SCENARIOS[0];
    const second = SCENARIOS[2];
    const firstLaunch = await startCheckout(first);
    await startCheckout(second);
    await postCallback(firstLaunch.callbackUrl, callbackBody(second));
    expect((await paymentRow(second.mupid))?.state).toBe('pending');
    expect((await paymentRow(first.mupid))?.state).toBe('pending');
  });
});

describe('POST /callbacks/zenpay: the route itself', () => {
  it('is public: it needs no Cloudflare Access sign-in and no allowed origin', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const response = await postCallback(launch.callbackUrl, callbackBody(scenario), { origin: 'https://zenpay.example', limited: true });
    expect(response.status).toBe(200);
  });

  it('answers 404 to any method but POST', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const url = new URL(launch.callbackUrl);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await exports.default.fetch(`${CALLBACK_PATH}${url.search}`, { method });
      expect(response.status).toBe(404);
    }
  });

  it.each([
    ['ZENPAY_API_KEY', { ZENPAY_API_KEY: '' }],
    ['ZENPAY_USERNAME', { ZENPAY_USERNAME: '' }],
    ['ZENPAY_PASSWORD', { ZENPAY_PASSWORD: '' }],
    ['CALLBACK_TOKEN_SECRET', { CALLBACK_TOKEN_SECRET: '' }],
  ])('answers a JSON 500 that names nothing when %s is not set, logs the name, and stores nothing', async (name, vars) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const response = await postCallback(launch.callbackUrl, callbackBody(scenario), { vars });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Not configured' });
    expect(logged).toHaveBeenCalledWith(`Not configured: set ${name}.`);
    expect(await countCallbacks()).toBe(0);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  // A setting that is missing from the environment, empty, or only spaces is not set.
  it.each([undefined, '', '   '])('treats ZENPAY_API_KEY as not set when it is %j', async (value) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const launch = await startCheckout(SCENARIOS[0]);
    const response = await postCallback(launch.callbackUrl, {}, { vars: { ZENPAY_API_KEY: value } });
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalledWith('Not configured: set ZENPAY_API_KEY.');
    expect(await countCallbacks()).toBe(0);
  });

  it('answers a JSON 500 that names nothing when CALLBACK_TOKEN_SECRET is under 32 bytes, and logs the setting', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const launch = await startCheckout(SCENARIOS[0]);
    const response = await postCallback(launch.callbackUrl, {}, { vars: { CALLBACK_TOKEN_SECRET: 'short' } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Not configured' });
    expect(logged).toHaveBeenCalledWith('Not configured: set CALLBACK_TOKEN_SECRET (at least 32 bytes).');
  });

  it('does not need ZENPAY_MERCHANT_CODE or ZENPAY_CHECKOUT_URL to check a callback', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const response = await postCallback(launch.callbackUrl, callbackBody(scenario), {
      vars: { ZENPAY_MERCHANT_CODE: '', ZENPAY_CHECKOUT_URL: '' },
    });
    expect(response.status).toBe(200);
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });
});

describe('POST /callbacks/zenpay: rate limit', () => {
  it('answers 429 after 60 callbacks a minute for one payment, whoever sends them, without blocking other payments', async () => {
    const first = await (await postCheckout(requestFor(SCENARIOS[0]))).json<{ callbackUrl: string }>();
    const second = await (await postCheckout(requestFor(SCENARIOS[0]))).json<{ callbackUrl: string }>();
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      const response = await postCallback(first.callbackUrl, { response: { index } }, { limited: true, ip: randomIp() });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 60)).toEqual(Array<number>(60).fill(200));
    expect(statuses[60]).toBe(429);
    // Only 10 distinct bodies are kept for one payment, whatever the rate limit lets through.
    expect(await countCallbacks()).toBe(10);
    expect((await postCallback(second.callbackUrl, { response: {} }, { limited: true })).status).toBe(200);
  });

  it('never limits a callback that verifies: junk that used up the allowance cannot make ZenPay’s genuine callback answer 429', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const junk: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      junk.push((await postCallback(launch.callbackUrl, { response: { index } }, { limited: true, ip: randomIp() })).status);
    }
    expect(junk[60]).toBe(429);
    const genuine = await postCallback(launch.callbackUrl, callbackBody(scenario), { limited: true });
    expect(genuine.status).toBe(200);
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });

  it('counts only callbacks that do not verify: 70 repeats of a verified body all answer 200', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const body = JSON.stringify(callbackBody(scenario));
    const statuses = new Set<number>();
    for (let index = 0; index < 70; index += 1) {
      statuses.add((await postCallback(launch.callbackUrl, body, { limited: true })).status);
    }
    expect([...statuses]).toEqual([200]);
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ deliveries: 70 }]);
  });

  it('limits callbacks with no readable token by the sender’s address', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      statuses.push((await postCallback(CALLBACK_PATH, { index }, { limited: true, ip })).status);
    }
    expect(statuses[59]).toBe(200);
    expect(statuses[60]).toBe(429);
    expect((await postCallback(CALLBACK_PATH, {}, { limited: true, ip: randomIp() })).status).toBe(200);
  });
});

describe('POST /callbacks/zenpay: the clock', () => {
  // The callback address token made at the frozen clock lasts 7 days from it. A callback posted at the real clock
  // would be refused from the eighth day on, so the suite must give the same answers on any day.
  it('verifies a callback however far the real clock has moved on from the frozen one', async () => {
    const scenario = SCENARIOS[0];
    await withClockAhead(400 * DAY, async () => {
      const launch = await startCheckout(scenario);
      expect(Date.now()).toBeGreaterThan(Date.parse(FROZEN_CLOCK) + 7 * DAY);
      expect((await postCallback(launch.callbackUrl, callbackBody(scenario))).status).toBe(200);
    });
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'succeeded', reference: scenario.reference });
  });

  it('would refuse the same callback if it were posted at that later real clock, which is what the timeline avoids', async () => {
    const scenario = SCENARIOS[0];
    await withClockAhead(400 * DAY, async () => {
      const launch = await startCheckout(scenario);
      const url = new URL(launch.callbackUrl);
      const response = await send(`${url.pathname}${url.search}`, {
        origin: null,
        method: 'POST',
        body: JSON.stringify(callbackBody(scenario)),
      });
      expect(response.status).toBe(200);
    });
    expect(await callbackRows(null)).toMatchObject([{ outcome: 'rejected', reason: 'The callback address token is expired.' }]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('posts each callback a second after the one before, so a payment’s rows keep their order', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 7 }));
    await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 }));
    const [first, second] = await callbackRows(scenario.mupid);
    expect(Date.parse(second?.received_at ?? '') - Date.parse(first?.received_at ?? '')).toBe(1000);
  });
});

describe('POST /callbacks/zenpay: odd bodies', () => {
  it('stores an empty body as rejected, not JSON, with size 0', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const response = await postCallback(launch.callbackUrl, '');
    expect(response.status).toBe(200);
    expect(await callbackRows(scenario.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'The body is not JSON.', body: '', size: 0, body_hash: await sha256('') },
    ]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('keeps a byte order mark in the stored text and counts its 3 bytes, but rejects the body, since JSON cannot start with one', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const text = `\uFEFF${JSON.stringify(callbackBody(scenario))}`;
    await postCallback(launch.callbackUrl, text);
    const [row] = await callbackRows(scenario.mupid);
    expect(row).toMatchObject({ outcome: 'rejected', reason: 'The body is not JSON.' });
    expect(row?.body.startsWith('\uFEFF')).toBe(true);
    expect(row?.size).toBe(new TextEncoder().encode(text).byteLength);
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
  });

  it('stores bytes that are not UTF-8 as replacement characters, with the real size and the hash of the real bytes', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const bytes = new Uint8Array([0xff, 0xfe, 0x7b]);
    const response = await postCallback(launch.callbackUrl, bytes);
    expect(response.status).toBe(200);
    expect(await callbackRows(scenario.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'The body is not JSON.', body: '\uFFFD\uFFFD{', size: 3, body_hash: await sha256(bytes) },
    ]);
  });

  // The limit is 4096 bytes. A character that would straddle it is dropped whole: cutting its bytes in the middle
  // would store a 3 byte replacement character and go over the limit.
  it.each([
    ['aa', '€', 2000, 'aa' + '€'.repeat(1364), 4094],
    ['a', '😀', 2000, 'a' + '😀'.repeat(1023), 4093],
    ['', '😀', 2000, '😀'.repeat(1024), 4096],
    ['', 'ü', 3000, 'ü'.repeat(2048), 4096],
  ])(
    'cuts a rejected body of %j and then %j %i times at a character, so it keeps the longest start that fits',
    async (prefix, unit, count, kept, keptBytes) => {
      const scenario = SCENARIOS[0];
      const launch = await startCheckout(scenario);
      const text = prefix + unit.repeat(count);
      await postCallback(launch.callbackUrl, text);
      const [row] = await callbackRows(scenario.mupid);
      expect(row?.body).toBe(kept);
      expect(new TextEncoder().encode(row?.body ?? '').byteLength).toBe(keptBytes);
      expect(row?.size).toBe(new TextEncoder().encode(text).byteLength);
      expect(row?.body_hash).toBe(await sha256(text));
    },
  );

  it('does not cut a body that is exactly 4096 bytes', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const text = '€'.repeat(1365) + 'a';
    await postCallback(launch.callbackUrl, text);
    expect((await callbackRows(SCENARIOS[0].mupid))[0]?.body).toBe(text);
  });
});

describe('POST /callbacks/zenpay: signed bodies with something missing', () => {
  it('rejects a signed body that has no response, leaving the payment pending', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, { validationCode: scenario.validationCode.sha3 });
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ outcome: 'rejected', reason: 'malformed callback body' }]);
  });

  it('rejects a mode 2 baseAmount sent as a numeric string, which the package already calls a malformed body', async () => {
    const scenario = SCENARIOS[2];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount: '49.9' } }));
    expect((await paymentRow(scenario.mupid))?.state).toBe('pending');
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ outcome: 'rejected', reason: 'malformed callback body' }]);
  });

  it('compares a mode 2 baseAmount with the stored amount, not the one in the address', async () => {
    const scenario = SCENARIOS[2];
    const launch = await startCheckout(scenario);
    await env.DB.prepare('UPDATE payments SET amount_cents = 5000 WHERE id = ?').bind(scenario.mupid).run();
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount: 49.9 } }));
    expect(await callbackRows(scenario.mupid)).toMatchObject([
      { outcome: 'rejected', reason: 'The amount charged (baseAmount) differs from the launch amount.' },
    ]);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { response: { baseAmount: 50 } }));
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });

  it('lets a processing payment move to another processing status, taking the new status and time', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 7 }));
    const first = await paymentRow(scenario.mupid);
    await postCallback(launch.callbackUrl, callbackBody(scenario, { status: 0 }));
    const second = await paymentRow(scenario.mupid);
    expect(first).toMatchObject({ state: 'processing', gateway_status: 7 });
    expect(second).toMatchObject({ state: 'processing', gateway_status: 0 });
    expect(Date.parse(second?.updated_at ?? '')).toBeGreaterThan(Date.parse(first?.updated_at ?? ''));
  });
});

describe('POST /callbacks/zenpay: callbacks that arrive together', () => {
  it('ends in one final state that matches its status when a success and a failure arrive at once', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const responses = await Promise.all([
      postCallback(launch.callbackUrl, callbackBody(scenario, { status: 3 })),
      postCallback(launch.callbackUrl, callbackBody(scenario, { status: 4 })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const row = await paymentRow(scenario.mupid);
    expect([
      ['succeeded', 3],
      ['failed', 4],
    ]).toContainEqual([row?.state, row?.gateway_status]);
    expect(row?.reference).toBe(scenario.reference);
    expect((await callbackRows(scenario.mupid)).map((callback) => callback.outcome)).toEqual(['verified', 'verified']);
  });

  it('stores one row counting 5 deliveries when the same body arrives 5 times at once', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const body = JSON.stringify(callbackBody(scenario));
    const responses = await Promise.all(Array.from({ length: 5 }, () => postCallback(launch.callbackUrl, body)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await callbackRows(scenario.mupid)).toMatchObject([{ outcome: 'verified', deliveries: 5 }]);
    expect((await paymentRow(scenario.mupid))?.state).toBe('succeeded');
  });
});

describe('POST /callbacks/zenpay: when the database fails', () => {
  it('answers 500 and changes nothing, so the failure is visible and a retry can succeed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const prepare = vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('D1 is down: secret detail');
    });
    const response = await postCallback(launch.callbackUrl, callbackBody(scenario));
    prepare.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(logged).toHaveBeenCalled();
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'pending', reference: null });
    expect(await countCallbacks()).toBe(0);
  });

  it('keeps the callback row and the payment change together: when the change fails, the row is not stored either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    const prepare = env.DB.prepare.bind(env.DB);
    // The change sets a state the table's CHECK refuses, so it fails when the batch runs, after the row went in.
    const spy = vi
      .spyOn(env.DB, 'prepare')
      .mockImplementation((sql) =>
        prepare(sql.startsWith('UPDATE payments SET state = ?2') ? sql.replace('state = ?2', "state = 'bogus'") : sql),
      );
    const response = await postCallback(launch.callbackUrl, callbackBody(scenario));
    spy.mockRestore();
    expect(response.status).toBe(500);
    expect(await countCallbacks()).toBe(0);
    expect(await paymentRow(scenario.mupid)).toMatchObject({ state: 'pending', reference: null });
  });
});

describe('POST /callbacks/zenpay: the sender’s address', () => {
  it.each([
    ['without CF-Connecting-IP', {}, 'CALLBACK_LIMITER:unknown'],
    ['with CF-Connecting-IP', { 'CF-Connecting-IP': '203.0.113.7' }, 'CALLBACK_LIMITER:203.0.113.7'],
  ])('counts a callback with no readable token %s under the key %s', async (_case, headers, key) => {
    const limit = vi.spyOn(env.CALLBACK_LIMITER, 'limit').mockResolvedValue({ success: true });
    const response = await exports.default.fetch(CALLBACK_PATH, { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(200);
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key });
  });
});
