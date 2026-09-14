import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'data/', 'node_modules/'] },

  // The server and its tests: TypeScript, with type-aware rules on. The two that
  // earn their keep here are no-floating-promises and no-misused-promises --
  // this is a polling server, and both have real findings in it.
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.nodeBuiltin,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The renderer interpolates numbers into HTML on purpose.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },

  // node:test's test() and describe() return promises that the runner owns; not
  // awaiting them is the documented API, not a missed await. Scoped off here
  // rather than repo-wide, so the rule keeps its teeth in src/.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      // Async transport doubles intentionally resolve immediately.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // The board runtime that ships to the browser: ES5, a bare IIFE, served
  // verbatim and never bundled. Scoped out of the TypeScript program entirely --
  // type-aware rules cannot run on a file that is not in it. ecmaVersion 5 is a
  // real guardrail: it flags anyone slipping a const or arrow function into a
  // script that has to run on whatever browser the signage player ships.
  {
    files: ['public/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: globals.browser,
    },
  },

  // Root-level tooling config, plain ESM JavaScript.
  {
    files: ['*.js', 'scripts/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },

  prettier,
);
