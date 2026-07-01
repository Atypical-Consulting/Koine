// Generates the design-sync token-gallery preview cards under ds-bundle/components/tokens/<Name>/<Name>.html.
// Each card is self-contained HTML: first line is the @dsCard marker (the app builds its picker index
// from it), it links the bundle's real styles.css (fonts + tokens + component classes), and renders
// swatches/specs for one token family. Not part of the app build.
import { mkdirSync, writeFileSync } from 'node:fs';

const GROUP = 'Tokens';
const OUT = 'ds-bundle/components/tokens';

// styles.css lives at the project root; a card sits at components/tokens/<Name>/<Name>.html
const STYLES = '../../../styles.css';

// Light-theme token values, re-scoped to .koi-light so a card can show a light pane inline
// (the real light theme is keyed on html[data-theme='light']). Kept in sync with tokens/tokens.css.
const LIGHT_SCOPE = `.koi-light{
  --koi-paper:#ffffff;--koi-paper-2:#f4f6fa;--koi-surface:#e9edf3;--koi-line:#d2d9e3;--koi-diagram-edge:#7a8698;
  --koi-fg:#1c2230;--koi-muted:#5b6573;--koi-ink-soft:#3a4452;
  --koi-accent:#2f7fe0;--koi-on-accent:#ffffff;--koi-cyan:#0b9d8f;--koi-error:#cf222e;--koi-on-error:#ffffff;
  --koi-hl-keyword:#8a3ffc;--koi-hl-type:#0b7fb8;--koi-hl-string:#1a7f37;--koi-hl-regex:#bc4c00;--koi-hl-number:#9a6700;--koi-hl-comment:#6a7484;--koi-hl-meta:#bf3989;--koi-hl-punct:#57606a;
}`;

const shell = (title, body, extraCss = '') => `<!-- @dsCard group="${GROUP}" -->
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="${STYLES}">
<style>
  body { margin: 0; padding: 24px; background: var(--koi-paper); color: var(--koi-fg); font-family: var(--koi-font-body); }
  .ds-h { font-family: var(--koi-font-display); font-weight: 700; font-size: 15px; letter-spacing: .01em; margin: 0 0 2px; }
  .ds-sub { color: var(--koi-muted); font-size: 12px; margin: 0 0 18px; }
  .ds-grid { display: grid; gap: 12px; }
  .mono { font-family: var(--koi-font-mono); }
  ${LIGHT_SCOPE}
  ${extraCss}
</style>
</head>
<body>
<div class="ds-h">${title}</div>
${body}
</body>
</html>
`;

// ---- color swatch helpers ----
const swatch = (name, val, desc = '') => `
  <div class="sw">
    <div class="sw-chip" style="background: ${val}"></div>
    <div class="sw-meta">
      <div class="sw-name mono">${name}</div>
      <div class="sw-val mono">${val}</div>
      ${desc ? `<div class="sw-desc">${desc}</div>` : ''}
    </div>
  </div>`;

const swatchCss = `
  .sw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .sw { display: flex; gap: 10px; align-items: center; background: var(--koi-paper-2); border: 1px solid var(--koi-line); border-radius: var(--koi-radius-sm); padding: 8px; }
  .sw-chip { width: 40px; height: 40px; border-radius: var(--koi-radius-xs); border: 1px solid rgba(127,127,127,.25); flex: 0 0 auto; }
  .sw-name { font-size: 11px; font-weight: 600; }
  .sw-val { font-size: 10.5px; color: var(--koi-muted); }
  .sw-desc { font-size: 10.5px; color: var(--koi-ink-soft); margin-top: 2px; }
  .sec-h { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--koi-muted); margin: 16px 0 8px; }
  .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .pane { border: 1px solid var(--koi-line); border-radius: var(--koi-radius); padding: 14px; background: var(--koi-paper); }
  .pane.koi-light { background: var(--koi-paper); color: var(--koi-fg); }
  .pane-h { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--koi-muted); margin: 0 0 10px; }
`;

