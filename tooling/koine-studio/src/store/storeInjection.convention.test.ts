import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkSourceFiles } from '@/testUtils/walkSourceFiles';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..'); // tooling/koine-studio/src
const ROOT = join(SRC, '..'); // tooling/koine-studio

// Koine Studio's convention (issue #760): controllers/panels receive the `AppStore` as an injected
// dependency (`store: AppStore` — see `inspectorController.tsx`, `domainNavigator.ts`,
// `guardedLoad.ts`, …) so tests and stories can build their own `createAppStore()` instead of sharing
// mutable global state. Only the composition root (`main.ts`/`ide.tsx`), the `useAppStore` React
// binding, and a small, named set of other entry points import the `appStore` SINGLETON directly.
//
// This is a CHARACTERIZATION guard, not an aspiration: it pins today's importers exactly so that a
// future `import { appStore } from '@/store'` added anywhere else fails this test immediately, forcing
// a deliberate choice (inject the store instead, or extend this allowlist with a reviewed reason).
// Shrinking this list (e.g. converting `editorSession.tsx` to injection) is tracked separately and
// should update the allowlist alongside the conversion, not silently.
// `diagramContract.ts` and `theme.ts` (#1351, the opportunistic follow-up tail of #760): re-grepped at
// implementation time and found a SCATTERED fan-out — flat, directly-exported getter/setter functions
// (no factory/deps seam) called from independent composition roots (main.ts's pre-workspace Home route
// welcome/Home.tsx, AND ide.tsx's controller graph), plus a rendering engine (diagrams-maxgraph.ts) and
// settings/command-palette call sites. Forcing every caller to construct/thread a controller would be
// disproportionate churn for a handful of getters/setters with no meaningful behavior to isolate in
// tests — a deliberate, reasoned exception, not deferred debt. Re-verify the fan-out before revisiting.
const ALLOWLIST = [
  'src/ai/aiPanel.ts',
  'src/diagrams/diagramContract.ts',
  'src/main.ts',
  'src/settings/theme.ts',
  'src/shell/explorer.tsx',
  'src/shell/ExplorerPanel.tsx',
  'src/shell/ide.tsx',
  'src/store/hooks.ts',
].sort();

// Matches `import { appStore } from '@/store'` / `'@/store/index'`, in any named-import position
// (`import { appStore, type AppState } from …` etc.) and across a wrapped multi-line import.
const IMPORT_SINGLETON_RE = /import\s*\{[^}]*\bappStore\b[^}]*\}\s*from\s*['"]@\/store(?:\/index)?['"]/;

describe('store injection convention (issue #760)', () => {
  it('only the documented allowlist imports the appStore singleton', () => {
    const importers = walkSourceFiles(SRC, { excludeFile: /\.(test|spec|stories)\./ })
      .filter((f) => IMPORT_SINGLETON_RE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .sort();
    // Custom failure message: the bare array diff Vitest prints below is accurate but doesn't say
    // *what to do about it*, so spell that out for whoever breaks this next.
    const message =
      `store injection convention (issue #760) violated.\n\n` +
      `Controllers and panels must take the store as an injected dependency (\`store: AppStore\`), ` +
      `not read the \`appStore\` singleton directly — see src/shell/inspectorController.tsx, ` +
      `src/model/domainNavigator.ts, src/shell/guardedLoad.ts for the pattern.\n\n` +
      `Only the files listed in ALLOWLIST above may \`import { appStore } from '@/store'\`. If the ` +
      `diff below shows a NEW file, either:\n` +
      `  1. inject the store instead of importing the singleton, or\n` +
      `  2. if this really is composition-root/binding code, add it to ALLOWLIST here with a ` +
      `comment explaining why.\n` +
      `If the diff shows a file MISSING that you just converted to injection, remove it from ` +
      `ALLOWLIST alongside the conversion.`;
    expect(importers, message).toEqual(ALLOWLIST);
  });
});
