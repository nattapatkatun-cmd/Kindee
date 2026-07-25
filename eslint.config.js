'use strict';
// Static checks for a single-file app with no build step.
//
// The point of this config is narrow and deliberate: catch the class of bug that shipped
// twice — a variable that does not exist. `todayD is not defined` reached production
// because nothing between "it parses" and "a user opens the tab" could see it. `no-undef`
// sees it in about a second, without a browser.
//
// Style rules are intentionally off. This is a 12,000-line file written in one voice;
// reformatting it would bury real findings in noise and make every future diff unreadable.

const globals = require('globals');
const html = require('eslint-plugin-html');

module.exports = [
  {
    // index.html holds several <script> blocks that share one global scope at runtime, so
    // they must be linted together — otherwise every cross-block reference reads as undefined.
    files: ['**/*.html'],
    plugins: { html },
    settings: { 'html/javascript-mime-types': ['text/javascript', 'application/javascript'] },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Loaded from CDN <script> tags, so they are never declared in our own source.
        Chart: 'readonly',
        firebase: 'readonly',
        // Populated by the Firebase bootstrap block at runtime.
        FB: 'writable',
        FB_OK: 'writable',
      },
    },
    rules: {
      // The whole reason this config exists.
      'no-undef': 'error',

      // Silent-failure bugs that a syntax check also cannot see. All of these are things
      // that parse fine and then behave wrongly.
      'no-dupe-keys': 'error',        // a later key silently wins
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-finally': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-constant-binary-expression': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-cond-assign': ['error', 'always'],  // `if (x = 1)` is nearly always a typo

      // Reading a `var` before its declaration line is exactly how `inconsistent` ended up
      // permanently `undefined` inside the weight analyzer — the check ran ~20 lines above
      // the declaration, so `!inconsistent` was always true and the guard never fired.
      //
      // `variables: false` limits this to references in the SAME scope. Without it the rule
      // also flags the module-level state objects (S, FT, WT) that every function legitimately
      // closes over — 86 false positives that would drown the one real signal.
      'no-use-before-define': ['error', { functions: false, variables: false, classes: false }],
    },
  },
  {
    files: ['test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // `no-undef` is off here, and only here. The bodies passed to page.evaluate() are
      // serialised and run inside the browser, where they legitimately reference the app's
      // own globals (showPage, S, saveMeal, …) — ESLint sees Node source and cannot know
      // that. Enumerating every app global would turn this config into a second, silently
      // rotting copy of the app's namespace.
      //
      // The trade is acceptable because test files get their verification from running: a
      // typo here fails the test immediately and loudly. index.html has no such safety net,
      // which is why the rule is an error there.
      'no-undef': 'off',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-self-compare': 'error',
      'no-constant-binary-expression': 'error',
      'use-isnan': 'error',
    },
  },
  {
    // Cloudflare Worker: module syntax, worker globals.
    files: ['worker/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: { 'no-undef': 'error' },
  },
  {
    ignores: ['node_modules/**', 'icons/**'],
  },
];
