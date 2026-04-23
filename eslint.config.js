const globals = require('globals');
const nodeGlobals = globals.node;

module.exports = [
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'uploads/**', 'public/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-redeclare': 'off',
      'no-undef': 'error',
      'semi': ['error', 'always'],
      'quotes': ['warn', 'single', { allowTemplateLiterals: true }],
      'indent': ['warn', 2],
      'comma-dangle': ['warn', 'never'],
      'eqeqeq': 'warn',
      'no-else-return': 'warn',
      'no-empty': 'warn',
      'no-floating-decimal': 'warn',
      'no-multi-spaces': ['warn', { ignoreEOLComments: true }],
      'no-multiple-empty-lines': 'warn',
      'no-trailing-spaces': 'warn',
      'no-with': 'error',
      'yoda': 'warn',
    },
  },
];
