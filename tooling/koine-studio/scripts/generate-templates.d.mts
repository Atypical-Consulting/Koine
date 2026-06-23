// Type declarations for the template-manifest generator (a plain .mjs so it can run under bare
// `node` with no build step). Lets the Vite config and the vitest suite import its pure core with
// full typing. Keep in sync with scripts/generate-templates.mjs.
import type { Template } from '../src/welcome/templates';

/** Resolve the repo's top-level `templates/` directory (robust to a git worktree layout). */
export function resolveTemplatesDir(): string;

/** Read every template folder under `templatesDir` and assemble the `Template[]`. */
export function collectTemplates(templatesDir: string): Template[];

/** Render the generated TypeScript module source for a `Template[]`. */
export function renderManifest(templates: Template[]): string;

/** Resolve the real templates dir, collect, and write `src/templates.generated.ts`; returns its path. */
export function generate(): string;
