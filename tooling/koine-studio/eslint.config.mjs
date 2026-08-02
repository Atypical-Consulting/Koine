import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Flat-config ESLint gate for the Studio frontend (#978). Deliberately narrow: it encodes the four
// load-bearing safety conventions (void-prefixed promises, domById, escape-before-innerHTML, and the
// react-hooks rules) rather than a full style regime — tsc + review stay authoritative for style.
// Type-aware rules run against tsconfig.json (include: ["src"]) via parserOptions.projectService.

// Any `x.innerHTML = …` / `x.outerHTML = …` (and `+=`). The escape-before-innerHTML contract
// (editor/markdown.ts) lives outside the type system, so these HTML-injection sinks are banned
// by default: use textContent / el() / JSX, or renderMarkdown output behind a justified
// same-line disable, or an allow-listed island below.
const INNER_HTML_ASSIGN_SELECTOR = {
  selector: "AssignmentExpression[left.property.name=/^(inner|outer)HTML$/]",
  message: 'Assigning innerHTML/outerHTML is an XSS sink. Use textContent/el()/JSX; renderMarkdown output only, behind a justified disable; imperative islands are allow-listed in eslint.config.mjs.',
};

// The same sink in call form. No prod site exists today (grep-verified); banned so a new one
// can't slip in past the assignment ban above.
const INSERT_ADJACENT_HTML_SELECTOR = {
  selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
  message: 'insertAdjacentHTML is an XSS sink. Use textContent/el()/JSX or an allow-listed island; only already-trusted/escaped markup, behind a justified disable.',
};

// The JSX form of the same sink (final #992 review, Finding 3). Only `src/docs/MdHtml.tsx` and
// `src/ai/components/MdHtml.tsx` are sanctioned (each is documented as THE ONLY permitted site for
// its subsystem, behind a renderer that HTML-escapes the whole input up front) — both turn this
// selector back off below. Everywhere else, a new raw-HTML site must not slip in past the
// assignment/call bans above.
const DANGEROUS_HTML_JSX_SELECTOR = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message: 'dangerouslySetInnerHTML is an XSS sink. Compose the sanctioned MdHtml component (src/docs/MdHtml.tsx or src/ai/components/MdHtml.tsx) instead of adding a new raw-HTML site.',
};

// Hand-rolled disposed flag (#1352): the six lifecycle-owning modules that used to declare
// `let disposed = false` now share createLifecycleGuard(). A bare re-roll loses the guard's
// idempotent dispose()/isDisposed() contract, so it's banned; use createLifecycleGuard() from
// @/shared/lifecycleGuard instead.
const DISPOSED_FLAG_SELECTOR = {
  selector: "VariableDeclarator[id.name='disposed'][init.value=false]",
  message: 'Hand-rolled `let disposed = false` is banned (#1352). Use createLifecycleGuard() from @/shared/lifecycleGuard instead.',
};

// Hand-rolled monotonic sequence counter (#1352): same migration as the disposed flag above —
// createLifecycleGuard() also owns the request/async-sequence counter previously hand-rolled as
// `let xSeq = 0`.
const SEQ_COUNTER_SELECTOR = {
  selector: "VariableDeclarator[id.name=/Seq$/][init.value=0]",
  message: 'Hand-rolled `let xSeq = 0` sequence counter is banned (#1352). Use createLifecycleGuard() from @/shared/lifecycleGuard instead.',
};

// Every syntax selector this gate can enforce, in one place. Several per-file overrides below need to
// re-declare `no-restricted-syntax` for a file that's exempt from SOME but not all of these — ESLint flat
// config REPLACES a rule's array per matching file rather than merging across blocks, so an override can't
// just turn one selector off. `selectorsExcept(...)` expresses that override as "everything except the
// named exceptions" — an opt-out list, matching this file's existing allow-list idiom below — instead of
// each override hand-listing which selectors it wants included (an opt-in list silently drifts: a future
// 5th selector added to ALL_SELECTORS applies everywhere by default here, with no override needing an edit
// unless it specifically wants to exempt the new one).
const ALL_SELECTORS = [INNER_HTML_ASSIGN_SELECTOR, INSERT_ADJACENT_HTML_SELECTOR, DANGEROUS_HTML_JSX_SELECTOR, DISPOSED_FLAG_SELECTOR, SEQ_COUNTER_SELECTOR];
function selectorsExcept(...excluded) {
  return ALL_SELECTORS.filter((s) => !excluded.includes(s));
}

