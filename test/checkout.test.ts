import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutLaunch, PaymentMode } from '../src/shared/types';
import { ORIGIN } from './helpers/constants';
import {
  API_KEY,
  CALLBACK_TOKEN_SECRET,
  FROZEN_CLOCK,
  FROZEN_TIMESTAMP,
  MERCHANT_CODE,
  PASSWORD,
  REDIRECT_URL,
  SCENARIOS,
  TOKENISE_WITH_AMOUNT,
  SECOND_SHOP_ORIGIN,
  SHOP_ORIGIN,
  USERNAME,
} from './helpers/zenpay-fixtures';
import { atTime, paymentRow, postCheckout, randomIp, requestFor, send, startCheckout } from './helpers/zenpay';

const MODES: PaymentMode[] = [0, 1, 2, 3];

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Counts the payments in the database.
 * @returns How many there are.
 */
const countPayments = async (): Promise<number> =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM payments').first<{ n: number }>())?.n ?? 0;

/**
 * Reads the payload of a callback address token without the package that made it: the token is the
 * base64url JSON of the claims followed by a 32 character signature, with `m`, `u`, `t` and `a` for the fixed keys.
 * @param callbackUrl - The launch's callback address.
 * @returns The claims.
 */
const claimsOf = (callbackUrl: string): Record<string, unknown> => {
  const token = new URL(callbackUrl).searchParams.get('t') ?? '';
  const body = token.slice(0, -32).replaceAll('-', '+').replaceAll('_', '/');
  return JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4, '='))) as Record<string, unknown>;
};

