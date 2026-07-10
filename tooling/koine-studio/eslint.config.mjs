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
const ALL_SELECTORS = [INNER_HTML_ASSIGN_SELECTOR, INSERT_ADJACENT_HTML_SELECTOR, DISPOSED_FLAG_SELECTOR, SEQ_COUNTER_SELECTOR];
function selectorsExcept(...excluded) {
  return ALL_SELECTORS.filter((s) => !excluded.includes(s));
}

export default tseslint.config(
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
  // src/shell/statusBar.tsx hand-rolls the exact same "am I still mounted" disposed flag as the six
  // controllers migrated onto createLifecycleGuard() — lifecycleGuard.ts's own header comment calls this
  // out by name as "the same disposed-only shape but out of this issue's scope — tracked as a follow-up
  // rather than folded in here." So the disposed-flag selector is scoped off for just this file's existing
  // declaration until that follow-up converts it; the Seq-counter selector stays active here (this file
  // has no `…Seq` pattern today, so nothing depends on it being off).
  {
    files: ['src/shell/statusBar.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...selectorsExcept(DISPOSED_FLAG_SELECTOR)],
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
    // retired by #991 (self-contained panels → Preact: welcome/home, about, generate-project wizard)
    files: ['src/welcome/welcome.ts', 'src/settings/about.ts', 'src/export/generateProjectWizard.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
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
    files: ['src/docs/docsPanel.ts', 'src/model/glossary.ts'], // retired by #992 (pure-DOM model/docs builders → JSX)
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // retired across the arc: #991 (domain navigator) + #992 (Properties/docs panels); file also decomposed by #985
    // (the sub-modules it's being split into — src/shell/inspector/** — inherit the SAME exemption while
    // they still carry the moved-verbatim imperative DOM building; each shrinks/drops out as it converts).
    //
    // These six inspector modules were already migrated onto createLifecycleGuard() (#1352), so the
    // disposed/Seq selectors must still apply here even while the (unrelated, still-open) innerHTML
    // exemption stands — hence excluding only the innerHTML pair rather than turning the whole rule off.
    files: ['src/shell/inspectorController.tsx', 'src/shell/inspector/**'],
    rules: {
      'no-restricted-syntax': ['error', ...selectorsExcept(INNER_HTML_ASSIGN_SELECTOR, INSERT_ADJACENT_HTML_SELECTOR)],
    },
  },
  // Tests & stories: the deliberate fire-and-forget promises in vitest fixtures and Storybook play
  // functions are a documented follow-up (fix the ~93 by awaiting), not a prod convention breach.
  // TODO(2026-07-02): await the test/stories promises and drop this `off`; tracked as a PR follow-up.
  {
    files: ['src/**/*.{test,stories}.{ts,tsx}', 'src/test-setup*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      // Tests legitimately probe optional-absence in fixture DOM (getElementById → null is the assertion).
      'no-restricted-properties': 'off',
      // Fixture/DOM setup in vitest and Storybook legitimately writes innerHTML to stage markup.
      'no-restricted-syntax': 'off',
    },
  },
);