// ── #998: the tseslint.configs.recommendedTypeChecked ratchet ────────────────────────────────────
// ADR 0005 deferred the full type-checked preset (measured at ~1,300 findings at #993 time; 1,961 on
// a fresh 2026-07-31 measurement) because adopting it wholesale would have been an unreviewable PR.
// #998 adopts it as an INVERTED ALLOW-LIST instead: the whole preset is on, and every rule that still
// has findings is listed here as 'off' with its live count. Each ratchet PR fixes one rule's findings
// and DELETES its entry — the table only ever shrinks, so the gate monotonically tightens and the
// remaining debt is visible in the config itself rather than in a wiki nobody reads.
//
// Rules NOT listed here are already enforced at 'error' by the preset (30 of its 47 were clean on day
// one; the 8 cheapest of the remaining 17 were fixed and enforced in the PR that opened this table
// (#1720); `no-unsafe-argument` was the 9th (#1785), `no-unsafe-assignment` the 10th (#1814),
// `no-explicit-any` the 11th (#1817), `no-unsafe-call`/`no-unsafe-member-access` the 12th/13th —
// fixed together since #1817's `no-explicit-any`/`no-unsafe-assignment` fixes had already collapsed
// their finding counts from the ~1,700-finding day-one measurement down to 5/32 (test-only sites: a
// `ReturnType<typeof vi.fn>` cast that erased a mock's real parameter types, a couple of bare `vi.fn()`
// mocks with no signature, and two unannotated `JSON.parse` results) — each fixed and enforced in its
// own follow-up PR that removed it — and `no-unused-vars` the 14th: configured below with an
// underscore ignore pattern (matching the codebase's pre-existing, pervasive `_name` convention for
// deliberately-unused bindings — 71 of its 73 day-of findings were already `_`-prefixed identifiers
// the default rule doesn't recognize) plus two genuine fixes (a dangling type-only import, and a
// declaration-merging interface's unused type parameter renamed to match the pattern).
// Burn-down order is cheapest-first. Counts are LIVE — re-measure before editing this table, with
// `npx eslint . -f json` under a config that adds the preset with no `off` entries, grouped by rule.
// Invariants: never re-add an entry; never clear one with a blanket `eslint-disable`; and burn a rule
// down across BOTH front-end packages in the same PR, so a rule is never half-enforced across the tree
// (the per-directory ratchet #998 considered and rejected) — koine-ui carries the mirror table.
const RATCHET_PENDING = {
  '@typescript-eslint/require-await': 'off', //                 490 findings / 63 files
  '@typescript-eslint/unbound-method': 'off', //                570 findings / 62 files
};