const cards = {};

// 1. Colors — surfaces / text / accents / state, dark and light side by side
{
  const section = (title, rows) => `<div class="sec-h">${title}</div>
    <div class="sw-grid">${rows.map(([n, v, d]) => swatch(n, `var(${n})`, d)).join('')}</div>`;
  const surfaces = [['--koi-paper', '', 'app background'], ['--koi-paper-2', '', 'raised panels'], ['--koi-surface', '', 'inputs / controls'], ['--koi-line', '', 'borders / dividers'], ['--koi-diagram-edge', '', 'relationship connectors']];
  const text = [['--koi-fg', '', 'primary text'], ['--koi-muted', '', 'secondary text'], ['--koi-ink-soft', '', 'body / soft ink']];
  const accents = [['--koi-accent', '', 'primary accent'], ['--koi-on-accent', '', 'ink on accent'], ['--koi-cyan', '', 'secondary accent']];
  const state = [['--koi-error', '', 'error state'], ['--koi-on-error', '', 'ink on error']];
  const paneBody = `${section('Surfaces', surfaces)}${section('Text', text)}${section('Accents', accents)}${section('State', state)}`;
  const body = `<p class="ds-sub">The two themes. Dark is the <span class="mono">:root</span> default; light is <span class="mono">html[data-theme='light']</span>. Every token below flips between them.</p>
    <div class="panes">
      <div class="pane"><div class="pane-h">Dark (default)</div>${paneBody}</div>
      <div class="pane koi-light"><div class="pane-h">Light</div>${paneBody}</div>
    </div>`;
  cards.Colors = shell('Colors', body, swatchCss);
}

// 2. DddPalette — the DDD concept hues
{
  const ddd = [
    ['--koi-ddd-aggregate', 'Aggregate', 'the boundary owner'],
    ['--koi-ddd-entity', 'Entity', ''],
    ['--koi-ddd-value', 'Value object', ''],
    ['--koi-ddd-enum', 'Enum', ''],
    ['--koi-ddd-event', 'Domain event', ''],
    ['--koi-ddd-integration-event', 'Integration event', 'cross-context'],
    ['--koi-ddd-service', 'Domain service', ''],
    ['--koi-ddd-repository', 'Repository', ''],
    ['--koi-ddd-spec', 'Specification', ''],
    ['--koi-ddd-state-machine', 'State machine', 'lifecycle'],
    ['--koi-ddd-command', 'Command', ''],
    ['--koi-ddd-query', 'Query', ''],
    ['--koi-ddd-read-model', 'Read model', 'projection'],
    ['--koi-ddd-policy', 'Policy', 'process manager'],
    ['--koi-ddd-factory', 'Factory', ''],
  ];
  const body = `<p class="ds-sub">One hue per Domain-Driven Design building block — shared by the Explorer icons and the diagram nodes so the two never disagree. Theme-independent.</p>
    <div class="sw-grid">${ddd.map(([n, label, d]) => `
      <div class="sw">
        <div class="sw-chip" style="background: var(${n})"></div>
        <div class="sw-meta"><div class="sw-name">${label}</div><div class="sw-val mono">${n}</div>${d ? `<div class="sw-desc">${d}</div>` : ''}</div>
      </div>`).join('')}</div>`;
  cards.DddPalette = shell('DDD palette', body, swatchCss);
}

