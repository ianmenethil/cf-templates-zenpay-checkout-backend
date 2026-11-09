import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/worker/env';
import { CERTS_CACHE_SECONDS, requireAccess } from '../src/worker/lib/access';
import { sign } from 'hono/jwt';
import {
  ADMIN_EMAIL,
  CERTS_URL,
  KEY_ID,
  accessToken,
  accessTokenFromUnknownKey,
  publicJwk,
  requestUrl,
  serveAccessKeys,
} from './helpers/access';
import { AUD, TEAM_DOMAIN } from './helpers/constants';

const app = new Hono<AppEnv>();
app.use(requireAccess);
app.get('/admin', (c) => c.text(c.get('adminEmail')));

/** Execution context without `ctx.access`, as when the runtime does not provide it. */
const plainCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

const configured = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };

/**
 * Calls the test app.
 * @param env - Admin settings.
 * @param headers - Request headers.
 * @param ctx - Execution context.
 * @returns The response.
 */
const call = (env: Partial<CloudflareBindings>, headers: HeadersInit = {}, ctx: ExecutionContext = plainCtx) =>
  app.request('/admin', { headers }, env, ctx);

beforeEach(serveAccessKeys);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requireAccess', () => {
  it('refuses every request until ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, naming no setting and logging them', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await call({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' }, { 'Cf-Access-Jwt-Assertion': await accessToken() });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Admin is not configured' });
    expect(logged).toHaveBeenCalledExactlyOnceWith('Admin is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD.');
  });

  it.each([
    ['ACCESS_AUD', { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: '' }],
    ['ACCESS_TEAM_DOMAIN', { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD }],
    ['both, left out of the environment', {}],
  ])('refuses every request when only %s is missing', async (_case, env) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await call(env, { 'Cf-Access-Jwt-Assertion': await accessToken() });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Admin is not configured' });
  });

  it('accepts ctx.access for this application and uses its email', async () => {
    const ctx = { ...plainCtx, access: { aud: AUD, getIdentity: () => Promise.resolve({ email: 'sam@ianmenethil.com' }) } };
    const response = await call(configured, {}, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('sam@ianmenethil.com');
  });

  it('names the user "admin" when ctx.access knows no identity, or one with no email', async () => {
    for (const identity of [undefined, {}]) {
      const ctx = { ...plainCtx, access: { aud: AUD, getIdentity: () => Promise.resolve(identity) } };
      const response = await call(configured, {}, ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('admin');
    }
  });

  it('refuses ctx.access for a different application', async () => {
    const ctx = { ...plainCtx, access: { aud: 'other-app', getIdentity: () => Promise.resolve(undefined) } };
    const response = await call(configured, {}, ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });

  it('refuses a request with no Access token', async () => {
    const response = await call(configured);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Sign in through Cloudflare Access to use the admin panel.' });
  });

  it('ignores trailing slashes on ACCESS_TEAM_DOMAIN, in the keys URL and in the issuer it checks', async () => {
    const token = await accessToken();
    const response = await call({ ACCESS_TEAM_DOMAIN: `${TEAM_DOMAIN}//`, ACCESS_AUD: AUD }, { 'Cf-Access-Jwt-Assertion': token });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ADMIN_EMAIL);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => requestUrl(input) === CERTS_URL)).toBe(true);
  });

  it('treats an ACCESS_TEAM_DOMAIN that is only slashes as not set', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await call({ ACCESS_TEAM_DOMAIN: '/', ACCESS_AUD: AUD });
    expect(response.status).toBe(403);
  });

  it('accepts a valid Access token and uses its email', async () => {
    const response = await call(configured, { 'Cf-Access-Jwt-Assertion': await accessToken() });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ADMIN_EMAIL);
  });

  // Miniflare does not emulate Cloudflare's edge cache, so the test cannot count real fetches to the
  // certs URL; it checks that every key fetch asks the edge cache to keep the response for 5 minutes. How many
  // fetches a verification makes is the verifier's business, so only that there are some is asserted.
  it('asks Cloudflare to cache the signing keys instead of fetching them on every request', async () => {
    const token = await accessToken();
    await call(configured, { 'Cf-Access-Jwt-Assertion': token });
    await call(configured, { 'Cf-Access-Jwt-Assertion': token });
    const certsFetches = vi.mocked(fetch).mock.calls.filter(([input]) => requestUrl(input) === CERTS_URL);
    expect(certsFetches.length).toBeGreaterThan(0);
    for (const [, init] of certsFetches) {
      expect(init).toEqual({ cf: { cacheTtl: CERTS_CACHE_SECONDS, cacheEverything: true } });
    }
  });

  it('refuses a token for a different application', async () => {
    const token = await accessToken({ aud: ['other-app'] });
    const response = await call(configured, { 'Cf-Access-Jwt-Assertion': token });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Your Cloudflare Access session is not valid for this application.' });
  });

  it('refuses a token from a different team', async () => {
    const token = await accessToken({ iss: 'https://other.cloudflareaccess.com' });
    expect((await call(configured, { 'Cf-Access-Jwt-Assertion': token })).status).toBe(401);
  });

  it('refuses an expired token', async () => {
    const token = await accessToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await call(configured, { 'Cf-Access-Jwt-Assertion': token })).status).toBe(401);
  });

  it('names the user "admin" when the token has no email', async () => {
    const response = await call(configured, { 'Cf-Access-Jwt-Assertion': await accessToken({ email: undefined }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('admin');
  });

  it('refuses a token that is not valid yet (nbf in the future)', async () => {
    const token = await accessToken({ nbf: Math.floor(Date.now() / 1000) + 3600 });
    expect((await call(configured, { 'Cf-Access-Jwt-Assertion': token })).status).toBe(401);
  });

  it('refuses a token whose kid is not in the team’s key set, even though it is validly signed', async () => {
    const token = await accessTokenFromUnknownKey('rotated-away-key');
    const response = await call(configured, { 'Cf-Access-Jwt-Assertion': token });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Your Cloudflare Access session is not valid for this application.' });
  });

  // Algorithm confusion: only RS256 is accepted, so a token that names another algorithm is refused however it is signed.
  it.each([
    [
      'HS256 with a made-up secret',
      () =>
        sign(
          { iss: TEAM_DOMAIN, aud: [AUD], email: 'mallory@evil.example', exp: Math.floor(Date.now() / 1000) + 300 },
          'a-secret',
          'HS256',
        ),
    ],
    [
      'HS256 with the team’s public key as the secret',
      () =>
        sign(
          { iss: TEAM_DOMAIN, aud: [AUD], email: 'mallory@evil.example', exp: Math.floor(Date.now() / 1000) + 300 },
          JSON.stringify(publicJwk),
          'HS256',
        ),
    ],
    [
      'alg none with no signature',
      () => {
        const part = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
        const claims = { iss: TEAM_DOMAIN, aud: [AUD], email: 'mallory@evil.example', exp: Math.floor(Date.now() / 1000) + 300 };
        return Promise.resolve(`${part({ alg: 'none', typ: 'JWT', kid: KEY_ID })}.${part(claims)}.`);
      },
    ],
  ])('refuses a token signed with %s', async (_case, makeToken) => {
    const response = await call(configured, { 'Cf-Access-Jwt-Assertion': await makeToken() });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Your Cloudflare Access session is not valid for this application.' });
  });

  it.each([
    ['answers an error', () => Promise.resolve(new Response('boom', { status: 500 }))],
    ['is unreachable', () => Promise.reject(new Error('network down'))],
    ['answers something that is not a key set', () => Promise.resolve(Response.json({ nothing: true }))],
  ])('refuses a validly signed token when the team’s key set %s', async (_case, answer) => {
    vi.stubGlobal('fetch', vi.fn(answer));
    const response = await call(configured, { 'Cf-Access-Jwt-Assertion': await accessToken() });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Your Cloudflare Access session is not valid for this application.' });
  });

  it('refuses a token that has been tampered with', async () => {
    const [header, , signature] = (await accessToken()).split('.');
    const forgedPayload = btoa(JSON.stringify({ iss: TEAM_DOMAIN, aud: [AUD], email: 'mallory@evil.example' }))
      .replaceAll('=', '')
      .replaceAll('+', '-')
      .replaceAll('/', '_');
    const response = await call(configured, { 'Cf-Access-Jwt-Assertion': `${header}.${forgedPayload}.${signature}` });
    expect(response.status).toBe(401);
  });
});