export default tseslint.config(
  // scripts/generate-templates.mjs writes this 180KB machine-generated module into src/ (git-ignored,
  // regenerated on every dev/build/test). It happens to be clean under the preset today, but it is not
  // hand-maintained code and a generator change must never be able to fail the lint gate — and CI runs
  // `npm run lint` right after `npm ci`, i.e. before the file even exists, so linting it locally-only
  // would make the gate depend on build order. Excluded outright.
  { ignores: ['src/templates.generated.ts'] },
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
      // The codebase's pre-existing convention for a deliberately-unused binding is a leading
      // underscore (`_opts`, `_files`, …) — already pervasive across the tree before this rule was
      // ever enforced. The default rule doesn't recognize that idiom, so it's configured to match it
      // rather than forcing every call site to either delete the parameter (breaking a shared
      // signature) or grow an inline disable.
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
      // declaration-MERGING interfaces: src/vitest-axe.d.ts augments vitest's `Assertion` /
      // `AsymmetricMatchersContaining` with the vitest-axe matchers, and augmentation only works
      // through an interface — a type alias doesn't merge — so the body is necessarily empty. The rule
      // stays 'error' for genuinely empty declarations; this is a narrowing, not a ratchet exemption.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      // `ignoreReadBeforeAssign` (off by default) exempts the forward-declaration idiom this codebase
      // uses for mutually-referencing controllers — `let workspace: WorkspaceController;` read by a
      // thunk defined above its single assignment (ide.tsx, inspectorController.tsx,
      // workspaceController.ts, scopeKit.ts, wasm.ts). Those CANNOT be `const`: the declaration and the
      // assignment are deliberately separated, so the default rule demands an impossible edit (and its
      // autofix would produce code that doesn't compile). Genuinely-const `let`s are still reported.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    // react-hooks is registered here (not only where rules-of-hooks is added) because prod code already
    // carries justified `react-hooks/exhaustive-deps` disable directives (DeckStage.tsx, searchController.tsx);
    // the plugin must be known for those to resolve, and exhaustive-deps is already clean (0 unsuppressed).
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-properties': ['error', {
        object: 'document',
        property: 'getElementById',
        message: 'Use domById (src/shared/domById.ts) so a missing #id throws loudly instead of a silent null.',
      }],
      'no-restricted-syntax': ['error', ...ALL_SELECTORS],
    },
  },
  // src/shared/lifecycleGuard.ts is the primitive itself: it legitimately declares `let disposed = false`
  // and its own sequence counter (`let current = 0`) inside the implementation. Exempt it from the two
  // #1352 selectors only — the XSS-sink bans still apply.
  {
    files: ['src/shared/lifecycleGuard.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...selectorsExcept(DISPOSED_FLAG_SELECTOR, SEQ_COUNTER_SELECTOR)],
    },
  },
  // src/ai/ai.ts's `toolCallSeq` and src/shared/ids.ts's `idSeq` are plain monotonic id-minting counters
  // (correlating UI tool-call start/end events, and generating a no-crypto fallback unique id,
  // respectively) — not the createLifecycleGuard staleness sequence, which is minted via createSequence()
  // and compared post-await through isCurrent(). They only collide with the #1352 Seq selector on name
  // shape (`…Seq` initialized to 0); the disposed-flag selector still applies to both files (neither has
  // that pattern today).
  {
    files: ['src/ai/ai.ts', 'src/shared/ids.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...selectorsExcept(SEQ_COUNTER_SELECTOR)],
    },
  },
  // Sanctioned dangerouslySetInnerHTML sites (final #992 review, Finding 3): the ONLY two files permitted
  // to use the JSX `dangerouslySetInnerHTML` attribute banned above. Each is documented in its own file
  // as THE ONLY permitted raw-HTML site for its subsystem — `src/docs/MdHtml.tsx` for the Docs (ADR/Notes)
  // pages (#992 task 5), `src/ai/components/MdHtml.tsx` for assistant content (#990) — and both render
  // behind a Markdown renderer that HTML-escapes the whole input up front before any formatting, so no raw
  // markup can reach the DOM (see each file's header comment, and `MdHtml.test.tsx` for the pinned
  // hostile-input regression). A THIRD site must not slip in silently: this is a two-entry allow-list, not
  // a wildcard — any other file adding `dangerouslySetInnerHTML` stays fully gated by the rule above.
  {
    files: ['src/docs/MdHtml.tsx', 'src/ai/components/MdHtml.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Permanent imperative islands (CONTRIBUTING non-goals): CodeMirror (editor), maxGraph
  // (diagrams-maxgraph), and the host seam build DOM imperatively by nature — innerHTML there is
  // inherent to the library boundary, not a migration debt, so the ban is permanently off for them.
  // This blanket 'off' also happens to cover src/host/browser/wasm.ts's `let loaderSeq = 0` (a plain
  // id-minting counter, same shape as ai.ts's/ids.ts's exempted ones above) — noted here so a future
  // narrowing of this block doesn't unexpectedly trip the #1352 Seq selector on it with no exemption on
  // record; add wasm.ts to a selectorsExcept(SEQ_COUNTER_SELECTOR) override at that point if needed.
  {
    files: ['src/editor/**', 'src/diagrams/diagrams-maxgraph.ts', 'src/host/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // ── Pending-migration imperative islands ──────────────────────────────────────────────────────────
  // Each entry EXEMPTS one already-imperative panel from the innerHTML ban until the named migration issue
  // converts it to Preact/JSX, then the entry is DELETED. This is a FILE-level allow-list, not a per-file
  // count budget: it freezes the *set of files* permitted to use innerHTML — any NEW file, and all
  // non-island prod, stays fully gated — and shrinks as the arc lands. (A file that's already listed can
  // still add innerHTML while listed; that's the accepted cost of a zero-rewrite adoption, à la #757's
  // freeze-then-shrink direction.)
  {
    // retired when the settings form is Preact-converted (migrated with the panels arc #991). #987 split
    // the settings form's innerHTML sites across three files (the category-tab icons stayed in prefs.ts;
    // the chip-list clear in prefsControls.ts; the type specimen in prefsSections/editor.ts) — all three
    // stay listed until the Preact conversion, per the same freeze-then-shrink discipline as the rest of
    // this table.
    files: [
      'src/settings/prefs.ts',
      'src/settings/prefsControls.ts',
      'src/settings/prefsSections/editor.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // src/shell/inspectorController.tsx itself was fully converted to JSX by #992 (Properties/docs
    // panels) and no longer has an innerHTML/insertAdjacentHTML site, so it's dropped from this glob
    // (#1386). What remains — src/shell/inspector/**, the #985 decomposition's sub-modules — is exempt
    // for an unrelated, still-open reason: contextMapPanel.tsx (maxGraph-rendered context-map tooltips
    // and table HTML) and surfaceLoaders.tsx (imperative status/result markup), plus the shared
    // docMessage() helper in shared.ts they both call, still build DOM imperatively; each shrinks/drops
    // out of this list as it converts.
    //
    // These modules were already migrated onto createLifecycleGuard() (#1352), so the disposed/Seq
    // selectors must still apply here even while the innerHTML exemption stands — hence excluding only
    // the innerHTML pair rather than turning the whole rule off.
    files: ['src/shell/inspector/**'],
    rules: {
      'no-restricted-syntax': ['error', ...selectorsExcept(INNER_HTML_ASSIGN_SELECTOR, INSERT_ADJACENT_HTML_SELECTOR)],
    },
  },
  // Tests & stories: no-floating-promises is fully enforced here too (#997) — every vitest/Storybook
  // site now awaits or void-marks its promises, same as prod code.
  {
    files: ['src/**/*.{test,stories}.{ts,tsx}', 'src/test-setup*.ts'],
    rules: {
      // Tests legitimately probe optional-absence in fixture DOM (getElementById → null is the assertion).
      'no-restricted-properties': 'off',
      // Fixture/DOM setup in vitest and Storybook legitimately writes innerHTML to stage markup.
      'no-restricted-syntax': 'off',
    },
  },
);
