// Makes sure the workspace packages the studio imports at build time are actually installed and
// built before Vite starts. The concrete motivation (issue seen after #905): the studio imports
// `@atypical/koine-ui/styles.css`, which the workspace resolves to
// node_modules/@atypical/koine-ui/dist/styles.css. That symlink + dist only exist after a root
// `npm install` (whose postinstall runs `npm run build --workspace=@atypical/koine-ui`). A
// node_modules tree checked out before koine-ui was extracted has neither, so Vite fails with a
// cryptic "Failed to resolve import '@atypical/koine-ui/styles.css'". Re-running the root install
// links the workspace and rebuilds its dist, fixing both the missing and the stale case.
//
// Wired into the studio's predev/prebuild hooks (alongside generate-templates.mjs / build-wasm.mjs).
// To keep normal `npm run dev` startups fast — and to avoid touching the registry when everything is
// already in place — the install only runs when the resolved artifact is missing or older than the
// koine-ui sources. When it's up to date this is a near-instant no-op.
//
// Cross-platform (Windows/Linux/macOS). No deps beyond Node's stdlib.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const studioDir = resolve(here, '..'); // tooling/koine-studio
const repoRoot = resolve(studioDir, '..', '..'); // repo root (npm workspaces root)

// The exact file `@atypical/koine-ui/styles.css` resolves to once the workspace is installed + built.
const marker = join(repoRoot, 'node_modules', '@atypical', 'koine-ui', 'dist', 'styles.css');
// The sources that marker is built from — if any is newer, the built dist is stale.
const uiSrc = join(repoRoot, 'tooling', 'koine-ui', 'src');

/** Newest mtime (ms) under `dir`, recursively, or 0 if it doesn't exist. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function needsInstall() {
  if (!existsSync(marker)) return 'missing'; // never installed/built (e.g. checkout predates koine-ui)
  if (newestMtime(uiSrc) > statSync(marker).mtimeMs) return 'stale'; // koine-ui edited since last build
  return null;
}

const reason = needsInstall();
if (!reason) {
  console.log('ensure-workspace-deps: @atypical/koine-ui is installed and up to date — skipping install.');
} else {
  console.log(`ensure-workspace-deps: @atypical/koine-ui is ${reason}; running root \`npm install\` to link + build it.`);
  // Run at the workspace root so npm links the workspace symlink and its postinstall builds dist/.
  // --prefer-offline keeps it fast and cache-first (network only for genuinely-missing tarballs);
  // --no-audit/--no-fund trim noise. execSync uses the platform shell, so `npm` resolves on Windows too.
  execSync('npm install --prefer-offline --no-audit --no-fund', { cwd: repoRoot, stdio: 'inherit' });
}
