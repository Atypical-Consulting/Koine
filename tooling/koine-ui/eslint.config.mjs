import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Flat-config ESLint gate for the shared UI package (#978). Same safety conventions as koine-studio —
// void-prefixed promises, domById-over-getElementById, escape-before-innerHTML, and the react-hooks
// rules (the package ships Preact components) — minus the studio-specific imperative-island allow-list.
// Type-aware rules run against tsconfig.json (include: ["src"]) via parserOptions.projectService.

// ── #998: the tseslint.configs.recommendedTypeChecked ratchet ────────────────────────────────────
// Same inverted allow-list as koine-studio's config (see its header comment for the full rationale):
// the whole preset is on, and every rule that still has findings is listed here as 'off' with its
// live count; each ratchet PR fixes one rule and DELETES its entry. Never re-add an entry.
const RATCHET_PENDING = {
  '@typescript-eslint/unbound-method': 'off', //                 22 findings / 5 files
};

export default tseslint.config(
  // The full type-checked preset, minus the still-pending rules above. Placed first so the narrow
  // #978 gate below stays the last word on the rules it names explicitly.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...RATCHET_PENDING,
      // Same underscore-ignore config as koine-studio's (see its header comment for the rationale):
      // matches the codebase's pre-existing `_name` convention for deliberately-unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Same narrowing as koine-studio's config: `with-single-extends` is the rule's own allowance for
      // declaration-MERGING interfaces (src/vitest-axe.d.ts augments vitest's `Assertion` /
      // `AsymmetricMatchersContaining`), where an empty body is unavoidable — augmentation only works
      // through an interface. Genuinely-empty declarations are still 'error'.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-properties': ['error', {
        object: 'document',
        property: 'getElementById',
        message: 'Look up chrome by a throw-on-missing helper so a missing #id fails loudly instead of a silent null.',
      }],
      'no-restricted-syntax': [
        'error',
        {
          // Any `x.innerHTML = …` / `x.outerHTML = …` (and `+=`). The one sanctioned sink is el()'s
          // documented `html:` escape hatch (already-trusted/escaped markup), annotated inline;
          // everything else must use textContent.
          selector: "AssignmentExpression[left.property.name=/^(inner|outer)HTML$/]",
          message: 'Assigning innerHTML/outerHTML is an XSS sink. Use textContent/el(); only already-trusted/escaped markup, behind a justified disable.',
        },
        {
          // The same sink in call form. No site exists today (grep-verified); banned as defence-in-depth.
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is an XSS sink. Use textContent/el(); only already-trusted/escaped markup, behind a justified disable.',
        },
      ],
    },
  },
  // Tests & stories legitimately stage fixture markup (innerHTML) and probe optional-absence in the
  // DOM (getElementById → null). no-floating-promises is fully enforced here too (#997) — every
  // vitest/Storybook site now awaits or void-marks its promises, same as prod code.
  {
    files: ['src/**/*.{test,stories}.{ts,tsx}', 'src/test-setup*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
