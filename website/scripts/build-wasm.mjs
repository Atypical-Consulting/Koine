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

// 1. Publish the wasm browser app. AOT-compile the bundle (issue #327) only when KOINE_WASM_AOT
//    is truthy — the deployed docs build (deploy-docs.yml) sets it so users get the faster
//    compiler, while a local `npm run dev`/`build` (which runs this via predev/prebuild) stays on
//    the fast interpreter publish unless you opt in. AOT relies on the wasm-tools workload only.
const aot = /^(1|true|yes)$/i.test(process.env.KOINE_WASM_AOT ?? '');
console.log(`Koine wasm: AOT ${aot ? 'ON (KOINE_WASM_AOT)' : 'off (interpreter)'}`);
run('dotnet', ['publish', project, '-c', 'Release', '--nologo', `-p:KoineWasmAot=${aot}`]);

// 2. Locate the published AppBundle — the directory that contains `_framework`. The wasm SDK
//    writes it to bin/Release/net10.0/browser-wasm/AppBundle; search broadly and prefer that.
const searchRoot = join(repoRoot, 'src', 'Koine.Wasm', 'bin', 'Release');

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

const candidates = findFrameworkDirs(searchRoot);
const bundleDir =
  candidates.find((d) => d.includes('AppBundle')) ??
  candidates.find((d) => d.includes('publish')) ??
  candidates[0];
if (!bundleDir) {
  console.error(
    `\nERROR: no _framework/ found under ${searchRoot}.\n` +
      `The wasm publish did not produce a browser AppBundle. Ensure the 'wasm-experimental'\n` +
      `workload is installed:  dotnet workload install wasm-experimental\n`,
  );
  process.exit(1);
}

// 3. Replace website/public/koine-wasm/ with the fresh bundle (_framework + main.js).
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(bundleDir, '_framework'), join(dest, '_framework'), { recursive: true });
const mainJs = join(bundleDir, 'main.js');
if (existsSync(mainJs)) cpSync(mainJs, join(dest, 'main.js'));

console.log(`\nKoine wasm bundle copied to ${dest}`);
