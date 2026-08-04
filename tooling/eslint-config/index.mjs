// Shared ESLint flat-config building blocks for Koine's front-end packages (#1924).
//
// WHY THIS EXISTS. `tooling/koine-studio` and `tooling/koine-ui` must agree on a set of rule
// DECISIONS — #998's load-bearing invariant is that a rule is never half-enforced across the tree (it
// considered and rejected a per-directory ratchet precisely to avoid that). Until this module, that
// agreement was held by prose: each config carried its own copy of every shared decision, plus a
// comment telling the next reader to keep it in lock-step with the other package. An edit to one file
// and not the other silently violated the invariant and nothing noticed. #1920 made the cost concrete
// by copy-pasting an `ADR_0005_EXEMPT` block, and its multi-paragraph justification, into both files.
//
// Now each shared decision lives here once, with one canonical justification, and
// `scripts/ci/check-eslint-config-parity.mjs` asserts in CI that both packages still resolve to the
// same setting for every rule listed in its SHARED_RULES — so half-enforcement fails the build instead
// of passing review.
//
// WHAT BELONGS HERE. A rule decision that is a judgement about the RULE (an ADR, or a convention that
// holds tree-wide), not about one package's current findings. What does NOT belong here is anything
// grounded in one package's own code: koine-studio's imperative-island allow-list, its `#1352`
// lifecycle selectors, its sanctioned `dangerouslySetInnerHTML` sites, its `src/templates.generated.ts`
// ignore, its `prefer-const` narrowing (justified by a forward-declaration idiom that exists only in
// its controllers), and each package's `no-restricted-properties` message naming its own helper. Those
// stay in the package that owns them.
//
// EXPORTS return flat-config ARRAYS, so callers spread them and config-block ORDER stays explicit and
// readable at the call site. Order matters: both packages place the type-checked preset first so the
// narrow #978 gate stays the last word on the rules it names explicitly. Each export declares its OWN
// `languageOptions` rather than relying on a sibling block to have set the parser — flat config merges
// those per key across matching blocks, so the repetition is idempotent, and it keeps every export
// composable on its own instead of carrying a silent ordering dependency on one of the others.
//
// THIS FILE IS NOT LINTED. Neither package's `files: ['src/**/*.{ts,tsx}']` glob matches it, the same
// way neither lints its own `eslint.config.mjs`. That is deliberate and recorded here rather than left
// undefined: bootstrapping a lint config with the lint config it defines buys little and complicates
// the gate's own dependency order. It is covered instead by the parity check, which executes it on
// every run — a syntax error or a wrong rule value fails CI immediately.

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * `tsconfigRootDir` must be supplied by the CONSUMER — `import.meta.dirname` evaluated inside this
 * module would resolve to this package, pointing type-aware linting at the wrong TypeScript program
 * and silently changing what every type-aware rule sees. It is a required parameter, never defaulted.
 */
function requireRootDir(fnName, tsconfigRootDir) {
  if (typeof tsconfigRootDir !== 'string' || tsconfigRootDir.length === 0) {
    throw new TypeError(
      `${fnName}(tsconfigRootDir): pass the CONSUMING package's directory (import.meta.dirname). ` +
        'It cannot be defaulted here — this module would resolve it to itself and type-aware linting ' +
        'would target the wrong tsconfig program.',
    );
  }
  return { projectService: true, tsconfigRootDir };
}

/**
 * `tseslint.configs.recommendedTypeChecked` plus the rule decisions both packages take together.
 *
 * The ratchet that got here is #998: the preset adopted as an inverted allow-list, one rule burned
 * down per PR, closed out in #1920 with 46 of its 47 rules enforced. What survives as configuration is
 * one ADR-recorded exemption and two option narrowings — each argued below, none a suppression.
 */
