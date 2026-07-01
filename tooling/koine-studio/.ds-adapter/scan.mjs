// Scan every *.stories.tsx and emit a manifest: { name, group, title, component, storyFile, stories[] }.
// The manifest drives both the preview-card generator and the agent bundle. Special cases (imperative
// factories, host wrappers) are layered on via manifest-overrides.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const files = globSync('src/**/*.stories.tsx', { cwd: root }).sort();

const overrides = existsSync(path.join(root, '.ds-adapter/manifest-overrides.json'))
  ? JSON.parse(readFileSync(path.join(root, '.ds-adapter/manifest-overrides.json'), 'utf8'))
  : {};

const entries = files.map((rel) => {
  const src = readFileSync(path.join(root, rel), 'utf8');
  const title = (src.match(/title:\s*'([^']+)'/) || [])[1] || rel;
  const component = (src.match(/component:\s*([A-Za-z0-9_]+)/) || [])[1] || null;
  const stories = [...src.matchAll(/^export const ([A-Za-z0-9_]+)\s*:\s*Story\b/gm)].map((m) => m[1]);
  // the module specifier the component is imported from (for the agent bundle's static import)
  let componentImport = null;
  if (component) {
    const re = new RegExp(`import\\s*\\{[^}]*\\b${component}\\b[^}]*\\}\\s*from\\s*'([^']+)'`);
    componentImport = (src.match(re) || [])[1] || null;
  }
  const parts = title.split('/');
  const group = parts.slice(0, -1).join('/') || 'Panels';
  const leaf = parts[parts.length - 1];
  // component export drives the bundle; when a story has no `component:` (imperative/scene), fall back to leaf.
  const name = component || leaf;
  const base = { name, group, title, component, componentImport, storyFile: './' + rel.replace(/\\/g, '/'), stories, primary: stories[0] || null };
  return { ...base, ...(overrides[name] || overrides[leaf] || {}) };
});

writeFileSync(path.join(root, '.ds-adapter/manifest.json'), JSON.stringify(entries, null, 2));
console.log(`scanned ${entries.length} stories`);
for (const e of entries) console.log(`  ${e.name.padEnd(24)} ${String(e.component || '(scene)').padEnd(22)} [${e.stories.join(', ')}]`);
