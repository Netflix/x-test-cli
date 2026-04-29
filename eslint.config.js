import globals from 'globals';
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';

const common = {
  rules: {
    ...js.configs.recommended.rules,
    'comma-dangle': ['warn', {
      arrays: 'always-multiline',
      objects: 'always-multiline',
      imports: 'always-multiline',
      exports: 'always-multiline',
      functions: 'only-multiline',
    }],
    'eqeqeq': 'error',
    'no-console': 'warn',
    'no-prototype-builtins': 'warn',
    'no-shadow': 'warn',
    'no-undef-init': 'error',
    'no-unused-vars': 'warn',
    'no-var': 'error',
    'prefer-arrow-callback': ['error', { allowNamedFunctions: true }],
    'prefer-const': 'error',
    'quotes': ['warn', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    'semi': 'warn',
  },
  linterOptions: {
    reportUnusedDisableDirectives: true,
  },
};

export default [
  {
    files: ['**/*.js'],
    languageOptions: { globals: globals.node },
    ...common,
  },
  {
    // Browser-side integration test fixtures — run inside Chromium, not Node,
    //  so they need browser globals (`document`, `window`, …) instead.
    files: ['test/browser/**/*.js'],
    languageOptions: { globals: globals.browser },
    ...common,
  },
  {
    ...jsdoc.configs['flat/recommended'],
    files: [
      'x-test-cli.js',
      'x-test-cli-browser.js',
      'x-test-cli-config.js',
      'x-test-cli-coverage.js',
      'x-test-cli-tap.js',
    ],
    rules: {
      ...jsdoc.configs['flat/recommended'].rules,
      // We use JSDoc for `tsc --noEmit` checking, not as a documentation
      //  contract. Don't require humans to repeat the obvious — turn off the
      //  prose-required-everywhere rules, keep the ones that catch real bugs
      //  (mismatched / undefined types).
      'jsdoc/require-jsdoc':                'off',
      'jsdoc/require-param-description':    'off',
      'jsdoc/require-returns-description':  'off',
      'jsdoc/require-property-description': 'off',
      'jsdoc/require-returns':              'off',
    },
  },
  {
    settings: {
      jsdoc: {
        preferredTypes: [
          // TypeScript knows about these, but eslint does not.
          'NodeJS.ErrnoException',
          'PromiseWithResolvers',
          'RegExpExecArray',
        ],
      },
    },
  },
  {
    ignores: ['node_modules'],
  },
];
