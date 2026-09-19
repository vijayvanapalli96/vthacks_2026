/**
 * eslint.config.mjs
 *
 * The repo had no ESLint config at all, so `npm run lint` failed before any of
 * this branch's code existed. Added here because accessibility is the product
 * thesis and jsx-a11y catching violations as you type is worth more than an audit
 * pass at 4 AM.
 *
 * NOTE FOR THE MERGE: feat/auth-template also sets up linting (its F0.5 task).
 * If both branches add this file, keep one — they should be near-identical.
 */
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', '.data/**', 'next-env.d.ts'],
  },
  ...coreWebVitals,
  ...typescript,
  {
    // eslint-config-next already registers the jsx-a11y plugin, so we only turn
    // rules up here — re-spreading jsxA11y.flatConfigs.recommended would throw
    // "Cannot redefine plugin".
    rules: {
      // Stricter than next's defaults, on purpose — these are the ones that
      // actually break a screen-reader or keyboard user, and we claim both.
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
    },
  },
];

export default config;
