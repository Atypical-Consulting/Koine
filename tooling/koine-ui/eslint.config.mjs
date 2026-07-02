import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Flat-config ESLint gate for the shared UI package (#978). Same safety conventions as koine-studio —
// void-prefixed promises, domById-over-getElementById, escape-before-innerHTML, and the react-hooks
// rules (the package ships Preact components) — minus the studio-specific imperative-island allow-list.
// Type-aware rules run against tsconfig.json (include: ["src"]) via parserOptions.projectService.
export default tseslint.config(
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
  // Tests & stories legitimately stage fixture markup (innerHTML), probe optional-absence in the DOM
  // (getElementById → null), and fire-and-forget promises.
  {
    files: ['src/**/*.{test,stories}.{ts,tsx}', 'src/test-setup*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
