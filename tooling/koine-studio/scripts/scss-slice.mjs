// Phase 1 of the SCSS migration: slice src/styles.css into contiguous partials,
// in source order, and generate src/styles/main.scss that @use's them in that order.
// Output CSS is unchanged because @use just concatenates these verbatim slices.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SRC = 'src/styles.css';
const OUT = 'src/styles';

// [partialPath (relative to OUT), startLine (1-based)]. Ordered. Contiguous: each
// partial covers startLine..(nextStart-1); the last covers startLine..EOF.
const MANIFEST = [
  ['themes/_dark.scss', 1],
  ['themes/_light.scss', 56],
  ['base/_typography.scss', 96],
  ['base/_scrollbars.scss', 104],
  ['layout/_toolbar.scss', 160],
  ['components/_lang-split-button.scss', 265],
  ['components/_lang-picker.scss', 310],
  ['layout/_split.scss', 432],
  ['components/_file-tree.scss', 469],
  ['components/_explorer.scss', 532],
  ['components/_confirm-dialog.scss', 832],
  ['components/_context-menu.scss', 878],
  ['layout/_inspector.scss', 913],
  ['components/_doc-panes.scss', 1011],
  ['components/_outline.scss', 1121],
  ['components/_tooltip.scss', 1173],
  ['components/_diagnostics.scss', 1192],
  ['layout/_branded-header.scss', 1259],
  ['components/_welcome.scss', 1378],
  ['components/_command-palette.scss', 1557],
  ['components/_modal.scss', 1651],
  ['components/_form-fields.scss', 1729],
  ['components/_settings.scss', 1767],
  ['components/_help.scss', 2131],
  ['components/_about.scss', 2172],
  ['layout/_resizer.scss', 2328],
  ['components/_glossary-readability.scss', 2352],
  ['components/_copy-code-button.scss', 2371],
  ['components/_welcome-atmosphere.scss', 2402],
  ['base/_animations.scss', 2458],
  ['components/_glossary-editor.scss', 2521],
  ['layout/_inspector-tabs.scss', 2655],
  ['components/_floating-menu.scss', 2672],
  ['components/_diagrams.scss', 2753],
  ['components/_ai-panel.scss', 2805],
  ['components/_welcome-gallery.scss', 2965],
  ['components/_prefs-inputs.scss', 3005],
  ['components/_a11y.scss', 3023],
  ['components/_wizard.scss', 3037],
];

const lines = readFileSync(SRC, 'utf8').split('\n');
const EOF = lines.length; // includes any trailing empty element from final newline

for (let i = 0; i < MANIFEST.length; i++) {
  const [rel, start] = MANIFEST[i];
  const end = i + 1 < MANIFEST.length ? MANIFEST[i + 1][1] - 1 : EOF;
  // slice is [start-1 .. end-1] inclusive (1-based -> 0-based)
  const body = lines.slice(start - 1, end).join('\n');
  const abs = join(OUT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body.endsWith('\n') ? body : body + '\n');
}

// Build main.scss @use list preserving order. @use paths are relative to main.scss,
// without leading underscore or extension.
const useLines = MANIFEST.map(([rel]) => {
  const noExt = rel.replace(/\.scss$/, '');
  const parts = noExt.split('/');
  parts[parts.length - 1] = parts[parts.length - 1].replace(/^_/, '');
  return `@use './${parts.join('/')}';`;
});
writeFileSync(
  join(OUT, 'main.scss'),
  '// Koine Studio styles — 7-1 SCSS. Generated split (Phase 1); see docs/superpowers/plans.\n' +
    '// @use order mirrors the original styles.css top-to-bottom so cascade is preserved.\n\n' +
    useLines.join('\n') + '\n',
);
console.log(`wrote ${MANIFEST.length} partials + main.scss`);
