// Emit <Name>.d.ts (real prop contract) and <Name>.prompt.md (usage) next to each preview card.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const R = (...p) => path.join(root, ...p);
const OUT = R('ds-bundle-live');
const manifest = JSON.parse(readFileSync(R('.ds-adapter/manifest.json'), 'utf8')).filter((e) => !e.skip);
const sceneNames = new Set(['DeckStage', 'LeftRail']); // exposed in the bundle as zero-config scenes
const cardOnly = new Set(['SettingsPage']); // reference card, not a bundle export

// return the substring from the `{` at openIdx through its matching `}` (inclusive)
function balanced(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(openIdx, i + 1);
  }
  return null;
}

function propsBlock(src, name) {
  let m = src.match(new RegExp(`export interface ${name}Props\\s*`));
  if (m) {
    const open = src.indexOf('{', m.index);
    if (open >= 0) return balanced(src, open);
  }
  m = src.match(new RegExp(`export function ${name}\\s*\\(\\s*props\\s*:\\s*`));
  if (m) {
    const open = src.indexOf('{', m.index);
    if (open >= 0) return balanced(src, open);
  }
  return null; // no props (e.g. RightStrip)
}

function commentBefore(src, idx) {
  const before = src.slice(0, idx).split('\n');
  const out = [];
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i].trim();
    if (line.startsWith('//')) out.unshift(line.replace(/^\/\/\s?/, ''));
    else if (line === '') { if (out.length) break; }
    else break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function leadingComment(src, name) {
  // comment directly above the component; fall back to the one above its Props interface, then file top
  for (const re of [
    new RegExp(`export (?:function|const) ${name}\\b`),
    new RegExp(`export interface ${name}Props\\b`),
  ]) {
    const m = src.match(re);
    if (m) {
      const c = commentBefore(src, m.index);
      if (c) return c;
    }
  }
  // file-top block: contiguous // lines from line 0
  const top = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//')) top.push(t.replace(/^\/\/\s?/, ''));
    else if (t === '' && top.length) break;
    else if (t !== '') break;
  }
  return top.join(' ').replace(/\s+/g, ' ').trim();
}

// top-level prop names + whether the type looks like a function (callback)
function propList(block) {
  if (!block) return [];
  const inner = block.slice(1, -1);
  const props = [];
  let depth = 0, buf = '';
  for (const ch of inner) {
    if (ch === '{' || ch === '(' || ch === '<') depth++;
    if (ch === '}' || ch === ')' || ch === '>') depth--;
    if (ch === ';' && depth === 0) { props.push(buf); buf = ''; } else buf += ch;
  }
  if (buf.trim()) props.push(buf);
  return props
    .map((p) => p.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim())
    // match `name:` / `name?:` and method syntax `name(...)` / `name?(...)`
    .filter((p) => /^[A-Za-z_]\w*\??\s*[:(]/.test(p))
    .map((p) => {
      const name = p.match(/^([A-Za-z_]\w*)/)[1];
      const optional = /^[A-Za-z_]\w*\?/.test(p);
      const method = /^[A-Za-z_]\w*\??\s*\(/.test(p);
      const type = method ? p.slice(name.length).trim() : p.slice(p.indexOf(':') + 1).trim();
      const isFn = method || /=>/.test(type);
      return { name, optional, type, isFn };
    });
}

function usageSnippet(name, props, isScene) {
  if (isScene) return `<KoineStudio.${name} />`;
  if (!props.length) return `<KoineStudio.${name} />`;
  const lines = props
    .filter((p) => !p.optional)
    .map((p) => {
      if (p.name === 'store') return `  store={KoineStudio.createStore()}`;
      if (p.isFn) return `  ${p.name}={() => {}}`;
      return `  ${p.name}={/* ${p.type} */}`;
    });
  return `<KoineStudio.${name}\n${lines.join('\n')}\n/>`;
}

for (const e of manifest) {
  if (!e.component && !sceneNames.has(e.name) && !cardOnly.has(e.name)) continue;
  const dir = path.join(OUT, 'components', ...e.group.split('/'), e.name);
  const srcRel = e.componentImport ? e.componentImport.replace(/^@\//, 'src/') + '.tsx' : e.storyFile.replace(/^\.\//, '');
  const src = existsSync(R(srcRel)) ? readFileSync(R(srcRel), 'utf8') : '';
  const desc = (e.component && leadingComment(src, e.component)) || '';
  const block = e.component ? propsBlock(src, e.component) : null;
  const props = propList(block);
  const isScene = sceneNames.has(e.name) || cardOnly.has(e.name);
  const storeBound = props.some((p) => p.name === 'store');

  // No standalone <Name>.d.ts is emitted: claude.ai/design's compiler only accepts a sibling
  // <Name>.tsx as "the implementation" and flags a lone .d.ts as an orphan. These panels ship
  // preview-only (card + prompt + _preview render); the prop shape lives in the prompt below and
  // the Studio source. See .design-sync/NOTES.md "re-sync risks".

  // ---- <Name>.prompt.md ----
  const kind = cardOnly.has(e.name)
    ? 'Reference scene (preview only — not exported on `window.KoineStudio`; it bundles a full CodeMirror editor).'
    : isScene
      ? 'Pre-composed scene — renders zero-config on `window.KoineStudio`.'
      : storeBound
        ? 'Store-bound panel — pass a store from `KoineStudio.createStore()` plus its data props.'
        : 'Plain-props component.';
  const md = `# ${e.name}

${desc || 'A Koine Studio panel.'}

**Kind:** ${kind}
**Group:** ${e.group}

## Usage
\`\`\`jsx
${cardOnly.has(e.name) ? '// Preview only — see the card. Not available as a live component in this sync.' : usageSnippet(e.name, props, isScene)}
\`\`\`
${storeBound ? '\n> This panel reads UI state (active context, selection, filter) from the `store` and its domain data from the data prop(s) above. `KoineStudio.createStore()` returns an empty Studio store; the panel renders against whatever you pass.\n' : ''}
The preview card shows the canonical rendered example.${e.component && block ? ` The required props are shown in the usage snippet above; the full prop types live in the Koine Studio source (\`${srcRel}\`).` : ''}
`;
  writeFileSync(path.join(dir, `${e.name}.prompt.md`), md);
}

console.log('docs generated for', manifest.filter((e) => e.component || sceneNames.has(e.name) || cardOnly.has(e.name)).length, 'components');
