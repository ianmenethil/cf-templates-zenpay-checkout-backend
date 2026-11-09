import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallbackList, CallbackResponse, PaymentList, PaymentResponse } from '../src/shared/types';
import { ADMIN_EMAIL, serveAccessKeys } from './helpers/access';
import { adminApi, asAdmin } from './helpers/admin';
import { ORIGIN } from './helpers/constants';
import { SCENARIOS } from './helpers/zenpay-fixtures';
import {
  callbackBody,
  callbackRows,
  getStatus,
  paymentRow,
  postCallback,
  seedCallbacks,
  seedPayments,
  startCheckout,
} from './helpers/zenpay';

const OTHER_SITE = 'https://evil.example';

/**
 * Builds an ISO time `second` seconds into a fixed minute, so seeded rows have a known order.
 * @param second - Seconds, 0 to 59.
 * @returns The time as the Worker writes it.
 */
const at = (second: number): string => `2026-03-01T00:00:${String(second).padStart(2, '0')}.000Z`;

/**
 * Counts rows in a table.
 * @param table - `payments` or `callbacks`.
 * @returns How many there are.
 */
const count = async (table: 'payments' | 'callbacks'): Promise<number> =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

beforeEach(serveAccessKeys);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin panel', () => {
  it('refuses a visitor who did not come through Cloudflare Access, answering { error }', async () => {
    const refused = await exports.default.fetch(`${ORIGIN}/admin`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Sign in through Cloudflare Access to use the admin panel.' });
    const invalid = await exports.default.fetch(`${ORIGIN}/admin/api/me`, { headers: { 'Cf-Access-Jwt-Assertion': 'not.a.token' } });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: 'Your Cloudflare Access session is not valid for this application.' });
  });

  it.each(['/admin/api/me', '/admin/api/payments', '/admin/api/payments/x', '/admin/api/callbacks', '/admin/api/callbacks/x'])(
    'refuses GET %s without an Access sign-in',
    async (path) => {
      expect((await exports.default.fetch(`${ORIGIN}${path}`)).status).toBe(401);
    },
  );

  it('refuses the panel files too without an Access sign-in', async () => {
    expect((await exports.default.fetch(`${ORIGIN}/admin/`)).status).toBe(401);
    expect((await exports.default.fetch(`${ORIGIN}/admin/assets/anything.js`)).status).toBe(401);
  });

  it('changes nothing for a visitor without an Access sign-in', async () => {
    const [id] = await seedPayments([{}]);
    const deleted = await exports.default.fetch(`${ORIGIN}/admin/api/payments/${id}`, {
      method: 'DELETE',
      headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(deleted.status).toBe(401);
    expect(await count('payments')).toBe(1);
  });

  it('sends /admin to /admin/', async () => {
    const response = await asAdmin('', { redirect: 'manual' });
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe('/admin/');
  });

  it('serves the page with security headers, using only its own script and stylesheet', async () => {
    const response = await asAdmin('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('Content-Security-Policy')).toContain("base-uri 'none'");
    const html = await response.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/<script type="module"[^>]* src="\/admin\/assets\/[^"]+\.js"/);
    expect(html).toMatch(/<link rel="stylesheet"[^>]* href="\/admin\/assets\/[^"]+\.css"/);
    // The page's CSP forbids inline scripts, so the built page must not need any.
    expect(html).not.toMatch(/<script(?![^>]* src=)[^>]*>/);
    // Its stylesheet is its own file, and every script and stylesheet it loads is under /admin/assets/.
    expect(html).not.toMatch(/<style[\s>]/);
    const loaded = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(loaded).toHaveLength(2);
    for (const address of loaded) {
      expect(address).toMatch(/^\/admin\/assets\//);
    }
  });

  it('serves its script with the security headers', async () => {
    const html = await (await asAdmin('/')).text();
    const [, scriptPath] = html.match(/ src="\/admin(\/assets\/[^"]+\.js)"/) ?? [];
    expect(scriptPath).toBeDefined();
    const script = await asAdmin(scriptPath);
    expect(script.status).toBe(200);
    expect(script.headers.get('Content-Type')).toContain('javascript');
    expect(script.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('sends the site root to the panel', async () => {
    const response = await exports.default.fetch(`${ORIGIN}/`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/');
  });
});

describe('admin API', () => {
  it('tells the panel who is signed in and the brand name', async () => {
    const response = await adminApi('/me');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: ADMIN_EMAIL, brand: 'Menethil' });
  });

  it('tells browsers and caches not to keep its answers', async () => {
    const [id] = await seedPayments([{}]);
    const [callbackId] = await seedCallbacks([{ paymentId: id }]);
    for (const path of ['/me', '/payments', `/payments/${id}`, '/callbacks', `/callbacks/${callbackId}`]) {
      expect((await adminApi(path)).headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('answers errors in the same { error } shape as the other routes', async () => {
    const response = await adminApi('/payments/no-such-id');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('answers an unknown API path with a JSON 404, not the panel page', async () => {
    for (const init of [{}, { method: 'POST' }, { method: 'DELETE' }]) {
      const response = await adminApi('/no-such-route', init);
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
  });

  it('answers a panel file that does not exist with a JSON 404', async () => {
    const response = await asAdmin('/assets/no-such-file.js');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('answers a change that is not from a same-site page with { error: "Forbidden" } and 403, and changes nothing', async () => {
    const [id] = await seedPayments([{}]);
    const response = await adminApi(`/payments/${id}`, {
      method: 'DELETE',
      headers: { Origin: OTHER_SITE, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(await count('payments')).toBe(1);
  });

  describe('cross-site reading', () => {
    /**
     * Lists the CORS headers a response carries.
     * @param response - The response.
     * @returns The names of the headers that start with `access-control-`.
     */
    const corsHeaders = (response: Response): string[] => [...response.headers.keys()].filter((name) => name.startsWith('access-control-'));

    it('sends no CORS header on any answer, so browsers stop other sites from reading it', async () => {
      const [id] = await seedPayments([{}]);
      for (const path of ['/me', '/payments', `/payments/${id}`, '/callbacks', '/payments/no-such-id', '/no-such-route']) {
        const response = await adminApi(path, { headers: { Origin: OTHER_SITE } });
        expect(corsHeaders(response)).toEqual([]);
      }
    });

    it('answers a preflight from another site with no CORS header, whether or not it is signed in', async () => {
      const preflight = { method: 'OPTIONS', headers: { Origin: OTHER_SITE, 'Access-Control-Request-Method': 'DELETE' } };
      const signedIn = await adminApi('/payments/x', preflight);
      expect(signedIn.status).toBe(404);
      expect(corsHeaders(signedIn)).toEqual([]);
      const anonymous = await exports.default.fetch(`${ORIGIN}/admin/api/payments/x`, preflight);
      expect(anonymous.status).toBe(401);
      expect(corsHeaders(anonymous)).toEqual([]);
    });
  });

  it('answers an unexpected failure with { error } and 500, without its details', async () => {
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('D1 exploded: secret detail');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await adminApi('/payments');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('admin API: payments', () => {
  it('lists payments newest first, and by ID when they were created at the same time, with a summary of each', async () => {
    await seedPayments([
      { id: 'order-b', createdAt: at(10) },
      {
        id: 'order-new',
        createdAt: at(20),
        mode: 3,
        amountCents: 12345,
        customerName: 'Leah Adria',
        customerEmail: 'leah@example.com',
        customerReference: 'CUST-9',
        state: 'succeeded',
        reference: 'PA-1',
        gatewayStatus: 3,
        updatedAt: at(30),
      },
      { id: 'order-a', createdAt: at(10) },
      { id: 'order-oldest', createdAt: at(1) },
    ]);
    const { payments, nextBefore } = await (await adminApi('/payments')).json<PaymentList>();
    expect(payments.map((payment) => payment.id)).toEqual(['order-new', 'order-b', 'order-a', 'order-oldest']);
    expect(nextBefore).toBeNull();
    expect(payments[0]).toEqual({
      id: 'order-new',
      mode: 3,
      paymentAmount: 123.45,
      customerName: 'Leah Adria',
      customerEmail: 'leah@example.com',
      customerReference: 'CUST-9',
      state: 'succeeded',
      reference: 'PA-1',
      gatewayStatus: 3,
      createdAt: at(20),
      updatedAt: at(30),
      callbackCount: 0,
    });
  });

  it('counts a payment’s callbacks by their deliveries', async () => {
    const [first, second] = await seedPayments([{ createdAt: at(1) }, { createdAt: at(2) }]);
    await seedCallbacks([
      { paymentId: first, deliveries: 3 },
      { paymentId: first, deliveries: 1 },
      { paymentId: second, deliveries: 2 },
      { paymentId: null, deliveries: 9 },
    ]);
    const { payments } = await (await adminApi('/payments')).json<PaymentList>();
    expect(payments.find((payment) => payment.id === first)?.callbackCount).toBe(4);
    expect(payments.find((payment) => payment.id === second)?.callbackCount).toBe(2);
  });

  it('filters by state', async () => {
    await seedPayments([
      { id: 'p1', state: 'pending', createdAt: at(1) },
      { id: 'p2', state: 'succeeded', createdAt: at(2) },
      { id: 'p3', state: 'failed', createdAt: at(3) },
      { id: 'p4', state: 'succeeded', createdAt: at(4) },
    ]);
    const list = (query: string) => adminApi(`/payments${query}`).then((response) => response.json<PaymentList>());
    expect((await list('?state=succeeded')).payments.map((payment) => payment.id)).toEqual(['p4', 'p2']);
    expect((await list('?state=failed')).payments.map((payment) => payment.id)).toEqual(['p3']);
    expect((await list('?state=unverified')).payments).toHaveLength(0);
  });

  it.each(['?state=refunded', '?state=', '?state=PENDING', '?state=pending&state=failed'])(
    'refuses %s, which is not one payment state, with 400',
    async (query) => {
      const response = await adminApi(`/payments${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'state is not a payment state.' });
    },
  );

  it('refuses q sent twice, which is not text, with 400', async () => {
    const response = await adminApi('/payments?q=a&q=b');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'q must be text.' });
  });

  it('takes an empty q, an empty before and a parameter it does not know as no filter at all', async () => {
    await seedPayments([{ id: 'only', createdAt: at(1) }]);
    for (const query of ['?q=', '?before=', '?q=&before=', '?unknown=1', '?q=&unknown=x']) {
      const { payments, nextBefore } = await (await adminApi(`/payments${query}`)).json<PaymentList>();
      expect(payments.map((payment) => payment.id)).toEqual(['only']);
      expect(nextBefore).toBeNull();
    }
  });

  describe('search', () => {
    const search = async (q: string): Promise<string[]> =>
      (await (await adminApi(`/payments?q=${encodeURIComponent(q)}`)).json<PaymentList>()).payments.map((payment) => payment.id);

    beforeEach(async () => {
      await seedPayments([
        {
          id: 'id-alpha',
          createdAt: at(1),
          customerName: 'Leah Adria',
          customerEmail: 'leah@example.com',
          customerReference: 'CUST-100',
          reference: 'ZP-555',
        },
        {
          id: 'id-beta',
          createdAt: at(2),
          customerName: 'Sam Smith',
          customerEmail: 'sam@shop.example',
          customerReference: 'ORDER-200',
          reference: null,
        },
      ]);
    });

    it.each([
      ['the payment ID', 'id-alp', ['id-alpha']],
      ['the customer name', 'adria', ['id-alpha']],
      ['the customer email', '@shop.example', ['id-beta']],
      ['the customer reference', 'order-2', ['id-beta']],
      ['ZenPay’s reference', 'zp-555', ['id-alpha']],
    ])('matches %s, ignoring case', async (_field, q, expected) => {
      expect(await search(q)).toEqual(expected);
    });

    it('matches nothing for text no field holds', async () => {
      expect(await search('nothing-like-this')).toEqual([]);
    });

    it('treats % and _ as plain text, not wildcards', async () => {
      expect(await search('%')).toEqual([]);
      expect(await search('id_alpha')).toEqual([]);
    });

    it('searches text longer than D1’s 50 byte limit on a LIKE pattern', async () => {
      const long = 'x'.repeat(80);
      await seedPayments([{ id: 'id-long', createdAt: at(3), customerName: `${long} Name` }]);
      expect(await search(long)).toEqual(['id-long']);
    });

    it('uses only the first 100 characters of a longer q', async () => {
      await seedPayments([{ id: 'id-hundred', createdAt: at(3), customerName: 'x'.repeat(100) }]);
      // The extra characters are ignored, so this finds the payment; the same 100 characters with one changed do not.
      expect(await search(`${'x'.repeat(100)}-and-more-that-no-field-holds`)).toEqual(['id-hundred']);
      expect(await search(`${'x'.repeat(99)}y${'x'.repeat(60)}`)).toEqual([]);
    });

    it('combines with the state filter', async () => {
      await seedPayments([{ id: 'id-gamma', createdAt: at(3), customerName: 'Leah Other', state: 'failed' }]);
      const { payments } = await (await adminApi('/payments?q=leah&state=failed')).json<PaymentList>();
      expect(payments.map((payment) => payment.id)).toEqual(['id-gamma']);
    });
  });

  it('pages 50 at a time, newest first, with nextBefore leading to the rest', async () => {
    await seedPayments(
      Array.from({ length: 51 }, (_unused, index) => ({ id: `page-${String(index).padStart(2, '0')}`, createdAt: at(index) })),
    );
    const first = await (await adminApi('/payments')).json<PaymentList>();
    expect(first.payments).toHaveLength(50);
    expect(first.payments[0]?.id).toBe('page-50');
    expect(first.payments.at(-1)?.id).toBe('page-01');
    expect(first.nextBefore).toBe(`${at(1)}_page-01`);
    const second = await (await adminApi(`/payments?before=${encodeURIComponent(first.nextBefore!)}`)).json<PaymentList>();
    expect(second.payments.map((payment) => payment.id)).toEqual(['page-00']);
    expect(second.nextBefore).toBeNull();
  });

  it('pages through payments that share one timestamp without repeating or skipping one', async () => {
    const ids = Array.from({ length: 51 }, (_unused, index) => `same-${String(index).padStart(2, '0')}`);
    await seedPayments(ids.map((id) => ({ id, createdAt: at(5) })));
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const query: string = before === null ? '' : `?before=${encodeURIComponent(before)}`;
      const page = await (await adminApi(`/payments${query}`)).json<PaymentList>();
      seen.push(...page.payments.map((payment) => payment.id));
      before = page.nextBefore;
      pages += 1;
    } while (before !== null && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toEqual([...ids].reverse());
  });

  it('keeps the filters when it pages: a before cursor with a state and with a search', async () => {
    await seedPayments(
      Array.from({ length: 52 }, (_unused, index) => ({
        id: `mix-${String(index).padStart(2, '0')}`,
        createdAt: at(index),
        // Every even payment is succeeded and called Leah; the odd ones are failed and called Sam.
        state: index % 2 === 0 ? ('succeeded' as const) : ('failed' as const),
        customerName: index % 2 === 0 ? 'Leah' : 'Sam',
      })),
    );
    for (const filter of ['state=succeeded', 'q=leah', 'state=succeeded&q=leah']) {
      const first = await (await adminApi(`/payments?${filter}`)).json<PaymentList>();
      expect(first.payments.map((payment) => payment.id)).toEqual(
        Array.from({ length: 26 }, (_unused, index) => `mix-${String(50 - index * 2).padStart(2, '0')}`),
      );
      expect(first.nextBefore).toBeNull();
    }
    // 60 payments of one state: the first page is full, and the second holds the rest of that state only.
    await seedPayments(
      Array.from({ length: 60 }, (_unused, index) => ({ id: `more-${String(index).padStart(2, '0')}`, createdAt: at(index) })),
    );
    const page = await (await adminApi('/payments?state=pending')).json<PaymentList>();
    expect(page.payments).toHaveLength(50);
    const rest = await (await adminApi(`/payments?state=pending&before=${encodeURIComponent(page.nextBefore ?? '')}`)).json<PaymentList>();
    expect(rest.payments).toHaveLength(10);
    expect(rest.payments.every((payment) => payment.state === 'pending' && payment.id.startsWith('more-'))).toBe(true);
    expect(rest.nextBefore).toBeNull();
  });

  it('answers exactly 50 payments with no nextBefore', async () => {
    await seedPayments(Array.from({ length: 50 }, (_unused, index) => ({ createdAt: at(index) })));
    const { payments, nextBefore } = await (await adminApi('/payments')).json<PaymentList>();
    expect(payments).toHaveLength(50);
    expect(nextBefore).toBeNull();
  });

  it.each(['nonsense', '2026-03-01T00:00:00.000Z', '_x', 'a_b_c'])('refuses before=%s, which is not a cursor, with 400', async (before) => {
    const response = await adminApi(`/payments?before=${encodeURIComponent(before)}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'before is not a cursor from an earlier answer.' });
  });

  it('reads one payment with all its callbacks, newest first, with their bodies', async () => {
    const [id] = await seedPayments([{ id: 'detail-1', createdAt: at(1), state: 'processing' }]);
    await seedCallbacks([
      { id: 'cb-old', paymentId: id, receivedAt: at(10), body: '{"n":1}' },
      { id: 'cb-new', paymentId: id, receivedAt: at(20), body: '{"n":2}', outcome: 'unsigned', deliveries: 2, lastReceivedAt: at(25) },
      { id: 'cb-other', paymentId: null, receivedAt: at(30) },
    ]);
    const response = await adminApi(`/payments/${id}`);
    expect(response.status).toBe(200);
    const { payment } = await response.json<PaymentResponse>();
    expect(payment).toMatchObject({ id: 'detail-1', state: 'processing', callbackCount: 3 });
    expect(payment.callbacks).toEqual([
      {
        id: 'cb-new',
        paymentId: id,
        receivedAt: at(20),
        lastReceivedAt: at(25),
        deliveries: 2,
        outcome: 'unsigned',
        reason: null,
        size: 7,
        body: '{"n":2}',
      },
      {
        id: 'cb-old',
        paymentId: id,
        receivedAt: at(10),
        lastReceivedAt: at(10),
        deliveries: 1,
        outcome: 'verified',
        reason: null,
        size: 7,
        body: '{"n":1}',
      },
    ]);
  });

  it('answers 404 for a payment that does not exist', async () => {
    const response = await adminApi('/payments/no-such-id');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('shows a payment made through the checkout with the callbacks that reached it', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    await postCallback(launch.callbackUrl, callbackBody(scenario));
    const { payment } = await (await adminApi(`/payments/${scenario.mupid}`)).json<PaymentResponse>();
    expect(payment).toMatchObject({
      id: scenario.mupid,
      mode: 0,
      paymentAmount: 150.53,
      customerName: 'Leah Adria',
      state: 'succeeded',
      reference: scenario.reference,
      gatewayStatus: 3,
      callbackCount: 1,
    });
    expect(payment.callbacks).toMatchObject([{ outcome: 'verified', deliveries: 1 }]);
  });

  it('deletes a payment with its callbacks, and leaves the others', async () => {
    const [target, other] = await seedPayments([{ createdAt: at(1) }, { createdAt: at(2) }]);
    await seedCallbacks([{ paymentId: target }, { paymentId: target }, { paymentId: other }, { paymentId: null }]);
    expect((await adminApi(`/payments/${target}`, { method: 'DELETE' })).status).toBe(204);
    expect(await paymentRow(target)).toBeNull();
    expect(await callbackRows(target)).toHaveLength(0);
    expect(await callbackRows(other)).toHaveLength(1);
    expect(await callbackRows(null)).toHaveLength(1);
    expect(await count('payments')).toBe(1);
  });

  it('stops answering for a deleted payment, and keeps what ZenPay later sends for it as a callback with no payment', async () => {
    const scenario = SCENARIOS[0];
    const launch = await startCheckout(scenario);
    expect((await adminApi(`/payments/${scenario.mupid}`, { method: 'DELETE' })).status).toBe(204);
    expect((await getStatus(scenario.mupid)).status).toBe(404);
    expect((await postCallback(launch.callbackUrl, callbackBody(scenario))).status).toBe(200);
    expect(await callbackRows(null)).toMatchObject([{ outcome: 'rejected' }]);
  });

  it('answers 204 when the payment is already gone', async () => {
    expect((await adminApi('/payments/no-such-id', { method: 'DELETE' })).status).toBe(204);
  });
});

describe('admin API: callbacks', () => {
  it('lists every callback newest first, those with no payment too, without bodies', async () => {
    const [id] = await seedPayments([{}]);
    await seedCallbacks([
      { id: 'c1', paymentId: id, receivedAt: at(10) },
      { id: 'c2', paymentId: null, receivedAt: at(30), outcome: 'rejected', reason: 'The callback address has no token.', body: 'abc' },
      { id: 'c3', paymentId: id, receivedAt: at(20), outcome: 'unsigned', deliveries: 2, lastReceivedAt: at(21) },
    ]);
    const { callbacks, nextBefore } = await (await adminApi('/callbacks')).json<CallbackList>();
    expect(callbacks.map((callback) => callback.id)).toEqual(['c2', 'c3', 'c1']);
    expect(nextBefore).toBeNull();
    expect(callbacks[0]).toEqual({
      id: 'c2',
      paymentId: null,
      receivedAt: at(30),
      lastReceivedAt: at(30),
      deliveries: 1,
      outcome: 'rejected',
      reason: 'The callback address has no token.',
      size: 3,
    });
    expect(callbacks[0]).not.toHaveProperty('body');
  });

  it('filters by outcome', async () => {
    await seedCallbacks([
      { id: 'v', outcome: 'verified', receivedAt: at(1) },
      { id: 'u', outcome: 'unsigned', receivedAt: at(2) },
      { id: 'r1', outcome: 'rejected', receivedAt: at(3) },
      { id: 'r2', outcome: 'rejected', receivedAt: at(4) },
    ]);
    const list = (outcome: string) => adminApi(`/callbacks?outcome=${outcome}`).then((response) => response.json<CallbackList>());
    expect((await list('rejected')).callbacks.map((callback) => callback.id)).toEqual(['r2', 'r1']);
    expect((await list('verified')).callbacks.map((callback) => callback.id)).toEqual(['v']);
    expect((await list('unsigned')).callbacks.map((callback) => callback.id)).toEqual(['u']);
  });

  it.each(['?outcome=accepted', '?outcome=', '?outcome=VERIFIED', '?outcome=verified&outcome=rejected'])(
    'refuses %s, which is not one callback outcome, with 400',
    async (query) => {
      const response = await adminApi(`/callbacks${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'outcome is not a callback outcome.' });
    },
  );

  it('takes an empty before and a parameter it does not know as no filter at all', async () => {
    await seedCallbacks([{ id: 'only', receivedAt: at(1) }]);
    for (const query of ['?before=', '?unknown=1']) {
      const { callbacks, nextBefore } = await (await adminApi(`/callbacks${query}`)).json<CallbackList>();
      expect(callbacks.map((callback) => callback.id)).toEqual(['only']);
      expect(nextBefore).toBeNull();
    }
  });

  it('pages through callbacks that share one timestamp without repeating or skipping one', async () => {
    const ids = Array.from({ length: 51 }, (_unused, index) => `same-${String(index).padStart(2, '0')}`);
    await seedCallbacks(ids.map((id) => ({ id, receivedAt: at(5) })));
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const query: string = before === null ? '' : `?before=${encodeURIComponent(before)}`;
      const page = await (await adminApi(`/callbacks${query}`)).json<CallbackList>();
      seen.push(...page.callbacks.map((callback) => callback.id));
      before = page.nextBefore;
      pages += 1;
    } while (before !== null && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toEqual([...ids].reverse());
  });

  it('keeps the outcome filter when it pages', async () => {
    await seedCallbacks(
      Array.from({ length: 60 }, (_unused, index) => ({
        id: `rej-${String(index).padStart(2, '0')}`,
        receivedAt: at(index),
        outcome: index % 7 === 0 ? ('verified' as const) : ('rejected' as const),
      })),
    );
    const first = await (await adminApi('/callbacks?outcome=rejected')).json<CallbackList>();
    expect(first.callbacks).toHaveLength(50);
    const second = await (
      await adminApi(`/callbacks?outcome=rejected&before=${encodeURIComponent(first.nextBefore ?? '')}`)
    ).json<CallbackList>();
    // 60 callbacks, 9 of them verified: 51 rejected in all, so the second page holds the one the first could not.
    expect(second.callbacks).toHaveLength(1);
    expect(second.nextBefore).toBeNull();
    const ids = [...first.callbacks, ...second.callbacks].map((callback) => callback.id);
    expect(new Set(ids).size).toBe(51);
    expect([...first.callbacks, ...second.callbacks].every((callback) => callback.outcome === 'rejected')).toBe(true);
  });

  it('pages 50 at a time with nextBefore, and refuses a before that is not a cursor', async () => {
    await seedCallbacks(
      Array.from({ length: 51 }, (_unused, index) => ({ id: `cb-${String(index).padStart(2, '0')}`, receivedAt: at(index) })),
    );
    const first = await (await adminApi('/callbacks')).json<CallbackList>();
    expect(first.callbacks).toHaveLength(50);
    expect(first.nextBefore).toBe(`${at(1)}_cb-01`);
    const second = await (await adminApi(`/callbacks?before=${encodeURIComponent(first.nextBefore!)}`)).json<CallbackList>();
    expect(second.callbacks.map((callback) => callback.id)).toEqual(['cb-00']);
    expect(second.nextBefore).toBeNull();
    expect((await adminApi('/callbacks?before=nonsense')).status).toBe(400);
  });

  it('reads one callback with its body exactly as received', async () => {
    const body = '{"response":{"paymentReference":"PR-1"},\n "validationCode":"abc"}';
    await seedCallbacks([{ id: 'one', receivedAt: at(5), body }]);
    const response = await adminApi('/callbacks/one');
    expect(response.status).toBe(200);
    const { callback } = await response.json<CallbackResponse>();
    expect(callback).toMatchObject({ id: 'one', body, size: body.length, outcome: 'verified' });
  });

  it('answers 404 for a callback that does not exist', async () => {
    const response = await adminApi('/callbacks/no-such-id');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('has no way to change a callback', async () => {
    const [id] = await seedCallbacks([{}]);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await adminApi(`/callbacks/${id}`, { method })).status).toBe(404);
    }
    expect(await count('callbacks')).toBe(1);
  });
});
