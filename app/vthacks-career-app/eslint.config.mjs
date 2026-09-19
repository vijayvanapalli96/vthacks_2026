import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * eslint-config-next 16 ships native flat configs, so these are spread directly —
 * no FlatCompat, which crashes on them with a circular-structure error.
 *
 * `next/core-web-vitals` already registers eslint-plugin-jsx-a11y, so we only
 * turn rules UP here; re-spreading jsxA11y.flatConfigs.recommended throws
 * "Cannot redefine plugin".
 *
 * Accessibility is the product thesis, so these are errors rather than warnings —
 * we want them to fail the lane, not scroll past in a log. The list is the set
 * that actually breaks a screen-reader or keyboard user, and we claim both.
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', '.data/**', 'public/**', 'next-env.d.ts'],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      // depth 3: the role options wrap their text in <span><strong>/<small>, so
      // the accessible text is legitimately nested below the default depth of 2.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
    },
  },
];

export default config;
