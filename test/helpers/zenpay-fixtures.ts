/**
 * Fixed ZenPay values for the tests. This file has no imports from the Workers runtime or from `@zp-hcp/server`:
 * `test/global-setup.ts` loads it in Node and recomputes every hash below with Node's own `sha3-512`, because
 * SHA3 is not available in workerd and because expected values must not come from the code under test.
 *
 * Each fixture is a pipe string (ZenPay's documented field order) and the SHA3-512 hex digest of exactly that
 * string. Amounts are in whole cents inside the string: 150.53 is `15053`, 123 is `12300`, and Mode 2 and an
 * amount-less Mode 1 are `0`.
 */
import type { PaymentMode } from '../../src/shared/types.ts';

/** The ZenPay API key the tests configure. */
export const API_KEY = 'test-api-key-0001';

/** The ZenPay username the tests configure. */
export const USERNAME = 'test-user-0001';

/** The ZenPay password the tests configure. */
export const PASSWORD = 'test-password-0001';

/** The callback address signing secret the tests configure: at least 32 bytes. */
export const CALLBACK_TOKEN_SECRET = 'test-callback-token-secret-0123456789abcdef';

/** The `REDIRECT_URL` the tests configure: where ZenPay sends the shopper's browser after payment. The fingerprint does not hash it. */
export const REDIRECT_URL = 'https://shop.ianmenethil.com/thanks';

/** The merchant code the tests configure. */
export const MERCHANT_CODE = 'TestMerchant1';

/** The first website allowed to call the checkout API: the first entry of `ALLOWED_ORIGINS` in the tests, and the `Origin` a call sends unless a test says otherwise. */
export const SHOP_ORIGIN = 'https://shop.ianmenethil.com';

/** The second entry of `ALLOWED_ORIGINS` in the tests, for checking that every listed origin is served. */
export const SECOND_SHOP_ORIGIN = 'https://www.shop.ianmenethil.com';

/**
 * The time the checkout tests freeze the Worker's clock at, so the fingerprint is the one the fixtures hold. It is
 * fixed, not today: a test never reads the real clock.
 */
export const FROZEN_CLOCK = '2026-11-09T01:02:03.456Z';

/** The timestamp the Worker writes at `FROZEN_CLOCK`, which the fixtures' fingerprints hash: UTC, to the second, with no zone. */
export const FROZEN_TIMESTAMP = '2026-11-09T01:02:03';

/** A string and its SHA3-512 digest. */
export type HashFixture = { pipe: string; sha3: string };

/** One mode's launch and the callback ZenPay sends for it. */
export type Scenario = {
  mode: PaymentMode;
  /** Dollars, as the shopper's page sends it. */
  paymentAmount: number;
  /** The payment ID the test makes the Worker mint. */
  mupid: string;
  /** The fingerprint the checkout route must return at the frozen clock. */
  fingerprint: HashFixture;
  /** ZenPay's reference in the callback: payment reference, token or preauth reference. */
  reference: string;
  /** The `validationCode` of the callback with that reference. */
  validationCode: HashFixture;
};