// 3. LanguageIdentity — destination-language brand hues
{
  const langs = [
    ['--lang-csharp', 'C#', '#a179dc'],
    ['--lang-typescript', 'TypeScript', '#3178c6'],
    ['--lang-python', 'Python', '#ffd43b'],
    ['--lang-php', 'PHP', '#777bb4'],
    ['--lang-rust', 'Rust', '#dea584'],
  ];
  const body = `<p class="ds-sub">Real brand hues for each code-generation target, shared across both themes. Used on language badges and the emitted-code header.</p>
    <div class="lang-row">${langs.map(([n, label, v]) => `
      <div class="lang">
        <span class="lang-dot" style="background: var(${n})"></span>
        <span class="lang-name">${label}</span>
        <span class="lang-val mono">${v}</span>
      </div>`).join('')}</div>`;
  const css = `
    .lang-row { display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
    .lang { display: flex; align-items: center; gap: 10px; background: var(--koi-paper-2); border: 1px solid var(--koi-line); border-radius: var(--koi-radius-pill); padding: 7px 14px; }
    .lang-dot { width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto; }
    .lang-name { font-weight: 600; font-size: 13px; flex: 1; }
    .lang-val { font-size: 11px; color: var(--koi-muted); }`;
  cards.LanguageIdentity = shell('Language identity', body, css);
}

// 4. Typography — the three families + size scale
{
  const fams = [
    ['Display', 'var(--koi-font-display)', 'Archivo Variable', 'Koine Studio — model your domain'],
    ['Body', 'var(--koi-font-body)', 'Hanken Grotesk Variable', 'The ubiquitous language, written once and emitted everywhere.'],
    ['Mono', 'var(--koi-font-mono)', 'JetBrains Mono Variable', 'aggregate Order { total: Money }'],
  ];
  const sizes = [
    ['--koi-text-2xs', '0.7rem'], ['--koi-text-xs', '0.72rem'], ['--koi-text-xs-plus', '0.74rem'],
    ['--koi-text-sm', '0.78rem'], ['--koi-text-sm-plus', '0.8rem'], ['--koi-text-base', '0.82rem'],
    ['--koi-text-base-plus', '0.84rem'], ['--koi-text-md', '0.86rem'], ['--koi-text-lg', '0.9rem'],
  ];
  const body = `<p class="ds-sub">Three self-hosted variable typefaces. Below them, the compact UI type ramp.</p>
    ${fams.map(([role, fam, name, sample]) => `
      <div class="fam">
        <div class="fam-meta"><span class="fam-role">${role}</span><span class="fam-name mono">${name}</span></div>
        <div class="fam-sample" style="font-family: ${fam}">${sample}</div>
      </div>`).join('')}
    <div class="sec-h">Font-size scale</div>
    <div class="sizes">${sizes.map(([n, v]) => `<div class="size-row"><span class="mono size-tok">${n}</span><span class="size-demo" style="font-size: var(${n})">Aa The quick brown fox</span><span class="mono size-val">${v}</span></div>`).join('')}</div>`;
  const css = `
    .fam { border: 1px solid var(--koi-line); border-radius: var(--koi-radius); background: var(--koi-paper-2); padding: 14px 16px; margin-bottom: 10px; }
    .fam-meta { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .fam-role { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--koi-accent); font-weight: 600; }
    .fam-name { font-size: 11px; color: var(--koi-muted); }
    .fam-sample { font-size: 22px; line-height: 1.35; color: var(--koi-fg); }
    .sizes { display: flex; flex-direction: column; gap: 4px; }
    .size-row { display: grid; grid-template-columns: 150px 1fr 60px; align-items: baseline; gap: 12px; padding: 3px 0; }
    .size-tok { font-size: 11px; color: var(--koi-muted); }
    .size-val { font-size: 11px; color: var(--koi-muted); text-align: right; }
    .sec-h { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--koi-muted); margin: 18px 0 10px; }`;
  cards.Typography = shell('Typography', body, css);
}

