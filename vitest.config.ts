import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { AUD, TEAM_DOMAIN } from './test/helpers/constants.ts';
import {
  API_KEY,
  CALLBACK_TOKEN_SECRET,
  MERCHANT_CODE,
  PASSWORD,
  REDIRECT_URL,
  SECOND_SHOP_ORIGIN,
  SHOP_ORIGIN,
  USERNAME,
} from './test/helpers/zenpay-fixtures.ts';

// Read in Node here and handed to the tests as a binding, because the tests run in the Workers runtime.
const migrations = await readD1Migrations(join(import.meta.dirname, 'migrations'));

// `@/` is the React app's folder, as in vite.config.ts and tsconfig.app.json.
const panelAlias = { '@': join(import.meta.dirname, 'src/react-app') };

export default defineConfig({
  test: {
    // Coverage is set once here for every project. The Workers runtime has no V8 coverage, so it is instrumented (Istanbul).
    coverage: {
      provider: 'istanbul',
      include: ['src/**'],
      exclude: ['src/react-app/components/ui/**', 'src/**/*.d.ts'],
      reporter: ['text', 'html'],
    },
    projects: [
      {
        // The Worker, tested inside the Workers runtime against the real D1 migrations.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // Fixed values the tests rely on, so a local .dev.vars does not change them: the Access settings
            // that match the tokens the tests sign (test/helpers/access.ts), the ZenPay credentials and settings the
            // fixtures in test/helpers/zenpay-fixtures.ts were hashed with, and the migrations for test/setup.ts.
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
                ACCESS_AUD: AUD,
                ZENPAY_API_KEY: API_KEY,
                ZENPAY_USERNAME: USERNAME,
                ZENPAY_PASSWORD: PASSWORD,
                CALLBACK_TOKEN_SECRET,
                ZENPAY_MERCHANT_CODE: MERCHANT_CODE,
                ZENPAY_CHECKOUT_URL: 'https://pay.sandbox.travelpay.com.au/online/v5',
                ALLOWED_ORIGINS: `${SHOP_ORIGIN},${SECOND_SHOP_ORIGIN}`,
                REDIRECT_URL,
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/*.test.ts'],
          // Checks the ZenPay fixtures against Node's SHA3-512, and builds the admin panel so its files exist for the
          // Worker's ASSETS binding.
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        // The admin panel's plain functions, with no browser.
        resolve: { alias: panelAlias },
        test: {
          name: 'panel-unit',
          environment: 'node',
          include: ['test/panel/unit/**/*.test.ts'],
        },
      },
      {
        // The admin panel's components, rendered in a real headless Chromium with vitest-browser-react.
        plugins: [react(), tailwindcss()],
        resolve: { alias: panelAlias },
        // Each test file loads on its own, so with a cold cache Vite finds the panel's dependencies one test at a time,
        // re-bundles and reloads the page mid-run, which fails the test or leaves two copies of React ("Invalid hook
        // call"). Listing them here bundles them all before the first test.
        optimizeDeps: { include: ['class-variance-authority', 'cn', 'lucide-react', 'radix-ui', 'sonner', 'vitest-browser-react'] },
        test: {
          name: 'panel-browser',
          include: ['test/panel/browser/**/*.test.tsx'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
