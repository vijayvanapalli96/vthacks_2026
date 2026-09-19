import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * eslint-config-next 16 ships native flat configs, so these are spread directly —
 * no FlatCompat (which crashes on them with a circular-structure error).
 *
 * `next/core-web-vitals` already enables eslint-plugin-jsx-a11y. Accessibility is
 * the product thesis, so the a11y rules below are errors, not warnings: we want
 * them to fail the lane rather than scroll past in a log.
 */
const config = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'public/**'],
  },
  {
    rules: {
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      // depth 3: the role options wrap their text in <span><strong>/<small>, so
      // the accessible text is legitimately nested below the default depth of 2.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
    },
  },
];

export default config;