export function typeCheckedPreset(tsconfigRootDir) {
  const parserOptions = requireRootDir('typeCheckedPreset', tsconfigRootDir);
  return [
    {
      files: ['src/**/*.{ts,tsx}'],
      extends: [tseslint.configs.recommendedTypeChecked],
      languageOptions: { parser: tseslint.parser, parserOptions },
      rules: {
        // ── The one recorded exemption (ADR 0005 close-out addendum, #1827) ────────────────────────
        // NOT ratchet debt. `require-await` was measured and classified finding-by-finding TWICE
        // (490 findings / 63 files at #1826, 492/63 on re-measure at #1920) and the rule's premise
        // does not hold in this codebase: 339 are `vi.fn(async …)`/`mockImplementation(async …)` test
        // doubles, 111 are async callbacks passed where an async signature is expected, 1 is an async
        // generator, 37 are members with an explicit `Promise<T>` return type, and 4 were
        // `test(…, async () =>` bodies with a droppable `async` (dropped in #1920). ZERO are a
        // forgotten `await`. All 13 non-test sites implement a Promise-typed contract — `FsFileHandle`
        // / `FsDirHandle`, `KoineHost`, `LspTransport`, `runEditToolStaging`.
        //
        // Two reasons, both load-bearing:
        //  1. The bug class this rule exists to catch — a promise created and never awaited — is
        //     ALREADY caught by `no-floating-promises` AND `no-misused-promises`, both at 'error' in
        //     prod code and in tests/stories since #997 (see promiseSafetyGate below). On this
        //     codebase `require-await` reports a declaration style, not a defect.
        //  2. Satisfying it is a BEHAVIOUR CHANGE, not a refactor: rewriting ~486 deliberate `async`
        //     bodies to `Promise.resolve(…)` converts every `throw` in them from a REJECTION into a
        //     SYNCHRONOUS throw, and several prod sites throw on purpose (`MemDir.getFileHandle` /
        //     `getDirectoryHandle` / `removeEntry`).
        //
        // STANDING CONDITION — this exemption depends on reason 1, so it holds ONLY while
        // `no-floating-promises` and `no-misused-promises` both stay at 'error' in BOTH packages,
        // tests and stories included. If either is relaxed, narrowed in file scope, or downgraded,
        // DELETE this entry and revisit the rule. Co-locating the two here is what makes that
        // dependency structural instead of a sentence someone has to notice; the parity check pins all
        // three together. #1827's Option A specifies the honest way to enforce it instead: staged
        // per-directory, every throwing site first covered by a test asserting
        // `await expect(...).rejects.toThrow(...)`.
        '@typescript-eslint/require-await': 'off',

        // The tree's pre-existing convention for a deliberately-unused binding is a leading underscore
        // (`_opts`, `_files`, …) — already pervasive before this rule was ever enforced (71 of its 73
        // day-of findings in koine-studio were already `_`-prefixed). The default rule doesn't
        // recognize that idiom, so it is configured to match it rather than forcing every call site to
        // either delete the parameter (breaking a shared signature) or grow an inline disable. A rule
        // OPTION matching established practice — not a suppression (#1821).
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

        // `with-single-extends` (not the default `never`) is the rule's own sanctioned allowance for
        // declaration-MERGING interfaces: each package's `src/vitest-axe.d.ts` augments vitest's
        // `Assertion` / `AsymmetricMatchersContaining` with the vitest-axe matchers, and augmentation
        // only works through an interface — a type alias doesn't merge — so the body is necessarily
        // empty. The rule stays 'error' for genuinely empty declarations; a narrowing, not an
        // exemption (#1720).
        '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      },
    },
  ];
}

/**
 * ADR 0005's standing condition, in one place: the two rules that carry the safety intent
 * `require-await` would otherwise have. #997 extended them over tests and stories too, so every
 * vitest/Storybook site awaits or void-marks its promises exactly like prod code.
 *
 * Relaxing either of these voids the `require-await` exemption in `typeCheckedPreset` above — that is
 * the whole reason they live in the same module. Do not scope them to a subset of files.
 */
export function promiseSafetyGate(tsconfigRootDir) {
  const parserOptions = requireRootDir('promiseSafetyGate', tsconfigRootDir);
  return [
    {
      files: ['src/**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, parserOptions },
      plugins: { '@typescript-eslint': tseslint.plugin },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
      },
    },
  ];
}

/**
 * The react-hooks rules. Both packages ship Preact components, so hook call-order and dependency
 * correctness is a tree-wide concern (one of ADR 0005's four original load-bearing conventions).
 *
 * The plugin is registered for the whole `src/**` glob rather than only where a rule is switched on,
 * because prod code already carries justified `react-hooks/exhaustive-deps` disable directives
 * (koine-studio's DeckStage.tsx, searchController.tsx) and the plugin must be known for those to
 * resolve.
 */
export function reactHooksGate(tsconfigRootDir) {
  const parserOptions = requireRootDir('reactHooksGate', tsconfigRootDir);
  return [
    {
      files: ['src/**/*.{ts,tsx}'],
      languageOptions: { parser: tseslint.parser, parserOptions },
      plugins: { 'react-hooks': reactHooks },
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'error',
      },
    },
  ];
}
