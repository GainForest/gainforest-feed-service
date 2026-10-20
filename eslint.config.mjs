import js from '@eslint/js'
import vitest from '@vitest/eslint-plugin'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const typedFiles = ['src/**/*.ts', 'test/**/*.ts', 'vitest.config.ts']

const unsafeTypeRules = Object.fromEntries(
  Object.keys(tseslint.plugin.rules)
    .filter((ruleName) => ruleName.startsWith('no-unsafe-'))
    .map((ruleName) => [`@typescript-eslint/${ruleName}`, 'error']),
)

const pgRestriction = {
  name: 'pg',
  message:
    'Import the runtime PostgreSQL client only in src/database.ts. Use type-only imports elsewhere and keep integration-test pools in *.integration.test.ts.',
  allowTypeImports: true,
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      'coverage/**',
      'dist/**',
      'src/lexicons/**',
      'lexicons/app/**',
      'lexicons/com/**',
      'lexicons.json',
      'CHANGELOG.md',
      '.changeset/CHANGELOG.md',
    ],
  },
  {
    linterOptions: {
      noInlineConfig: true,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  })),
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      ...unsafeTypeRules,
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          reportUsedIgnorePattern: true,
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableEnum: false,
          allowNullableNumber: false,
          allowNullableString: false,
          allowNumber: false,
          allowString: false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/database.ts', 'test/**/*.integration.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [pgRestriction],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/database.ts', 'src/metrics.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            pgRestriction,
            {
              name: 'prom-client',
              message:
                'Import prom-client only in src/metrics.ts and expose metrics operations through that adapter.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/database.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'prom-client',
              message:
                'Import prom-client only in src/metrics.ts and expose metrics operations through that adapter.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/hydration/service.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            pgRestriction,
            {
              name: 'prom-client',
              message:
                'Import prom-client only in src/metrics.ts and expose metrics operations through that adapter.',
            },
          ],
          patterns: [
            {
              group: ['../api/*', '../api/**'],
              message:
                'Hydration must depend on internal feed contracts, not API handlers or the public feed service.',
            },
            {
              group: ['../feed/service.js'],
              message:
                'Hydration must not call the public feed skeleton service; use the internal feed-page contract.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.test.ts'],
    plugins: { vitest },
    rules: {
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
    },
  },
  eslintConfigPrettier,
]
