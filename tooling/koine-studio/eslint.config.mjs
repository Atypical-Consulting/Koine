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

// ── #998: the tseslint.configs.recommendedTypeChecked ratchet — COMPLETE ─────────────────────────
// ADR 0005 deferred the full type-checked preset (measured at ~1,300 findings at #993 time; 1,961 on
// a fresh 2026-07-31 measurement) because adopting it wholesale would have been an unreviewable PR.
// #998 adopted it as an INVERTED ALLOW-LIST instead — the whole preset on, every still-noisy rule
// listed here as 'off' with its live count, one rule fixed and DELETED per PR — and that table is now
// GONE. Of the preset's 47 rules, 46 ARE ENFORCED AT 'error'; the 47th, `require-await`, is EXEMPT
// BY DECISION (below), not deferred. There is no unfinished work left in this block: an 'off' entry
// here now means an ADR says why, and nothing else may be added without one.
//
// How the 17 noisy rules landed (30 of the 47 were clean on day one and went straight to 'error'):
// #1720 fixed the 8 cheapest in the PR that opened the table (`no-empty-object-type`,
// `no-redundant-type-constituents`, `restrict-template-expressions`, `await-thenable`, `prefer-const`,
// `no-base-to-string`, `prefer-promise-reject-errors`, `no-unsafe-return`); then `no-unsafe-argument`
// (#1785), `no-unsafe-assignment` (#1814), `no-explicit-any` (#1817),
// `no-unsafe-call`/`no-unsafe-member-access` (#1818 — fixed together, since #1817's fixes had already
// collapsed their counts from the ~1,700-finding day-one measurement down to 5/32 test-only sites),
// `no-unused-vars` (#1821), `no-unnecessary-type-assertion` (#1823 — autofixable, but `eslint --fix`
// alone was a FALSE green: a full `tsc --noEmit` afterward surfaced ~40 compile errors, because several
// "unnecessary" assertions were also flowing backward as the contextual type of a generic call), and
// `unbound-method` (#1826). ADR 0005's close-out addendum carries the same table with day-one counts.
//
// `unbound-method` is worth remembering because it set the precedent this block rests on: its 570+22
// findings were investigated rather than swept, and NOT ONE was a real lost-`this` bug — every receiver
// is a closure-built callback bag or a factory handle, no class instance, no `this` in any body. The
// rule was firing on DECLARATION STYLE (`onCreateAdr(t: string): void` is a method, detachable-and-may-
// lose-`this`; `onCreateAdr: (t: string) => void` is an explicitly detachable function-valued property),
// so the fix declared the truth rather than suppressing the rule — and paid off, because property
// signatures check parameters CONTRAVARIANTLY under `strictFunctionTypes` where method signatures are
// bivariant, which immediately surfaced two genuinely unsound `emitPreview` test doubles. The residue
// the conversion can't reach is DOM/lib-declared (`Element.prototype.scrollIntoView`,
// `HTMLElement.prototype.focus`, `window.matchMedia`, `navigator.clipboard.writeText`): those sites
// round-trip the property DESCRIPTOR instead of reading the method as a value.
//
// Standing invariants (they outlive the ratchet): never re-add a burned-down rule as 'off'; never clear
// a finding with a blanket `eslint-disable`; and change a rule across BOTH front-end packages in the
// same PR, so it is never half-enforced across the tree (the per-directory ratchet #998 considered and
// rejected). koine-ui's config mirrors this block. A preset upgrade that lands new findings gets fixed
// — or, if it clears the evidence bar the exemption below sets (findings classified one by one, and a
// named reason the rule doesn't earn its keep here), recorded as its own ADR addendum.

// ── The one recorded exemption (ADR 0005 close-out addendum, #1827) ──────────────────────────────
// NOT a ratchet entry. `require-await` was measured and classified finding-by-finding TWICE (490/63 at
// #1826, 492/63 on re-measure at #1920) and the rule's premise does not hold in this codebase: 339 are
// `vi.fn(async …)`/`mockImplementation(async …)` test doubles, 111 are async callbacks passed where an
// async signature is expected, 1 is an async generator, 37 are members with an explicit `Promise<T>`
// return type, and 4 were `test(…, async () =>` bodies with a droppable `async` (dropped in #1920).
// ZERO are a forgotten `await`. All 13 non-test sites implement a Promise-typed contract — `FsFileHandle`
// / `FsDirHandle` (host/browser/fs.ts), `KoineHost` (host/browser/index.ts, host/tauri.ts),
// `LspTransport` (host/browser/transport.ts), `runEditToolStaging` (ai/assistantTools.ts).
//
// Two reasons, both load-bearing:
//  1. The bug class this rule exists to catch — a promise created and never awaited — is ALREADY caught
//     here by `no-floating-promises` AND `no-misused-promises`, both at 'error' in prod code and in
//     tests/stories since #997. On this codebase `require-await` reports a declaration style, not a defect.
//  2. Satisfying it is a BEHAVIOUR CHANGE, not a refactor: rewriting ~486 deliberate `async` bodies to
//     `Promise.resolve(…)` converts every `throw` in them from a REJECTION into a SYNCHRONOUS throw, and
//     several prod sites throw on purpose (`MemDir.getFileHandle`/`getDirectoryHandle`/`removeEntry`).
//
// STANDING CONDITION — this exemption depends on reason 1, so it holds ONLY while `no-floating-promises`
// and `no-misused-promises` both stay at 'error' in BOTH packages, tests and stories included. If either
// is relaxed, narrowed in file scope, or downgraded, DELETE this block and revisit the rule. #1827's
// Option A specifies the honest way to enforce it instead: staged per-directory, every throwing site
// first covered by a test asserting `await expect(...).rejects.toThrow(...)`.
const ADR_0005_EXEMPT = {
  '@typescript-eslint/require-await': 'off', // exempt per ADR 0005 close-out addendum — see #1827
};

export default tseslint.config(
  // scripts/generate-templates.mjs writes this 180KB machine-generated module into src/ (git-ignored,
  // regenerated on every dev/build/test). It happens to be clean under the preset today, but it is not
  // hand-maintained code and a generator change must never be able to fail the lint gate — and CI runs
  // `npm run lint` right after `npm ci`, i.e. before the file even exists, so linting it locally-only
  // would make the gate depend on build order. Excluded outright.
  { ignores: ['src/templates.generated.ts'] },
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
