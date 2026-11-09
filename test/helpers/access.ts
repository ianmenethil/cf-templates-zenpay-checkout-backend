import { sign } from 'hono/jwt';
import { vi } from 'vitest';
import { AUD, TEAM_DOMAIN } from './constants';

/** Where the team publishes its signing keys. */
export const CERTS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;

/** Email of the signed-in user in the tests' Access tokens. */
export const ADMIN_EMAIL = 'admin@ianmenethil.com';

/** The `kid` of the test signing key, which the verifier uses to pick the key out of the key set. */
export const KEY_ID = 'test-key';

/** A fresh RSA key pair for every run, standing in for the team's Access signing key. */
export const keyPair = (await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;

// A `kid` on the signing key puts it in the token header, where the verifier matches it to the key set.
/** The test signing key as a JWK with its `kid`, for signing tokens. */
export const privateJwk = { ...((await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey), kid: KEY_ID };
/** The test verification key as a JWK with its `kid`: the one entry of the key set the team's certs URL serves. */
export const publicJwk = { ...((await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey), kid: KEY_ID };

/**
 * The address a `fetch` call asked for.
 * @param input - The first argument of the `fetch` call.
 * @returns The address as text.
 */
export const requestUrl = (input: RequestInfo | URL): string => (input instanceof Request ? input.url : String(input));

/** Serves the test key set from the team's certs URL, the way Cloudflare Access does. */
export const serveAccessKeys = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(requestUrl(input) === CERTS_URL ? Response.json({ keys: [publicJwk] }) : new Response('not found', { status: 404 })),
    ),
  );
};

/**
 * Signs an Access token with a key that is not in the team's key set, under the given `kid`.
 * @param kid - The `kid` to put in the token's header.
 * @returns The signed token.
 */
export const accessTokenFromUnknownKey = async (kid: string): Promise<string> => {
  const other = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const otherPrivateJwk = { ...((await crypto.subtle.exportKey('jwk', other.privateKey)) as JsonWebKey), kid };
  return sign(
    { iss: TEAM_DOMAIN, aud: [AUD], email: ADMIN_EMAIL, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 },
    otherPrivateJwk,
    'RS256',
  );
};

/**
 * Signs a token shaped like the one Cloudflare Access forwards in `Cf-Access-Jwt-Assertion`.
 * @param claims - Claims that replace the defaults.
 * @returns The signed token.
 */
export const accessToken = (claims: Record<string, unknown> = {}): Promise<string> =>
  sign(
    {
      iss: TEAM_DOMAIN,
      aud: [AUD],
      email: ADMIN_EMAIL,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    },
    privateJwk,
    'RS256',
  );
