import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Flat-config ESLint gate for the shared UI package (#978). Same safety conventions as koine-studio —
// void-prefixed promises, domById-over-getElementById, escape-before-innerHTML, and the react-hooks
// rules (the package ships Preact components) — minus the studio-specific imperative-island allow-list.
// Type-aware rules run against tsconfig.json (include: ["src"]) via parserOptions.projectService.

// ── #998: the tseslint.configs.recommendedTypeChecked ratchet — COMPLETE ─────────────────────────
// This was the mirror of koine-studio's inverted allow-list (see its header comment for the full
// rationale): the whole preset on, every still-noisy rule listed in a pending map as 'off' with its
// live count, each ratchet PR deleting one entry. That map is gone from both packages — every rule it
// held is enforced, `unbound-method` (22 findings / 5 files here) last.
// The invariants that got us here still bind: never re-add a burned-down rule as 'off', and never clear
// a finding with a blanket `eslint-disable`. A preset upgrade that lands new findings gets fixed.

// ── The one recorded exemption (ADR 0005 close-out addendum, #1827) ──────────────────────────────
// NOT a ratchet entry — the ratchet is over. `require-await` never had a finding in this package; it is
// off here because a rule is never HALF-ENFORCED across the tree (the #998 invariant, and the reason
// the per-directory ratchet was rejected). It was measured and classified finding-by-finding twice in
// koine-studio (492 findings / 63 files at #1920) and ZERO were a forgotten `await`: the population is
// `vi.fn(async …)` test doubles, async callbacks conforming to async signatures, and members declaring
// an explicit `Promise<T>` return type. The exemption is a judgement about the RULE, not about this
// package's current count — see the ADR for the full measurement and the throw-vs-reject hazard in the
// mechanical fix. Enforcing it only here would block the first Promise-typed seam written in this
// package with a rule the project has formally decided does not earn its keep.
//
// STANDING CONDITION — the exemption rests entirely on the bug class being caught elsewhere, so it
// holds ONLY while `no-floating-promises` and `no-misused-promises` both stay at 'error' in BOTH
// packages, tests and stories included (they are, below and in #997). If either is relaxed, narrowed in
// file scope, or downgraded, DELETE this block and revisit the rule. Keep it in lock-step with
// koine-studio's copy: this rule is changed in both packages or in neither.
const ADR_0005_EXEMPT = {
  '@typescript-eslint/require-await': 'off', // exempt per ADR 0005 close-out addendum — see #1827
};

export default tseslint.config(
  // The full type-checked preset, minus the one ADR-recorded exemption above. Placed first so the
  // narrow #978 gate below stays the last word on the rules it names explicitly.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...ADR_0005_EXEMPT,
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