// 5. Radius — corner-radius scale
{
  const radii = [
    ['--koi-radius-2xs', '2px'], ['--koi-radius-xs', '4px'], ['--koi-radius-sm', '6px'],
    ['--koi-radius', '8px'], ['--koi-radius-lg', '10px'], ['--koi-radius-pill', '999px'],
  ];
  const body = `<p class="ds-sub">Ascending corner-radius scale. <span class="mono">--koi-radius</span> is the base (8px); <span class="mono">-pill</span> is fully rounded.</p>
    <div class="radii">${radii.map(([n, v]) => `
      <div class="rad">
        <div class="rad-box" style="border-radius: var(${n})"></div>
        <div class="rad-name mono">${n.replace('--koi-radius', 'radius') || 'radius'}</div>
        <div class="rad-val mono">${v}</div>
      </div>`).join('')}</div>`;
  const css = `
    .radii { display: flex; flex-wrap: wrap; gap: 18px; }
    .rad { text-align: center; }
    .rad-box { width: 76px; height: 76px; background: var(--koi-accent-grad); border: 1px solid var(--koi-line); margin-bottom: 8px; }
    .rad-name { font-size: 11px; font-weight: 600; }
    .rad-val { font-size: 10.5px; color: var(--koi-muted); }`;
  cards.Radius = shell('Radius', body, css);
}

// 6. Spacing — spacing scale bars
{
  const sp = [
    ['--koi-space-px', '1px'], ['--koi-space-0-5', '2px'], ['--koi-space-0-75', '3px'], ['--koi-space-1', '4px'],
    ['--koi-space-1-25', '5px'], ['--koi-space-1-5', '6px'], ['--koi-space-1-75', '7px'], ['--koi-space-2', '8px'],
    ['--koi-space-2-25', '9px'], ['--koi-space-2-5', '10px'], ['--koi-space-2-75', '11px'], ['--koi-space-3', '12px'],
    ['--koi-space-3-5', '14px'], ['--koi-space-4', '16px'], ['--koi-space-4-5', '18px'],
  ];
  const body = `<p class="ds-sub">Value-equivalent spacing tokens for padding, margin and gap. One place to rescale the whole UI's density.</p>
    <div class="sp-list">${sp.map(([n, v]) => `
      <div class="sp-row">
        <span class="mono sp-tok">${n}</span>
        <span class="sp-bar" style="width: var(${n})"></span>
        <span class="mono sp-val">${v}</span>
      </div>`).join('')}</div>`;
  const css = `
    .sp-list { display: flex; flex-direction: column; gap: 6px; }
    .sp-row { display: grid; grid-template-columns: 160px 1fr 48px; align-items: center; gap: 12px; }
    .sp-tok { font-size: 11px; color: var(--koi-ink-soft); }
    .sp-bar { display: inline-block; height: 14px; background: var(--koi-accent); border-radius: 2px; min-width: 1px; }
    .sp-val { font-size: 11px; color: var(--koi-muted); }`;
  cards.Spacing = shell('Spacing', body, css);
}

// 7. Elevation — shadow + signature gradient
{
  const body = `<p class="ds-sub">The single elevation shadow and the signature accent→cyan gradient.</p>
    <div class="elev-row">
      <div class="elev-item">
        <div class="elev-card"></div>
        <div class="mono elev-name">--koi-shadow</div>
        <div class="elev-val mono">0 18px 50px rgba(3,7,14,.5)</div>
      </div>
      <div class="elev-item">
        <div class="grad-card"></div>
        <div class="mono elev-name">--koi-accent-grad</div>
        <div class="elev-val mono">135deg, accent → cyan</div>
      </div>
    </div>`;
  const css = `
    .elev-row { display: flex; gap: 28px; flex-wrap: wrap; }
    .elev-item { text-align: center; }
    .elev-card { width: 150px; height: 96px; background: var(--koi-paper-2); border: 1px solid var(--koi-line); border-radius: var(--koi-radius); box-shadow: var(--koi-shadow); margin: 8px 0 10px; }
    .grad-card { width: 150px; height: 96px; background: var(--koi-accent-grad); border-radius: var(--koi-radius); margin: 8px 0 10px; }
    .elev-name { font-size: 11px; font-weight: 600; }
    .elev-val { font-size: 10.5px; color: var(--koi-muted); }`;
  cards.Elevation = shell('Elevation & gradient', body, css);
}

