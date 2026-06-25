// Publishes the Koine.Wasm browser module and copies its AppBundle (_framework + loader)
// into website/public/koine-wasm/ so Astro serves it as a static asset and bundles it into
// dist/. Run via `npm run build:wasm`; invoked automatically by predev/prebuild.
//
// Cross-platform (Windows/Linux CI). No deps beyond Node's stdlib.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const websiteDir = resolve(here, '..');
const repoRoot = resolve(websiteDir, '..');
const project = join(repoRoot, 'src', 'Koine.Wasm', 'Koine.Wasm.csproj');
const dest = join(websiteDir, 'public', 'koine-wasm');

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot });
}

// The wasm SDK writes the browser AppBundle to bin/Release/net10.0/browser-wasm/AppBundle — the
// directory that contains `_framework`. Search broadly and prefer the AppBundle/publish output.
const searchRoot = join(repoRoot, 'src', 'Koine.Wasm', 'bin', 'Release');
const srcDir = join(repoRoot, 'src', 'Koine.Wasm');

function findFrameworkDirs(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!statSync(full).isDirectory()) continue;
      if (entry === '_framework') found.push(dir); // the PARENT of _framework
      else stack.push(full);
    }
  }
  return found;
}

// Locate the published AppBundle (the parent of `_framework`), or null when nothing is published yet.
function locateBundle() {
  const candidates = findFrameworkDirs(searchRoot);
  return (
    candidates.find((d) => d.includes('AppBundle')) ??
    candidates.find((d) => d.includes('publish')) ??
    candidates[0] ??
    null
  );
}

// Newest mtime among the wasm SOURCES — *.cs / *.csproj plus main.js — skipping bin/ and obj/ so the
// already-published bundle never counts as its own input.
function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === 'bin' || entry === 'obj') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (/\.(cs|csproj)$/.test(entry) || entry === 'main.js')
      newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

// Newest mtime of any file under the published bundle's _framework, or 0 when nothing is there. We
// deliberately do NOT key on a single named file (e.g. dotnet.js): SDK-shipped framework files keep
// the runtime pack's timestamp, not the publish time, so they read as stale. The app assembly and
// boot manifest ARE re-stamped on every publish, so the directory's newest file marks when this
// bundle was last produced.
function newestBundleMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) newest = Math.max(newest, newestBundleMtime(full));
    else newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

// Freshness guard (issue #342). The docs-site/Studio deploy invokes build-wasm.mjs 2–3× per run
// (explicit step + Astro `prebuild` + studio `prebuild:web`), each publishing the SAME bundle. Now
// that AOT is on for the deploy (#327) the first publish is ~5× slower, so reuse it instead of
// relying on MSBuild's incremental cache: the first invocation publishes, later ones in the same
// deploy find a freshly-published `_framework` (its newest file newer than every source) and skip.
// `KOINE_WASM_FORCE=1` forces a publish (clean builds / escape hatch). The dev loop is unaffected —
// a fresh checkout has no bundle, so it publishes.
function bundleIsFresh(frameworkDir, sourceDir) {
  if (/^(1|true|yes)$/i.test(process.env.KOINE_WASM_FORCE ?? '')) return false;
  const newestBundle = newestBundleMtime(frameworkDir);
  if (newestBundle === 0) return false; // nothing published yet
  return newestBundle >= newestSourceMtime(sourceDir);
}

// 1. Publish the wasm browser app unless a fresh bundle already exists. AOT-compile (issue #327) only
//    when KOINE_WASM_AOT is truthy — the deployed docs build (deploy-docs.yml) sets it so users get
//    the faster compiler, while a local `npm run dev`/`build` (run via predev/prebuild) stays on the
//    fast interpreter publish unless you opt in. AOT relies on the wasm-tools workload only.
const aot = /^(1|true|yes)$/i.test(process.env.KOINE_WASM_AOT ?? '');
let bundleDir = locateBundle();
if (bundleDir && bundleIsFresh(join(bundleDir, '_framework'), srcDir)) {
  console.log(`Koine wasm: reusing fresh bundle (${bundleDir})`);
} else {
  console.log(`Koine wasm: publishing — AOT ${aot ? 'ON (KOINE_WASM_AOT)' : 'off (interpreter)'}`);
  run('dotnet', ['publish', project, '-c', 'Release', '--nologo', `-p:KoineWasmAot=${aot}`]);
  bundleDir = locateBundle(); // re-locate: the publish may have created the output path
}

if (!bundleDir) {
  console.error(
    `\nERROR: no _framework/ found under ${searchRoot}.\n` +
      `The wasm publish did not produce a browser AppBundle. Ensure the 'wasm-experimental'\n` +
      `workload is installed:  dotnet workload install wasm-experimental\n`,
  );
  process.exit(1);
}

// 2. Replace website/public/koine-wasm/ with the fresh bundle (_framework + main.js).
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(bundleDir, '_framework'), join(dest, '_framework'), { recursive: true });
const mainJs = join(bundleDir, 'main.js');
if (existsSync(mainJs)) cpSync(mainJs, join(dest, 'main.js'));

console.log(`\nKoine wasm bundle copied to ${dest}`);
