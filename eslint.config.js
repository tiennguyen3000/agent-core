import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.pnpm-store/**', '.tooling/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS fixtures (a stdio MCP server for tests) run under Node.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    rules: {
      // Stub guard: leaving a pending-task comment anywhere fails the build.
      'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
);