/** The four modes. */
export const SCENARIOS: Record<PaymentMode, Scenario> = {
  0: {
    mode: 0,
    paymentAmount: 150.53,
    mupid: 'f0000000-0000-4000-8000-000000000000',
    fingerprint: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|0|15053|f0000000-0000-4000-8000-000000000000|2026-11-09T01:02:03',
      sha3: 'a02efd240c615ce4a4198ddc7294b315045fd99ca12f0ee1b3a93a0a2d6168422faa39880497b5fc5c00926ee3adb8d5deeeff356a99655be1a19ee2d406b385',
    },
    reference: 'PR-1001',
    validationCode: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|0|15053|f0000000-0000-4000-8000-000000000000|PR-1001',
      sha3: 'aed077a0b82ffeb73f56cd681d53b8b6068fc9f8febbe0d943a35112310e2cdf2becd3af71dcc6c793f9dbeac45909a28a7888b40de7afb98075286ff2cfd33b',
    },
  },
  1: {
    mode: 1,
    paymentAmount: 0,
    mupid: 'f0000000-0000-4000-8000-000000000001',
    fingerprint: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|1|0|f0000000-0000-4000-8000-000000000001|2026-11-09T01:02:03',
      sha3: '681a9013c3594396d604226b8ccc6f35dac176123308cb84d3c1a607b42b353a30931004d2fd8b4e0779d03f3c3ad84c14d73aac33c3f6f92d0cc8249cf39b45',
    },
    reference: 'TOK-1001',
    validationCode: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|1|0|f0000000-0000-4000-8000-000000000001|TOK-1001',
      sha3: '66dfca076a7508558d40651ea1b7289610219b623d7d790b068c83a0f3f6514a2a11b8a2cbd6404c49eb3f37681cc63752d9e16402a9ad6451fd3512d0be958e',
    },
  },
  2: {
    mode: 2,
    paymentAmount: 49.9,
    mupid: 'f0000000-0000-4000-8000-000000000002',
    fingerprint: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|2|0|f0000000-0000-4000-8000-000000000002|2026-11-09T01:02:03',
      sha3: '7b4ecd04680dd9f660d797576ace4967fd05e126d1864266a209fa4799e9573a0586869c1d444a380d615cc0ae8028dfa4e00b4bd53ebfb71e87730f9e68b4b2',
    },
    reference: 'PR-1002',
    validationCode: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|2|0|f0000000-0000-4000-8000-000000000002|PR-1002',
      sha3: 'c181fe21c9a9903b8f9eee28863df5feef63fa8dc97e0d6ad879c7c82383fd4a6cd25e93338e111b002826b93acf4a58238d9ccce5c512da9c772a5a0811e5bc',
    },
  },
  3: {
    mode: 3,
    paymentAmount: 123,
    mupid: 'f0000000-0000-4000-8000-000000000003',
    fingerprint: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|3|12300|f0000000-0000-4000-8000-000000000003|2026-11-09T01:02:03',
      sha3: '1969d8fc68ab94db9dd4b69fd879f9da41df82f7d7169bd4c1be8255e7972bdca1753e0bb8986e419d3cef0602c88ef7efd8fc3821c547be6f325e9b4b6c2748',
    },
    reference: 'PA-1003',
    validationCode: {
      pipe: 'test-api-key-0001|test-user-0001|test-password-0001|3|12300|f0000000-0000-4000-8000-000000000003|PA-1003',
      sha3: '7c7bb2a21dbf19cebe2ec713ea5a188467394dfcc0d94c66b450ad54ff3536d36511d048fec9a0fb0beee321b0052f9369c3223b60f757bcb0f524e2121c147d',
    },
  },
};

/** Tokenise with an amount above 0: unlike the amount-less one in `SCENARIOS[1]`, its amount is hashed in whole cents (25.5 is `2550`). */
export const TOKENISE_WITH_AMOUNT: Scenario = {
  mode: 1,
  paymentAmount: 25.5,
  mupid: 'f0000000-0000-4000-8000-000000000004',
  fingerprint: {
    pipe: 'test-api-key-0001|test-user-0001|test-password-0001|1|2550|f0000000-0000-4000-8000-000000000004|2026-11-09T01:02:03',
    sha3: '3e2ca48f7d25bd1f717c2c3f5af653390f5327000af4d36fd386a1557f8ee3740d56edaf63ebdbf9a5eb564a1829eee6bec6cd2af43ace53c8b62c17807d637c',
  },
  reference: 'TOK-1002',
  validationCode: {
    pipe: 'test-api-key-0001|test-user-0001|test-password-0001|1|2550|f0000000-0000-4000-8000-000000000004|TOK-1002',
    sha3: 'dd6f8eac312adb7fc12b3e6730f9d26204bbf704d63ef74c2fcae84bd509d59b60c1eac9b195acc33cba8d75d70c850f49f41f7ad4873daf5e7bdfd3174f0f68',
  },
};

/** Every scenario, for the check in `test/global-setup.ts`. */
export const ALL_SCENARIOS: Scenario[] = [...Object.values(SCENARIOS), TOKENISE_WITH_AMOUNT];

/** Every fixture, for the check in `test/global-setup.ts`. */
export const ALL_FIXTURES: HashFixture[] = ALL_SCENARIOS.flatMap((scenario) => [scenario.fingerprint, scenario.validationCode]);
