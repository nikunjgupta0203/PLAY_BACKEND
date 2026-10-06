// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/generated/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // conventions.md §7 — process.env is read in exactly one file.
    files: ['src/**/*.ts'],
    ignores: ['src/platform/config.ts'],
    rules: {
      'no-restricted-properties': ['error', {
        object: 'process',
        property: 'env',
        message: 'Read config from platform/config.ts, never process.env directly (platform R1).',
      }],
    },
  },
  {
    // conventions.md §1 — modules talk through index.ts, never another module's repo.
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/modules/*/repo/*', '**/modules/*/service/*'],
            message: 'Import another module through its index.ts only (conventions.md §1).' },
        ],
      }],
    },
  },
);
