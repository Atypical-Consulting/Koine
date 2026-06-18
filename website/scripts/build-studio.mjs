// Builds Koine Studio's web edition and folds it into the docs-site Pages deploy, so the
// browser IDE is served at `${site}${base}studio/` (i.e. /Koine/studio/). Runs AFTER
// build-wasm.mjs in the prebuild chain so the freshly published Koine.Wasm bundle can be reused
// (the studio's web build needs the same _framework/ AppBundle the Playground uses).
//
// Steps: install the studio's deps → reuse website/public/koine-wasm as the studio's WASM bundle
// → `npm run build:web` (base = /Koine/studio/) → copy the studio's dist into website/public/studio.
//
// Cross-platform; needs only Node's stdlib plus npm + the .NET SDK already on PATH.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(here, '..');
const repoRoot = resolve(websiteDir, '..');
const studioDir = join(repoRoot, 'tooling', 'koine-studio');
const websiteWasm = join(websiteDir, 'public', 'koine-wasm');
const studioWasm = join(studioDir, 'public', 'koine-wasm');
const studioDist = join(studioDir, 'dist');
const dest = join(websiteDir, 'public', 'studio');

// Served under the docs site's base; keep in sync with astro.config.mjs `base: '/Koine/'`.
const STUDIO_BASE = '/Koine/studio/';

function run(cmd, args, cwd, extraEnv = {}) {
  console.log(`> (${cwd}) ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd, env: { ...process.env, ...extraEnv } });
}

// 1. Install the studio's frontend deps (prefer a clean, lockfile-faithful install).
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(npm, existsSync(join(studioDir, 'package-lock.json')) ? ['ci'] : ['install'], studioDir);

// 2. Reuse the WASM bundle the website already published (build-wasm.mjs ran first). Falling back
//    to a fresh studio publish keeps this script runnable on its own.
if (existsSync(join(websiteWasm, '_framework'))) {
  rmSync(studioWasm, { recursive: true, force: true });
  mkdirSync(dirname(studioWasm), { recursive: true });
  cpSync(websiteWasm, studioWasm, { recursive: true });
  console.log(`Reused website WASM bundle → ${studioWasm}`);
} else {
  console.log('website/public/koine-wasm not found — publishing the studio WASM bundle directly.');
  run(npm, ['run', 'build:wasm'], studioDir);
}

// 3. Build the studio web edition at the deploy sub-path.
run(npm, ['run', 'build:web'], studioDir, { KOINE_STUDIO_BASE: STUDIO_BASE });

// 4. Publish it under the docs site so Pages serves it at /Koine/studio/.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(studioDist, dest, { recursive: true });

console.log(`\nKoine Studio (web) built at base ${STUDIO_BASE} and copied to ${dest}`);
