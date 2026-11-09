import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBuilder } from 'vite';
import { ALL_FIXTURES, ALL_SCENARIOS, API_KEY, PASSWORD, USERNAME } from './helpers/zenpay-fixtures';

/**
 * Checks the ZenPay fixtures against Node's SHA3-512, so the expected fingerprints and validation codes the tests
 * rely on come from the documented pipe strings and not from the code under test. It also checks that each
 * pipe string starts with the test credentials and ends the way its kind of hash does.
 */
const checkFixtures = (): void => {
  for (const { pipe, sha3 } of ALL_FIXTURES) {
    const computed = createHash('sha3-512').update(pipe).digest('hex');
    if (computed !== sha3) {
      throw new Error(`Fixture is wrong: SHA3-512 of "${pipe}" is ${computed}, not ${sha3}.`);
    }
  }
  for (const scenario of ALL_SCENARIOS) {
    const fingerprint = scenario.fingerprint.pipe.split('|');
    const validationCode = scenario.validationCode.pipe.split('|');
    const expectedStart = [API_KEY, USERNAME, PASSWORD, String(scenario.mode)];
    for (const fields of [fingerprint, validationCode]) {
      if (fields.length !== 7 || expectedStart.some((value, index) => fields[index] !== value) || fields[5] !== scenario.mupid) {
        throw new Error(`Fixture for mode ${scenario.mode} is not in the order apiKey|username|password|mode|amount|mupid|last.`);
      }
    }
    if (fingerprint[4] !== validationCode[4] || validationCode[6] !== scenario.reference) {
      throw new Error(
        `Fixture for mode ${scenario.mode}: the fingerprint and validation code must hash the same amount, and the reference must be the last field.`,
      );
    }
  }
};

/** The part of the built Worker that this check calls. */
type BuiltWorker = { fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> };

/**
 * Asks the built Worker, run as it is, for the admin panel's page and reads the `script-src` of its Content Security
 * Policy. The bundle is executed, not searched for text, so a change in how the bundler writes the allowance cannot
 * hide the dev-only `'unsafe-inline'`.
 * @returns The sources `script-src` allows.
 * @throws When the page has no `script-src`.
 */
const builtScriptSources = async (): Promise<string[]> => {
  const url = pathToFileURL(resolve('dist/zenpay_checkout_backend/index.js')).href;
  const { default: worker } = (await import(`${url}?built=${Date.now()}`)) as { default: BuiltWorker };
  const response = await worker.fetch(
    new Request('https://checkout.example.com/admin/'),
    {
      ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
      ACCESS_AUD: 'built-worker-check',
      ASSETS: { fetch: () => Promise.resolve(new Response('<!doctype html>')) },
    },
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
      access: { aud: 'built-worker-check', getIdentity: () => Promise.resolve({ email: 'admin@example.com' }) },
    },
  );
  const directive = (response.headers.get('Content-Security-Policy') ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src '));
  if (directive === undefined) {
    throw new Error(`The built Worker's admin page has no script-src (status ${response.status}).`);
  }
  return directive.split(/\s+/).slice(1);
};

/**
 * Checks the fixtures, then builds the admin panel before the tests run, so they request the real page and files
 * through the Worker's `ASSETS` binding (see `assets` in wrangler.jsonc) instead of a stand-in. It also runs the
 * built Worker and checks that its `script-src` is `'self'` and nothing else, so the inline-script allowance used only
 * by `vite dev` did not reach production; inline styles are allowed on purpose, for shadcn's toast and dialog.
 */
export default async function setup(): Promise<void> {
  checkFixtures();

  const nodeEnv = process.env.NODE_ENV;
  // Vitest sets NODE_ENV to `test`; the build needs the production setting.
  process.env.NODE_ENV = 'production';
  try {
    // Vite's `build()` builds one environment, the admin panel. `buildApp()` builds all of them, as `vite build` does here, so the Worker exists too.
    const builder = await createBuilder({ mode: 'production', logLevel: 'warn' });
    await builder.buildApp();
  } finally {
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
  }
  const sources = await builtScriptSources();
  if (sources.length !== 1 || sources[0] !== "'self'") {
    throw new Error(`The built Worker's script-src is "${sources.join(' ')}", not just 'self': a dev-only allowance reached the build.`);
  }
}