describe('POST /api/checkout', () => {
  // The expected fingerprints are precomputed with Node's SHA3-512 from the documented pipe string
  // (test/helpers/zenpay-fixtures.ts, checked by test/global-setup.ts). The clock and the payment ID are fixed, so the
  // route has to produce exactly that value: no `@zp-hcp/server` call is involved in the expectation.
  it.each(MODES)('returns the independently computed fingerprint for mode %i', async (mode) => {
    const scenario = SCENARIOS[mode];
    const launch = await startCheckout(scenario);
    expect(launch.fingerprint).toBe(scenario.fingerprint.sha3);
    expect(launch).toMatchObject({
      url: env.ZENPAY_CHECKOUT_URL,
      apiKey: API_KEY,
      merchantCode: MERCHANT_CODE,
      timestamp: FROZEN_TIMESTAMP,
      merchantUniquePaymentId: scenario.mupid,
      mode,
      paymentAmount: scenario.paymentAmount,
      customerName: 'Leah Adria',
      customerEmail: 'leah@example.com',
      customerReference: 'CUST-1001',
    });
    expect(launch.callbackUrl).toMatch(new RegExp(`^${ORIGIN}/callbacks/zenpay\\?t=[A-Za-z0-9_-]+$`));
    expect(launch.redirectUrl).toBe(REDIRECT_URL);
  });

  it('hashes the amount of a mode 1 launch that has one in whole cents', async () => {
    const launch = await startCheckout(TOKENISE_WITH_AMOUNT);
    expect(launch.fingerprint).toBe(TOKENISE_WITH_AMOUNT.fingerprint.sha3);
    expect(launch.paymentAmount).toBe(25.5);
  });

  it('never sends the ZenPay username, password or the callback signing secret to the browser', async () => {
    const response = await postCheckout(requestFor(SCENARIOS[0]));
    const text = await response.text();
    for (const secret of [USERNAME, PASSWORD, CALLBACK_TOKEN_SECRET]) {
      expect(text).not.toContain(secret);
    }
  });

  it('stores the attempt as a pending payment, with the amount in whole cents', async () => {
    const launch = await startCheckout(SCENARIOS[0]);
    expect(await paymentRow(launch.merchantUniquePaymentId)).toMatchObject({
      mode: 0,
      amount_cents: 15053,
      customer_name: 'Leah Adria',
      customer_email: 'leah@example.com',
      customer_reference: 'CUST-1001',
      state: 'pending',
      reference: null,
      gateway_status: null,
      created_at: FROZEN_CLOCK,
      updated_at: FROZEN_CLOCK,
    });
  });

  it('makes a new payment ID for every attempt', async () => {
    const first = await (await postCheckout(requestFor(SCENARIOS[0]))).json<CheckoutLaunch>();
    const second = await (await postCheckout(requestFor(SCENARIOS[0]))).json<CheckoutLaunch>();
    expect(first.merchantUniquePaymentId).not.toBe(second.merchantUniquePaymentId);
    expect(first.callbackUrl).not.toBe(second.callbackUrl);
    expect(first.merchantUniquePaymentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('puts mode, payment ID, timestamp and amount in the callback address token, valid for 7 days', async () => {
    const scenario = SCENARIOS[2];
    const launch = await startCheckout(scenario);
    const claims = claimsOf(launch.callbackUrl);
    expect(claims).toMatchObject({ m: 2, u: scenario.mupid, t: FROZEN_TIMESTAMP, a: scenario.paymentAmount });
    expect(claims.exp).toBe((claims.iat as number) + 7 * 24 * 60 * 60);
    expect(claims.iat).toBe(Math.floor(Date.parse(FROZEN_CLOCK) / 1000));
  });

  it('builds the callback address on the address it was called on', async () => {
    const launch = await (await postCheckout(requestFor(SCENARIOS[0]))).json<CheckoutLaunch>();
    expect(new URL(launch.callbackUrl).origin).toBe(ORIGIN);
  });

  it('carries REDIRECT_URL in the launch, and does not hash it into the fingerprint', async () => {
    const response = await postCheckout(requestFor(SCENARIOS[0]), { vars: { REDIRECT_URL: 'https://shop.ianmenethil.com/other' } });
    expect(response.status).toBe(200);
    expect((await response.json<CheckoutLaunch>()).redirectUrl).toBe('https://shop.ianmenethil.com/other');
    // The fixtures' fingerprints were made without it, and still match with it.
    expect((await startCheckout(SCENARIOS[0])).fingerprint).toBe(SCENARIOS[0].fingerprint.sha3);
  });

  it('answers with no-store and the CORS headers for the calling shop', async () => {
    const response = await postCheckout(requestFor(SCENARIOS[0]));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SHOP_ORIGIN);
    expect(response.headers.get('Vary')).toContain('Origin');
  });

  it('serves every origin in ALLOWED_ORIGINS', async () => {
    const response = await postCheckout(requestFor(SCENARIOS[0]), { origin: SECOND_SHOP_ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SECOND_SHOP_ORIGIN);
  });

  describe('validation', () => {
    const valid = requestFor(SCENARIOS[0]);

    it.each([
      ['a body that is not an object', 'null', 'The request body must be a JSON object.'],
      ['a body that is an array', '[]', 'The request body must be a JSON object.'],
      ['malformed JSON', '{oops', 'Malformed JSON in request body'],
      ['a missing mode', JSON.stringify({ ...valid, mode: undefined }), 'mode must be 0, 1, 2 or 3.'],
      ['mode 4', JSON.stringify({ ...valid, mode: 4 }), 'mode must be 0, 1, 2 or 3.'],
      ['a mode that is text', JSON.stringify({ ...valid, mode: '0' }), 'mode must be 0, 1, 2 or 3.'],
      [
        'an amount that is text',
        JSON.stringify({ ...valid, paymentAmount: '10' }),
        'paymentAmount must be a number of dollars with at most 2 decimals.',
      ],
      [
        'a missing amount',
        JSON.stringify({ ...valid, paymentAmount: undefined }),
        'paymentAmount must be a number of dollars with at most 2 decimals.',
      ],
      [
        'an amount with 3 decimals',
        JSON.stringify({ ...valid, paymentAmount: 1.005 }),
        'paymentAmount must be a number of dollars with at most 2 decimals.',
      ],
      [
        'a negative amount',
        JSON.stringify({ ...valid, paymentAmount: -5 }),
        'paymentAmount must be a number of dollars with at most 2 decimals.',
      ],
      [
        'an amount in exponent form',
        JSON.stringify({ ...valid, paymentAmount: 1e-7 }),
        'paymentAmount must be a number of dollars with at most 2 decimals.',
      ],
      [
        'an enormous amount',
        JSON.stringify({ ...valid, paymentAmount: 99_999_999 }),
        'paymentAmount must be a number of dollars with at most 2 decimals.',
      ],
      [
        'an amount of 0 for mode 0',
        JSON.stringify({ ...valid, paymentAmount: 0 }),
        'paymentAmount must be greater than 0 for modes 0, 2 and 3.',
      ],
      [
        'an amount of 0 for mode 2',
        JSON.stringify({ ...valid, mode: 2, paymentAmount: 0 }),
        'paymentAmount must be greater than 0 for modes 0, 2 and 3.',
      ],
      [
        'an amount of 0 for mode 3',
        JSON.stringify({ ...valid, mode: 3, paymentAmount: 0 }),
        'paymentAmount must be greater than 0 for modes 0, 2 and 3.',
      ],
      ['a missing customer name for mode 0', JSON.stringify({ ...valid, customerName: undefined }), 'customerName must be text.'],
      ['a blank customer name for mode 0', JSON.stringify({ ...valid, customerName: '   ' }), 'customerName is required for this mode.'],
      [
        'a blank customer reference for mode 2',
        JSON.stringify({ ...valid, mode: 2, customerReference: '' }),
        'customerReference is required for this mode.',
      ],
      [
        'a customer name of 101 characters',
        JSON.stringify({ ...valid, customerName: 'a'.repeat(101) }),
        'customerName must be at most 100 characters.',
      ],
      [
        'a customer reference of 101 characters',
        JSON.stringify({ ...valid, customerReference: 'a'.repeat(101) }),
        'customerReference must be at most 100 characters.',
      ],
      [
        'a control character in the name',
        JSON.stringify({ ...valid, customerName: 'Leah\u0000Adria' }),
        'customerName must not contain control characters.',
      ],
      ['a missing email', JSON.stringify({ ...valid, customerEmail: undefined }), 'customerEmail must be text.'],
      ['an email without an @', JSON.stringify({ ...valid, customerEmail: 'leah.example.com' }), 'customerEmail must be an email address.'],
      [
        'an email with a space',
        JSON.stringify({ ...valid, customerEmail: 'le ah@example.com' }),
        'customerEmail must be an email address.',
      ],
      [
        'an email of 255 characters',
        JSON.stringify({ ...valid, customerEmail: `${'a'.repeat(243)}@example.com` }),
        'customerEmail must be at most 254 characters.',
      ],
    ])('refuses %s with 400', async (_case, body, error) => {
      const before = await countPayments();
      const response = await postCheckout(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
      expect(await countPayments()).toBe(before);
    });

    it.each([
      ['malformed JSON', '{"mode":0,', 'Malformed JSON in request body'],
      ['an empty body', '', 'Malformed JSON in request body'],
      ['a string', '"text"', 'The request body must be a JSON object.'],
      ['a number', '5', 'The request body must be a JSON object.'],
      [
        'an amount beyond what a number holds (1e999 is infinite)',
        '{"mode":0,"paymentAmount":1e999,"customerName":"A","customerEmail":"a@example.com","customerReference":"R"}',
        'paymentAmount must be a number of dollars with at most 2 decimals.',
      ],
    ])('refuses %s with 400 and stores nothing', async (_case, body, error) => {
      const response = await postCheckout(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
      expect(await countPayments()).toBe(0);
    });

    // The body is read as JSON only when it says it is; a page that leaves the header off gets 400, not a guess.
    it('does not read a body that is not sent as application/json', async () => {
      const response = await postCheckout(JSON.stringify(valid), { headers: { 'Content-Type': 'text/plain' } });
      expect(response.status).toBe(400);
      expect(await countPayments()).toBe(0);
    });

    it('answers with the first thing wrong when several are', async () => {
      const response = await postCheckout({ mode: 0, paymentAmount: 'x', customerName: '', customerEmail: 'no', customerReference: '' });
      expect(await response.json()).toEqual({ error: 'paymentAmount must be a number of dollars with at most 2 decimals.' });
    });

    it('accepts the largest amount, and refuses one cent more', async () => {
      const largest = await postCheckout({ ...valid, paymentAmount: 10_000_000 });
      expect(largest.status).toBe(200);
      expect(await largest.json<CheckoutLaunch>()).toMatchObject({ paymentAmount: 10_000_000 });
      const over = await postCheckout({ ...valid, paymentAmount: 10_000_000.01 });
      expect(over.status).toBe(400);
      expect(await over.json()).toEqual({ error: 'paymentAmount must be a number of dollars with at most 2 decimals.' });
    });

    it('accepts the smallest amount, one cent', async () => {
      const response = await postCheckout({ ...valid, paymentAmount: 0.01 });
      expect(response.status).toBe(200);
      expect((await paymentRow((await response.json<CheckoutLaunch>()).merchantUniquePaymentId))?.amount_cents).toBe(1);
    });

    it('accepts a customer name and reference of 100 characters and an email of 254, and refuses one more of each', async () => {
      const email = `${'a'.repeat(242)}@example.com`;
      expect(email).toHaveLength(254);
      const ok = await postCheckout({ ...valid, customerName: 'n'.repeat(100), customerReference: 'r'.repeat(100), customerEmail: email });
      expect(ok.status).toBe(200);
      expect(await ok.json<CheckoutLaunch>()).toMatchObject({
        customerName: 'n'.repeat(100),
        customerReference: 'r'.repeat(100),
        customerEmail: email,
      });
      for (const [field, value, error] of [
        ['customerName', 'n'.repeat(101), 'customerName must be at most 100 characters.'],
        ['customerReference', 'r'.repeat(101), 'customerReference must be at most 100 characters.'],
        ['customerEmail', `${'a'.repeat(243)}@example.com`, 'customerEmail must be at most 254 characters.'],
      ] as const) {
        const refused = await postCheckout({ ...valid, [field]: value });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error });
      }
    });

    // A tab or a newline at the start or end of a field is trimmed away; inside it is refused. DEL is not whitespace, so it is refused anywhere.
    it.each(
      (['customerName', 'customerReference', 'customerEmail'] as const).flatMap((field) =>
        (
          [
            ['a tab', '\t'],
            ['a newline', '\n'],
            ['a DEL character', '\u007f'],
          ] as const
        ).map(
          ([name, character]) =>
            [field, name, field === 'customerEmail' ? `le${character}ah@example.com` : `Leah${character}Adria`] as const,
        ),
      ),
    )('refuses %s with %s inside it', async (field, _name, value) => {
      const response = await postCheckout({ ...valid, [field]: value });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: `${field} must not contain control characters.` });
      expect(await countPayments()).toBe(0);
    });

    it('trims a tab or newline off the ends of a text field', async () => {
      const response = await postCheckout({ ...valid, customerName: '\tLeah Adria\n' });
      expect(response.status).toBe(200);
      expect((await response.json<CheckoutLaunch>()).customerName).toBe('Leah Adria');
    });

    it('ignores fields it does not know, so nothing a page adds reaches the launch', async () => {
      const scenario = SCENARIOS[0];
      vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(scenario.mupid);
      const response = await atTime(FROZEN_CLOCK, () =>
        postCheckout({
          ...requestFor(scenario),
          callbackUrl: 'https://attacker.example/steal',
          redirectUrl: 'https://attacker.example/phish',
          merchantUniquePaymentId: 'attacker-chosen-id',
          fingerprint: 'f'.repeat(128),
          apiKey: 'attacker-key',
          merchantCode: 'AttackerCode',
          url: 'https://attacker.example/online/v5',
          timestamp: '2000-01-01T00:00:00',
        }),
      );
      expect(response.status).toBe(200);
      const launch = await response.json<CheckoutLaunch>();
      expect(launch.fingerprint).toBe(scenario.fingerprint.sha3);
      expect(launch.merchantUniquePaymentId).toBe(scenario.mupid);
      expect(launch.callbackUrl).toMatch(new RegExp(`^${ORIGIN}/callbacks/zenpay\\?t=`));
      expect(launch).toMatchObject({
        apiKey: API_KEY,
        merchantCode: MERCHANT_CODE,
        url: env.ZENPAY_CHECKOUT_URL,
        timestamp: FROZEN_TIMESTAMP,
      });
      expect(launch.redirectUrl).toBe(REDIRECT_URL);
      expect(await paymentRow('attacker-chosen-id')).toBeNull();
      expect(await paymentRow(scenario.mupid)).not.toBeNull();
    });

    it('accepts an amount of 0 for mode 1, and no name or reference for modes 1 and 3', async () => {
      const tokenise = await postCheckout({
        mode: 1,
        paymentAmount: 0,
        customerName: '',
        customerEmail: 'a@example.com',
        customerReference: '',
      });
      expect(tokenise.status).toBe(200);
      const preauth = await postCheckout({
        mode: 3,
        paymentAmount: 10,
        customerName: '',
        customerEmail: 'a@example.com',
        customerReference: '',
      });
      expect(preauth.status).toBe(200);
    });

    it('accepts amounts with one or two decimals, and trims text fields', async () => {
      const response = await postCheckout({ ...valid, paymentAmount: 0.07, customerName: '  Leah Adria  ' });
      expect(response.status).toBe(200);
      const launch = await response.json<CheckoutLaunch>();
      expect(launch.customerName).toBe('Leah Adria');
      expect((await paymentRow(launch.merchantUniquePaymentId))?.amount_cents).toBe(7);
    });

    it('stores a fractional amount of cents exactly', async () => {
      const launch = await (await postCheckout({ ...valid, paymentAmount: 149.99 })).json<CheckoutLaunch>();
      expect((await paymentRow(launch.merchantUniquePaymentId))?.amount_cents).toBe(14999);
    });

    it('refuses a body over 8 KB with 413', async () => {
      const response = await postCheckout({ ...valid, customerName: 'a'.repeat(9000) });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Payload too large' });
    });

    it('stores nothing and answers 400 when ZenPay’s own launch rules refuse the request', async () => {
      // The Worker's check lets this email through; the launch check (`ZpAuthoriseRequestSchema`) is stricter.
      const response = await postCheckout({ ...valid, customerEmail: 'leah@example..com' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) as unknown });
      expect(await countPayments()).toBe(0);
    });
  });

  describe('configuration', () => {
    // The caller is a shopper's browser, which cannot fix the Worker's settings, so the answer names none of them;
    // the log does.
    it.each([
      ['ZENPAY_API_KEY', { ZENPAY_API_KEY: '' }],
      ['ZENPAY_USERNAME', { ZENPAY_USERNAME: ' ' }],
      ['ZENPAY_PASSWORD', { ZENPAY_PASSWORD: '' }],
      ['ZENPAY_MERCHANT_CODE', { ZENPAY_MERCHANT_CODE: '' }],
      ['ZENPAY_CHECKOUT_URL', { ZENPAY_CHECKOUT_URL: '' }],
      ['REDIRECT_URL', { REDIRECT_URL: '' }],
      ['CALLBACK_TOKEN_SECRET', { CALLBACK_TOKEN_SECRET: '' }],
    ])('answers a JSON 500 that names nothing when %s is not set, logs the name, and stores nothing', async (name, vars) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Not configured' });
      expect(logged).toHaveBeenCalledExactlyOnceWith(`Not configured: set ${name}.`);
      expect(await countPayments()).toBe(0);
    });

    // A setting that is missing from the environment, empty, or only spaces is not set.
    it.each([undefined, '', '   '])('treats ZENPAY_MERCHANT_CODE as not set when it is %j', async (value) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars: { ZENPAY_MERCHANT_CODE: value } });
      expect(response.status).toBe(500);
      expect(logged).toHaveBeenCalledExactlyOnceWith('Not configured: set ZENPAY_MERCHANT_CODE.');
    });

    it('logs every missing setting at once', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars: { ZENPAY_API_KEY: '', ZENPAY_MERCHANT_CODE: '' } });
      expect(await response.json()).toEqual({ error: 'Not configured' });
      expect(logged).toHaveBeenCalledExactlyOnceWith('Not configured: set ZENPAY_API_KEY, ZENPAY_MERCHANT_CODE.');
    });

    it('answers a JSON 500 that names nothing when CALLBACK_TOKEN_SECRET is under 32 bytes, and accepts exactly 32', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars: { CALLBACK_TOKEN_SECRET: 'x'.repeat(31) } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Not configured' });
      expect(logged).toHaveBeenCalledExactlyOnceWith('Not configured: set CALLBACK_TOKEN_SECRET (at least 32 bytes).');
      expect((await postCheckout(requestFor(SCENARIOS[0]), { vars: { CALLBACK_TOKEN_SECRET: 'x'.repeat(32) } })).status).toBe(200);
    });

    it('answers a JSON 500, not a crash, when a credential is too short for ZenPay’s fingerprint, and logs why', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars: { ZENPAY_PASSWORD: 'abc' } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Not configured' });
      expect(logged).toHaveBeenCalledExactlyOnceWith('Not configured: password must be at least 5 characters');
      expect(await countPayments()).toBe(0);
    });

    it.each([
      [
        'a checkout address that is not a ZenPay one',
        { ZENPAY_CHECKOUT_URL: 'https://evil.example.com/online/v5' },
        'Not configured: ZENPAY_CHECKOUT_URL. Must be a valid Zenith HCP endpoint (e.g. https://pay.sandbox.b2bpay.com.au/Online/v5)',
      ],
      ['a redirect address that is not a URL', { REDIRECT_URL: 'not a url' }, 'Not configured: REDIRECT_URL. Must be a valid absolute URL'],
    ])('answers a JSON 500 that names nothing for %s, and logs which setting', async (_case, vars, log) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Not configured' });
      expect(logged).toHaveBeenCalledExactlyOnceWith(log);
      expect(await countPayments()).toBe(0);
    });

    // ZenPay's launch rules need a redirectUrl: a launch without one leaves the modal open after the payment.
    it.each([undefined, '', '   '])('refuses a checkout when REDIRECT_URL is %j, storing nothing', async (value) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars: { REDIRECT_URL: value } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Not configured' });
      expect(logged).toHaveBeenCalledExactlyOnceWith('Not configured: set REDIRECT_URL.');
      expect(await countPayments()).toBe(0);
    });

    it('trims the checkout address and the merchant code it hands to the page', async () => {
      const response = await postCheckout(requestFor(SCENARIOS[0]), {
        vars: { ZENPAY_CHECKOUT_URL: ` ${env.ZENPAY_CHECKOUT_URL} `, ZENPAY_MERCHANT_CODE: `  ${MERCHANT_CODE}  ` },
      });
      expect(response.status).toBe(200);
      expect(await response.json<CheckoutLaunch>()).toMatchObject({ url: env.ZENPAY_CHECKOUT_URL, merchantCode: MERCHANT_CODE });
    });
  });

  describe('origin', () => {
    it('refuses every request until ALLOWED_ORIGINS is set, the preflight included, naming no setting and logging it', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const options of [
        { method: 'POST', body: JSON.stringify(requestFor(SCENARIOS[0])) },
        { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } },
        { method: 'GET' },
      ]) {
        const response = await send('/api/checkout', { ...options, vars: { ALLOWED_ORIGINS: '' } });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Not configured' });
      }
      expect(logged).toHaveBeenCalledTimes(3);
      expect(logged).toHaveBeenCalledWith('Not configured: set ALLOWED_ORIGINS.');
      expect(await countPayments()).toBe(0);
    });

    it('refuses every request when ALLOWED_ORIGINS is not in the configuration at all', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { vars: { ALLOWED_ORIGINS: undefined } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Not configured' });
    });

    it('refuses an origin that is not listed, and stores nothing', async () => {
      const response = await postCheckout(requestFor(SCENARIOS[0]), { origin: 'https://evil.example.com' });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Origin not allowed' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(await countPayments()).toBe(0);
    });

    it.each([
      ['a different scheme', 'http://shop.ianmenethil.com'],
      ['a different port', 'https://shop.ianmenethil.com:8443'],
      ['a lookalike host', 'https://shop.ianmenethil.com.evil.example'],
      ['a path', 'https://shop.ianmenethil.com/'],
    ])('refuses %s', async (_case, origin) => {
      expect((await postCheckout(requestFor(SCENARIOS[0]), { origin })).status).toBe(403);
    });

    it('refuses a request with no Origin header', async () => {
      const response = await postCheckout(requestFor(SCENARIOS[0]), { origin: null });
      expect(response.status).toBe(403);
      expect(await countPayments()).toBe(0);
    });

    it('reads ALLOWED_ORIGINS as a comma separated list, with spaces and trailing slashes ignored', async () => {
      const vars = { ALLOWED_ORIGINS: ' https://one.example.com/ , https://two.example.com ' };
      expect((await postCheckout(requestFor(SCENARIOS[0]), { origin: 'https://one.example.com', vars })).status).toBe(200);
      expect((await postCheckout(requestFor(SCENARIOS[0]), { origin: 'https://two.example.com', vars })).status).toBe(200);
      expect((await postCheckout(requestFor(SCENARIOS[0]), { origin: SHOP_ORIGIN, vars })).status).toBe(403);
    });

    // What each kind of ALLOWED_ORIGINS entry means, and what an Origin header must be to match.
    it.each([
      ['an entry that is not a URL, kept as written', 'not a url', SHOP_ORIGIN, 403, 'Origin not allowed'],
      ['an entry that is not a URL beside a real one', 'not a url, https://shop.ianmenethil.com', SHOP_ORIGIN, 200, undefined],
      ['nothing but commas and spaces', ' , ,, ', SHOP_ORIGIN, 403, 'Not configured'],
      ['an upper-case scheme and host in the entry', 'HTTPS://SHOP.IanMenethil.COM', SHOP_ORIGIN, 200, undefined],
      ['the default port written in the entry', 'https://shop.ianmenethil.com:443', SHOP_ORIGIN, 200, undefined],
      ['a path in the entry, which is dropped', 'https://shop.ianmenethil.com/checkout/page?x=1', SHOP_ORIGIN, 200, undefined],
      ['a non-default port in the entry', 'https://shop.ianmenethil.com:8443', SHOP_ORIGIN, 403, 'Origin not allowed'],
      [
        'an upper-case host in the Origin header, which browsers never send',
        SHOP_ORIGIN,
        'https://SHOP.ianmenethil.com',
        403,
        'Origin not allowed',
      ],
      [
        'the default port in the Origin header, which browsers never send',
        SHOP_ORIGIN,
        'https://shop.ianmenethil.com:443',
        403,
        'Origin not allowed',
      ],
      ['Origin: null, as a sandboxed frame or a local file sends it', SHOP_ORIGIN, 'null', 403, 'Origin not allowed'],
    ])('reads %s', async (_case, allowed, origin, status, error) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postCheckout(requestFor(SCENARIOS[0]), { origin, vars: { ALLOWED_ORIGINS: allowed } });
      expect(response.status).toBe(status);
      if (error !== undefined) {
        expect(await response.json()).toEqual({ error });
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      }
    });

    it('answers the CORS preflight of an allowed origin with the methods and headers the page needs', async () => {
      const response = await send('/api/checkout', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SHOP_ORIGIN);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
      expect(response.headers.get('Access-Control-Max-Age')).toBe('600');
    });

    it('refuses the preflight of an origin that is not listed', async () => {
      const response = await send('/api/checkout', {
        method: 'OPTIONS',
        origin: 'https://evil.example.com',
        headers: { 'Access-Control-Request-Method': 'POST' },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('does not count preflights against the visitor’s rate limit', async () => {
      const ip = randomIp();
      for (let index = 0; index < 15; index += 1) {
        expect((await send('/api/checkout', { method: 'OPTIONS', ip, headers: { 'Access-Control-Request-Method': 'POST' } })).status).toBe(
          204,
        );
      }
      expect((await postCheckout(requestFor(SCENARIOS[0]), { ip })).status).toBe(200);
    });

    it('answers 404 JSON to a path under /api/checkout that is not a route', async () => {
      const response = await send('/api/checkout/anything/else', { method: 'POST' });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
    });
  });

  describe('rate limit', () => {
    it('answers 429 after 10 requests a minute from one address, without blocking another address', async () => {
      const ip = randomIp();
      const statuses: number[] = [];
      for (let index = 0; index < 11; index += 1) {
        statuses.push((await postCheckout(requestFor(SCENARIOS[0]), { ip })).status);
      }
      expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(200));
      expect(statuses[10]).toBe(429);
      expect((await postCheckout(requestFor(SCENARIOS[0]), { ip: randomIp() })).status).toBe(200);
      expect(await countPayments()).toBe(11);
    });

    it('keeps the 429 answer in the { error } shape, with the CORS headers so the page can read it', async () => {
      const ip = randomIp();
      for (let index = 0; index < 10; index += 1) {
        await postCheckout(requestFor(SCENARIOS[0]), { ip });
      }
      const response = await postCheckout(requestFor(SCENARIOS[0]), { ip });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'Too many requests' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SHOP_ORIGIN);
    });
  });

  describe('the launch', () => {
    const KEYS = [
      'redirectUrl',
      'apiKey',
      'callbackUrl',
      'customerEmail',
      'customerName',
      'customerReference',
      'fingerprint',
      'merchantCode',
      'merchantUniquePaymentId',
      'mode',
      'paymentAmount',
      'timestamp',
      'url',
    ];

    it('holds exactly the options the plugin needs and nothing else', async () => {
      const launch = await (await postCheckout(requestFor(SCENARIOS[0]))).json<Record<string, unknown>>();
      expect(Object.keys(launch).sort()).toEqual([...KEYS].sort());
    });
  });

  describe('when the database fails', () => {
    it('answers 500 with no launch and stores nothing', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const prepare = vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
        throw new Error('D1 is down: secret detail');
      });
      const response = await postCheckout(requestFor(SCENARIOS[0]));
      prepare.mockRestore();
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
      for (const leaked of ['fingerprint', 'callbackUrl', 'secret detail']) {
        expect(text).not.toContain(leaked);
      }
      expect(logged).toHaveBeenCalled();
      expect(await countPayments()).toBe(0);
    });
  });

  describe('the visitor’s address', () => {
    // A request with no CF-Connecting-IP, such as one under local development, shares one allowance.
    it.each([
      ['without CF-Connecting-IP', {}, 'CHECKOUT_LIMITER:unknown'],
      ['with CF-Connecting-IP', { 'CF-Connecting-IP': '203.0.113.7' }, 'CHECKOUT_LIMITER:203.0.113.7'],
    ])('counts a checkout %s under the key %s', async (_case, headers, key) => {
      const limit = vi.spyOn(env.CHECKOUT_LIMITER, 'limit').mockResolvedValue({ success: true });
      const response = await exports.default.fetch(`${ORIGIN}/api/checkout`, {
        method: 'POST',
        headers: { Origin: SHOP_ORIGIN, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(requestFor(SCENARIOS[0])),
      });
      expect(response.status).toBe(200);
      expect(limit).toHaveBeenCalledExactlyOnceWith({ key });
    });
  });

  it('writes the timestamp in UTC, to the second, with no zone', async () => {
    const later = '2026-12-31T23:59:59.999Z';
    const launch = await atTime(later, async () => (await postCheckout(requestFor(SCENARIOS[0]))).json<CheckoutLaunch>());
    expect(launch.timestamp).toBe('2026-12-31T23:59:59');
  });
});
