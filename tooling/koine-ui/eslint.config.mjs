import tseslint from 'typescript-eslint';
import { typeCheckedPreset, promiseSafetyGate, reactHooksGate } from '@atypical/eslint-config';

// Flat-config ESLint gate for the shared UI package (#978). Same safety conventions as koine-studio —
// void-prefixed promises, domById-over-getElementById, escape-before-innerHTML, and the react-hooks
// rules (the package ships Preact components) — minus the studio-specific imperative-island allow-list.
// Type-aware rules run against tsconfig.json (include: ["src"]) via parserOptions.projectService.
//
// ── What lives here vs in @atypical/eslint-config (#1924) ────────────────────────────────────────
// The rule DECISIONS this package shares with koine-studio — the `recommendedTypeChecked` preset, the
// ADR 0005 `require-await` exemption, the `no-unused-vars` `^_` narrowing, the `no-empty-object-type`
// narrowing, the `no-floating-promises`/`no-misused-promises` pair that ADR 0005's exemption depends
// on, and the react-hooks rules — live ONCE in `tooling/eslint-config`, with their justifications, and
// are spread in below. They are no longer mirrored by hand: `scripts/ci/check-eslint-config-parity.mjs`
// asserts in CI that both packages resolve to the same setting for every shared rule, so #998's
// invariant (a rule is never half-enforced across the tree) fails the build rather than review.
//
// What stays in this file is what is grounded in THIS package's own code: the `getElementById` message
// naming its own helper, the HTML-injection sink bans, and the tests/stories override. #998's standing
// invariants still bind here: never re-add a burned-down rule as 'off', never clear a finding with a
// blanket `eslint-disable`, and change a shared rule in the shared module — never in one package only.
export default tseslint.config(
  // The full type-checked preset plus the shared rule decisions. Placed first so the narrow #978 gate
  // below stays the last word on the rules it names explicitly.
  ...typeCheckedPreset(import.meta.dirname),
  ...promiseSafetyGate(import.meta.dirname),
  ...reactHooksGate(import.meta.dirname),
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
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
