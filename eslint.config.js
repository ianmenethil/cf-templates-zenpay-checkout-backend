import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tsdoc from 'eslint-plugin-tsdoc';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist', '.wrangler', 'coverage', 'worker-configuration.d.ts']),
  {
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // Type-aware rules such as no-floating-promises and no-misused-promises read their types from the tsconfig
        // project that includes each file.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { tsdoc },
    rules: {
      // Doc comments must be valid TSDoc.
      'tsdoc/syntax': 'warn',
    },
  },
  {
    // Plain JavaScript files are in no tsconfig, so they cannot use type information.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['src/react-app/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    files: ['src/worker/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['*.config.{js,ts}', 'test/global-setup.ts'],
    languageOptions: { globals: globals.node },
  },
);
