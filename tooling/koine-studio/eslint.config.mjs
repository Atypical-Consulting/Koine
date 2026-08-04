import tseslint from 'typescript-eslint';
import { typeCheckedPreset, promiseSafetyGate, reactHooksGate } from '@atypical/eslint-config';

// Flat-config ESLint gate for the Studio frontend (#978). Deliberately narrow: it encodes the four
// load-bearing safety conventions (void-prefixed promises, domById, escape-before-innerHTML, and the
// react-hooks rules) rather than a full style regime — tsc + review stay authoritative for style.
// Type-aware rules run against tsconfig.json (include: ["src"]) via parserOptions.projectService.
//
// ── What lives here vs in @atypical/eslint-config (#1924) ────────────────────────────────────────
// The rule DECISIONS this package shares with koine-ui — the `recommendedTypeChecked` preset, the ADR
// 0005 `require-await` exemption, the `no-unused-vars` `^_` narrowing, the `no-empty-object-type`
// narrowing, the `no-floating-promises`/`no-misused-promises` pair that ADR 0005's exemption depends
// on, and the react-hooks rules — live ONCE in `tooling/eslint-config`, with their justifications
// (including the #998 ratchet's full outcome), and are spread in below. They are no longer mirrored by
// hand: `scripts/ci/check-eslint-config-parity.mjs` asserts in CI that both packages resolve to the
// same setting for every shared rule, so #998's invariant — a rule is never half-enforced across the
// tree — fails the build rather than review.
//
// What stays in this file is everything grounded in THIS package's own code: the imperative-island
// allow-list, the #1352 lifecycle selectors, the sanctioned dangerouslySetInnerHTML sites, the
// `src/templates.generated.ts` ignore, and the `prefer-const` narrowing (justified by a
// forward-declaration idiom that exists only in Studio's controllers). #998's standing invariants
// still bind: never re-add a burned-down rule as 'off', never clear a finding with a blanket
// `eslint-disable`, and change a shared rule in the shared module — never in one package only.

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
// listed as 'off' with its live count, one rule fixed and DELETED per PR — and that table is now GONE.
// Of the preset's 47 rules, 46 ARE ENFORCED AT 'error'; the 47th, `require-await`, is EXEMPT BY
// DECISION, not deferred. The exemption, its measurement and its standing condition now live in
// `tooling/eslint-config` (#1924) rather than being mirrored into this file and koine-ui's — that is
// what `typeCheckedPreset(...)` brings in below.
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
// `unbound-method` is worth remembering because it set the precedent the exemption rests on: its
// 570+22 findings were investigated rather than swept, and NOT ONE was a real lost-`this` bug — every
// receiver is a closure-built callback bag or a factory handle, no class instance, no `this` in any
// body. The rule was firing on DECLARATION STYLE (`onCreateAdr(t: string): void` is a method,
// detachable-and-may-lose-`this`; `onCreateAdr: (t: string) => void` is an explicitly detachable
// function-valued property), so the fix declared the truth rather than suppressing the rule — and paid
// off, because property signatures check parameters CONTRAVARIANTLY under `strictFunctionTypes` where
// method signatures are bivariant, which immediately surfaced two genuinely unsound `emitPreview` test
// doubles. The residue the conversion can't reach is DOM/lib-declared
// (`Element.prototype.scrollIntoView`, `HTMLElement.prototype.focus`, `window.matchMedia`,
// `navigator.clipboard.writeText`): those sites round-trip the property DESCRIPTOR instead of reading
// the method as a value.

export default tseslint.config(
  // scripts/generate-templates.mjs writes this 180KB machine-generated module into src/ (git-ignored,
  // regenerated on every dev/build/test). It happens to be clean under the preset today, but it is not
  // hand-maintained code and a generator change must never be able to fail the lint gate — and CI runs
  // `npm run lint` right after `npm ci`, i.e. before the file even exists, so linting it locally-only
  // would make the gate depend on build order. Excluded outright.
  { ignores: ['src/templates.generated.ts'] },
  // The full type-checked preset plus the rule decisions shared with koine-ui (see the header note).
  // Placed first so the narrow #978 gate below stays the last word on the rules it names explicitly.
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
      // `ignoreReadBeforeAssign` (off by default) exempts the forward-declaration idiom THIS package
      // uses for mutually-referencing controllers — `let workspace: WorkspaceController;` read by a
      // thunk defined above its single assignment (ide.tsx, inspectorController.tsx,
      // workspaceController.ts, scopeKit.ts, wasm.ts). Those CANNOT be `const`: the declaration and the
      // assignment are deliberately separated, so the default rule demands an impossible edit (and its
      // autofix would produce code that doesn't compile). Genuinely-const `let`s are still reported.
      // Studio-only, hence not in the shared module: koine-ui has no such idiom, so narrowing the rule
      // there would loosen it for no reason on record.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
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