// 8. SyntaxHighlighting — a .koi snippet colored by the syntax tokens, dark + light
{
  const code = (kw, ty, str, num, cm, pn) => `<pre class="code"><span class="tk-cm">// a Koine value object</span>
<span class="tk-kw">value</span> <span class="tk-ty">Money</span> <span class="tk-pn">{</span>
  amount<span class="tk-pn">:</span> <span class="tk-ty">Decimal</span>
  currency<span class="tk-pn">:</span> <span class="tk-ty">String</span> <span class="tk-kw">matches</span> <span class="tk-str">/[A-Z]{3}/</span>
  <span class="tk-kw">invariant</span> amount <span class="tk-pn">&gt;=</span> <span class="tk-num">0</span>
<span class="tk-pn">}</span></pre>`;
  const codeCss = `.code { font-family: var(--koi-font-mono); font-size: 13px; line-height: 1.7; margin: 0; background: var(--koi-paper-2); border: 1px solid var(--koi-line); border-radius: var(--koi-radius-sm); padding: 14px 16px; color: var(--koi-ink-soft); }
    .tk-kw { color: var(--koi-hl-keyword); } .tk-ty { color: var(--koi-hl-type); } .tk-str { color: var(--koi-hl-string); }
    .tk-num { color: var(--koi-hl-number); } .tk-cm { color: var(--koi-hl-comment); font-style: italic; } .tk-pn { color: var(--koi-hl-punct); }`;
  const body = `<p class="ds-sub">The editor's syntax palette reads the same <span class="mono">--koi-hl-*</span> tokens in both themes — flip <span class="mono">data-theme</span> and the editor re-themes for free.</p>
    <div class="panes">
      <div class="pane"><div class="pane-h">Dark</div>${code()}</div>
      <div class="pane koi-light"><div class="pane-h">Light</div>${code()}</div>
    </div>`;
  cards.SyntaxHighlighting = shell('Syntax highlighting', body, swatchCss + codeCss);
}

// 9. Controls — the real .koi-* form controls, styled by the linked bundle CSS
{
  const controls = `
    <div class="ctl-grid">
      <label class="ctl"><span class="ctl-lbl">Select</span>
        <select class="koi-select"><option>Aggregate</option><option>Entity</option><option>Value object</option></select></label>
      <label class="ctl"><span class="ctl-lbl">Number</span>
        <input class="koi-number" type="number" value="3"></label>
      <label class="ctl"><span class="ctl-lbl">Text</span>
        <input class="koi-text" type="text" value="sk-...redacted" spellcheck="false"></label>
      <label class="ctl ctl-inline"><input class="koi-checkbox" type="checkbox" checked><span class="ctl-lbl">Emit interfaces</span></label>
    </div>`;
  const body = `<p class="ds-sub">The shared form controls (<span class="mono">.koi-select · .koi-number · .koi-text · .koi-checkbox</span>) rendered from the app's own compiled stylesheet. Focus/hover lift to the accent border.</p>
    ${controls}`;
  const css = `
    .ctl-grid { display: grid; gap: 14px; max-width: 340px; }
    .ctl { display: flex; flex-direction: column; gap: 6px; }
    .ctl-inline { flex-direction: row; align-items: center; gap: 8px; }
    .ctl-lbl { font-size: var(--koi-text-base, 0.82rem); color: var(--koi-fg); }`;
  cards.Controls = shell('Form controls', body, css);
}

for (const [name, html] of Object.entries(cards)) {
  mkdirSync(`${OUT}/${name}`, { recursive: true });
  writeFileSync(`${OUT}/${name}/${name}.html`, html);
}
console.log('wrote', Object.keys(cards).length, 'cards:', Object.keys(cards).join(', '));
