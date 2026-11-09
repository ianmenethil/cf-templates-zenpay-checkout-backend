import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentResponse, PaymentStatus } from '../src/shared/types';
import { serveAccessKeys } from './helpers/access';
import { adminApi } from './helpers/admin';
import { ORIGIN } from './helpers/constants';
import { SCENARIOS, SHOP_ORIGIN } from './helpers/zenpay-fixtures';
import { callbackBody, getStatus, postCallback, postCheckout, randomIp, requestFor, send, startCheckout } from './helpers/zenpay';

beforeEach(serveAccessKeys);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/checkout/:merchantUniquePaymentId', () => {
  it('answers pending, with no reference, for a payment no callback has reached', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const response = await getStatus(launch.merchantUniquePaymentId);
    expect(response.status).toBe(200);
    expect(await response.json<PaymentStatus>()).toEqual({
      merchantUniquePaymentId: SCENARIOS[0].mupid,
      state: 'pending',
      reference: null,
    });
  });

  it('answers the state and ZenPay’s reference once a verified callback arrives', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    expect((await postCallback(launch.callbackUrl, callbackBody(scenario))).status).toBe(200);
    expect(await (await getStatus(scenario.mupid)).json<PaymentStatus>()).toEqual({
      merchantUniquePaymentId: scenario.mupid,
      state: 'succeeded',
      reference: scenario.reference,
    });
  });

  it.each([2, 3] as const)('answers ZenPay’s payment or preauth reference for mode %i', async (mode) => {
    const scenario = SCENARIOS[mode];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    expect((await (await getStatus(scenario.mupid)).json<PaymentStatus>()).reference).toBe(scenario.reference);
  });

  it('never hands out the Tokenise token: a mode 1 payment answers reference null, while the admin API keeps it', async () => {
    const scenario = SCENARIOS[1];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    expect(await (await getStatus(scenario.mupid)).json<PaymentStatus>()).toEqual({
      merchantUniquePaymentId: scenario.mupid,
      state: 'succeeded',
      reference: null,
    });
    const { payment } = await (await adminApi(`/payments/${scenario.mupid}`)).json<PaymentResponse>();
    expect(payment.reference).toBe(scenario.reference);
  });

  it('exposes nothing but the ID, the state and the reference', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const body = await (await getStatus(launch.merchantUniquePaymentId)).json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['merchantUniquePaymentId', 'reference', 'state']);
  });

  it('answers 404 for an ID that no payment has', async () => {
    const response = await getStatus(crypto.randomUUID());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  // The spies in the next test only prove something if a spy on the limiter sees the Worker's calls at all.
  it('counts a well-formed ID on the status limiter under the visitor’s address', async () => {
    const limit = vi.spyOn(env.STATUS_LIMITER, 'limit');
    const ip = randomIp();
    expect((await getStatus(crypto.randomUUID(), { ip })).status).toBe(404);
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: `STATUS_LIMITER:${ip}` });
  });

  it.each([
    ['text', 'not-an-id'],
    ['a SQL fragment', encodeURIComponent("' OR 1=1 --")],
    ['an ID with one character too many', `${crypto.randomUUID()}0`],
    ['an ID with a wildcard', '%25'],
  ])('answers 404 to %s without touching the database or the rate limiter', async (_case, id) => {
    const prepare = vi.spyOn(env.DB, 'prepare');
    const limit = vi.spyOn(env.STATUS_LIMITER, 'limit');
    const response = await getStatus(id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(prepare).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it('answers with no-store and the CORS headers for the calling shop', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const response = await getStatus(launch.merchantUniquePaymentId);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SHOP_ORIGIN);
  });

  it('refuses an origin that is not listed, and a request with no origin', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const other = await getStatus(launch.merchantUniquePaymentId, { origin: 'https://evil.example.com' });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'Origin not allowed' });
    expect((await getStatus(launch.merchantUniquePaymentId, { origin: null })).status).toBe(403);
  });

  it('refuses every request until ALLOWED_ORIGINS is set, naming no setting and logging it', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await getStatus(launch.merchantUniquePaymentId, { vars: { ALLOWED_ORIGINS: '' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Not configured' });
    expect(logged).toHaveBeenCalledExactlyOnceWith('Not configured: set ALLOWED_ORIGINS.');
  });

  // A status check without CF-Connecting-IP, such as one under local development, shares one allowance.
  it('counts a status check with no CF-Connecting-IP under the key STATUS_LIMITER:unknown', async () => {
    const limit = vi.spyOn(env.STATUS_LIMITER, 'limit').mockResolvedValue({ success: true });
    const response = await exports.default.fetch(`${ORIGIN}/api/checkout/${crypto.randomUUID()}`, { headers: { Origin: SHOP_ORIGIN } });
    expect(response.status).toBe(404);
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: 'STATUS_LIMITER:unknown' });
  });

  it('answers the preflight of an allowed origin', async () => {
    const response = await send(`/api/checkout/${crypto.randomUUID()}`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SHOP_ORIGIN);
  });

  it('answers 429 after 60 requests a minute from one address, without blocking another address', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    const ip = randomIp();
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      statuses.push((await getStatus(launch.merchantUniquePaymentId, { ip })).status);
    }
    expect(statuses.slice(0, 60)).toEqual(Array<number>(60).fill(200));
    expect(statuses[60]).toBe(429);
    expect((await getStatus(launch.merchantUniquePaymentId, { ip: randomIp() })).status).toBe(200);
  });

  it('counts status checks apart from checkout requests, so a page that used its 10 checkouts can still poll', async () => {
    const ip = randomIp();
    const launch = await startCheckout(SCENARIOS[0]);
    for (let index = 0; index < 10; index += 1) {
      expect((await postCheckout(requestFor(SCENARIOS[0]), { ip })).status).toBe(200);
    }
    expect((await postCheckout(requestFor(SCENARIOS[0]), { ip })).status).toBe(429);
    expect((await getStatus(launch.merchantUniquePaymentId, { ip })).status).toBe(200);
  });
});
