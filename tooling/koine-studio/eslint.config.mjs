import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Flat-config ESLint gate for the Studio frontend (#978). Deliberately narrow: it encodes the four
// load-bearing safety conventions (void-prefixed promises, domById, escape-before-innerHTML, and the
// react-hooks rules) rather than a full style regime — tsc + review stay authoritative for style.
// Type-aware rules run against tsconfig.json (include: ["src"]) via parserOptions.projectService.
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
      'no-restricted-syntax': [
        'error',
        {
          // Any `x.innerHTML = …` / `x.outerHTML = …` (and `+=`). The escape-before-innerHTML contract
          // (editor/markdown.ts) lives outside the type system, so these HTML-injection sinks are banned
          // by default: use textContent / el() / JSX, or renderMarkdown output behind a justified
          // same-line disable, or an allow-listed island below.
          selector: "AssignmentExpression[left.property.name=/^(inner|outer)HTML$/]",
          message: 'Assigning innerHTML/outerHTML is an XSS sink. Use textContent/el()/JSX; renderMarkdown output only, behind a justified disable; imperative islands are allow-listed in eslint.config.mjs.',
        },
        {
          // The same sink in call form. No prod site exists today (grep-verified); banned so a new one
          // can't slip in past the assignment ban above.
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is an XSS sink. Use textContent/el()/JSX or an allow-listed island; only already-trusted/escaped markup, behind a justified disable.',
        },
        {
          // The JSX form of the same sink. Only `src/docs/MdHtml.tsx` and `src/ai/components/MdHtml.tsx`
          // are sanctioned (each is documented as THE ONLY permitted site for its subsystem, behind a
          // renderer that HTML-escapes the whole input up front) — both turn this selector back off below.
          // Everywhere else, a new raw-HTML site must not slip in past the assignment/call bans above.
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is an XSS sink. Compose the sanctioned MdHtml component (src/docs/MdHtml.tsx or src/ai/components/MdHtml.tsx) instead of adding a new raw-HTML site.',
        },
      ],
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
    // retired across the arc: #991 (domain navigator) + #992 (Properties/docs panels); file also decomposed by #985
    // (the sub-modules it's being split into — src/shell/inspector/** — inherit the SAME exemption while
    // they still carry the moved-verbatim imperative DOM building; each shrinks/drops out as it converts).
    files: ['src/shell/inspectorController.tsx', 'src/shell/inspector/**'],
    rules: { 'no-restricted-syntax': 'off' },
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
