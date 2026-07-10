import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursively collect `.ts`/`.tsx` source file paths under `dir`. Shared by the codebase's
 * walk-and-regex characterization guards — `src/host/seamGuard.test.ts` and
 * `src/store/storeInjection.convention.test.ts` — which scan the whole `src/` tree for a banned or
 * tracked import/usage pattern. Both guards previously carried their own near-identical copy of this
 * function; this is the single extracted implementation (parameterized so each guard's exact prior
 * behavior — its own directory skip and filename-exclusion regex — is preserved).
 *
 * @param dir the directory to walk, recursively.
 * @param opts.skipDir called with a directory's full path before recursing into it; return `true` to
 *   skip the whole subtree (e.g. seamGuard.test.ts skips `src/host`, the one place platform-identity
 *   branching is allowed).
 * @param opts.excludeFile a regex tested against a file's bare name (not its full path); a match
 *   excludes the file from the result (e.g. `.test.`/`.spec.`/`.stories.` files).
 */
export function walkSourceFiles(
  dir: string,
  opts: { skipDir?: (path: string) => boolean; excludeFile?: RegExp } = {},
): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return opts.skipDir?.(p) ? [] : walkSourceFiles(p, opts);
    if (!/\.(ts|tsx)$/.test(name)) return [];
    if (opts.excludeFile?.test(name)) return [];
    return [p];
  });
}
