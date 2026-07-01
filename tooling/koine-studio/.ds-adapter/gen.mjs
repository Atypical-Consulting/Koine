// Generate the live-component bundle from the manifest:
//   ds-bundle-live/_ds_bundle.js         — agent-facing: window.KoineStudio.<Name> (React-adapted) + createStore + data
//   ds-bundle-live/_preview/<Name>.js    — self-contained Preact render of each component's primary story
//   ds-bundle-live/components/<group>/<Name>/<Name>.html — the @dsCard preview card loading that _preview js
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const R = (...p) => path.join(root, ...p);
const OUT = R('ds-bundle-live');
const manifest = JSON.parse(readFileSync(R('.ds-adapter/manifest.json'), 'utf8')).filter((e) => !e.skip);

// Stub heavy/server-only modules that some panels transitively import (AI SDKs, node builtins). They are
// never exercised at render time; a self-returning callable Proxy satisfies any default/named import.
const stubPlugin = {
  name: 'stub-server-only',
  setup(b) {
    const filter = /^(@anthropic-ai\/sdk|openai)(\/.*)?$|^node:/;
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'module.exports = new Proxy(function(){}, { get: () => module.exports, apply: () => module.exports });',
      loader: 'js',
    }));
  },
};

const esbase = {
  bundle: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  plugins: [stubPlugin],
  alias: {
    '@': R('src'),
    'storybook/test': R('.ds-adapter/stub-storybook-test.js'),
    // Mirror .storybook/main.ts + vite.config.ts: the panels' React-targeting deps (zustand's React hook)
    // must resolve to preact/compat, and to the SAME single preact instance the components render with.
    react: 'preact/compat',
    'react-dom': 'preact/compat',
    'react-dom/client': 'preact/compat',
    'react/jsx-runtime': 'preact/jsx-runtime',
    'react/jsx-dev-runtime': 'preact/jsx-runtime',
  },
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
  loader: { '.svg': 'text', '.css': 'empty', '.scss': 'empty' },
  logLevel: 'warning',
};

// ---- seed ds-bundle-live from the tokens bundle (tokens/fonts/styles/_ds_bundle.css + token gallery) ----
rmSync(OUT, { recursive: true, force: true });
cpSync(R('ds-bundle'), OUT, { recursive: true });
mkdirSync(path.join(OUT, '_preview'), { recursive: true });
mkdirSync(path.join(OUT, '_vendor'), { recursive: true });

// ---- vendor React 18 (the design runtime provides window.React; ship it so cards/tests are self-sufficient) ----
for (const [pkg, file] of [
  ['react', 'react.production.min.js'],
  ['react-dom', 'react-dom.production.min.js'],
]) {
  cpSync(R('.ds-adapter/node_modules', pkg, 'umd', file), path.join(OUT, '_vendor', file));
}

// ---- agent bundle entry ----
const withComp = manifest.filter((e) => e.component && e.componentImport);
const agentLines = [
  `import { adapt } from ${JSON.stringify(R('.ds-adapter/adapter.js'))};`,
  `import { createAppStore } from '@/store/index';`,
  `import { DECK_SURFACES } from '@/shell/deck/surfaces';`,
];
for (const e of withComp) agentLines.push(`import { ${e.component} } from ${JSON.stringify(e.componentImport)};`);
// Lightweight scenes (no standalone component) exposed as zero-config example components. SettingsPage is
// excluded — its CodeMirror bundle would bloat _ds_bundle.js past the per-file cap; it stays card-only.
const scenes = manifest.filter((e) => !e.component && e.name !== 'SettingsPage');
const storyImportOf = (e) => e.storyFile.replace(/^\.\/src\//, '@/').replace(/\.tsx$/, '');
for (const e of scenes) agentLines.push(`import * as scene_${e.name} from ${JSON.stringify(storyImportOf(e))};`);
agentLines.push(`const ns = (window.KoineStudio = window.KoineStudio || {});`);
agentLines.push(`ns.createStore = createAppStore;`);
agentLines.push(`ns.DECK_SURFACES = DECK_SURFACES;`);
for (const e of withComp) agentLines.push(`ns.${e.component} = adapt(${e.component}, ${JSON.stringify(e.component)});`);
agentLines.push(`function sceneOf(mod, primary){ return function Scene(){ const meta=mod.default||{}; const s=mod[primary]||{}; const a={...(meta.args||{}),...(s.args||{})}; const r=s.render||meta.render; return r?r(a,{args:a}):null; }; }`);
for (const e of scenes) agentLines.push(`ns.${e.name} = adapt(sceneOf(scene_${e.name}, ${JSON.stringify(e.primary)}), ${JSON.stringify(e.name)});`);
mkdirSync(R('.ds-adapter/out/entries'), { recursive: true });
writeFileSync(R('.ds-adapter/out/entries/agent-entry.js'), agentLines.join('\n'));

await esbuild.build({
  ...esbase,
  entryPoints: [R('.ds-adapter/out/entries/agent-entry.js')],
  outfile: path.join(OUT, '_ds_bundle.js'),
  format: 'iife',
  banner: { js: '/* @ds-bundle KoineStudio — Preact components React-adapted for claude.ai/design */' },
});

// ---- per-component preview card bundles (preact-direct story render) ----
const cardEntries = [];
for (const e of manifest) {
  const storyImport = e.storyFile.replace(/^\.\/src\//, '@/').replace(/\.tsx$/, '');
  const entryPath = R('.ds-adapter/out/entries', `card-${e.name}.js`);
  writeFileSync(
    entryPath,
    [
      `import * as story from ${JSON.stringify(storyImport)};`,
      `import { mountStoryPreact } from ${JSON.stringify(R('.ds-adapter/card-runtime.js'))};`,
      `mountStoryPreact(story, ${JSON.stringify(e.primary)});`,
    ].join('\n'),
  );
  cardEntries.push({ in: entryPath, out: path.join(OUT, '_preview', e.name) });
}
await esbuild.build({ ...esbase, entryPoints: cardEntries, outdir: path.join(OUT, '_preview'), format: 'iife' });

// ---- preview card HTML per component ----
for (const e of manifest) {
  const groupSegs = e.group.split('/').length;
  const up = '../'.repeat(2 + groupSegs); // card dir → bundle root
  const dir = path.join(OUT, 'components', ...e.group.split('/'), e.name);
  mkdirSync(dir, { recursive: true });
  const html = `<!-- @dsCard group="${e.group}" -->
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e.name}</title>
<link rel="stylesheet" href="${up}styles.css">
<style>
  body { margin: 0; padding: 20px; background: var(--koi-paper); color: var(--koi-fg); font-family: var(--koi-font-body); }
  #root { min-height: 40px; }
</style>
</head>
<body>
<div id="root"></div>
<script src="${up}_preview/${e.name}.js"></script>
</body>
</html>
`;
  writeFileSync(path.join(dir, `${e.name}.html`), html);
}

console.log(`generated: agent bundle + ${manifest.length} cards (${withComp.length} adapted components)`);
console.log('components:', manifest.map((e) => e.name).join(', '));
