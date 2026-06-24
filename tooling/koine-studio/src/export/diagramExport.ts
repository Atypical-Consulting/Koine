// Client-side PlantUML emitter for Studio's structured diagram graphs (issue #271). The Koine compiler
// never emits PlantUML — instead we translate the already-fetched `DiagramGraph` (DocsFile.diagrams[].graph)
// to PlantUML text in the browser, so "Export as PlantUML" needs no extra round-trip and no compiler change.
//
// This is a PURE function of (graph, kind, caption): the same input always yields the same string, which keeps
// it trivially unit-testable (string assertions over fixture graphs) with no DOM, no maxGraph, no LSP.
import type { Diagram, DiagramEdge, DiagramGraph, DiagramNode } from '@/lsp/protocol';
import type { CanvasHandle } from '@/diagrams/diagrams-maxgraph';

/** A node draws as a UML class box (compartments) iff it has a stereotype or any members; else a simple box.
 *  Inlined from {@link import('@/diagrams/diagrams-maxgraph').isClassNode} so this pure module stays free of
 *  the heavy `@maxgraph/core` import chain that file pulls in (it's a one-liner — see issue #271 Task 1). */
function isClassNode(node: DiagramNode): boolean {
  return node.stereotype != null || (node.members?.length ?? 0) > 0;
}

/** PlantUML identifiers (the `as <id>` alias, edge endpoints) must be `[A-Za-z0-9_]`. Any dot, space, dash,
 *  colon, etc. is replaced with `_` so dotted qualified names like `Ordering.Order` become valid aliases.
 *  A leading digit is prefixed so the alias is a legal identifier; an empty result falls back to `n`. */
function sanitizeId(id: string): string {
  let s = id.replace(/[^A-Za-z0-9_]/g, '_');
  if (s.length === 0) s = 'n';
  if (/^[0-9]/.test(s)) s = `n${s}`;
  return s;
}

/** Escape text that sits inside a PlantUML double-quoted string (labels, titles, member rows). A literal
 *  double-quote would terminate the string early and newlines would break the line, so quotes are escaped
 *  and CR/LF are flattened to spaces. */
function escapeLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

/** Escape text used on a bare (unquoted) line such as a `title` or a member row — no surrounding quotes to
 *  worry about, but newlines must still be flattened so the directive stays on one line. */
function escapeInline(text: string): string {
  return text.replace(/\r?\n/g, ' ');
}

/** Escape a UML stereotype rendered inside `<<…>>`: the guillemets are structural, so strip any inner angle
 *  bracket that would close the group early (e.g. a stereotype like `reads>writes`). */
function escapeStereotype(text: string): string {
  return escapeInline(text).replace(/[<>]/g, '');
}

/** Escape a class-body member row rendered inside `{ … }`: strip braces so a `}` in the member text can't
 *  terminate the class body early. (Members come from a controlled formatter today, so this is a safety net.) */
function escapeMember(text: string): string {
  return escapeInline(text).replace(/[{}]/g, '');
}

/** A stable map from each node's raw id to a sanitized, collision-free PlantUML alias. Two raw ids that
 *  sanitize to the same string get disambiguated with a numeric suffix so edges still resolve uniquely. */
function buildAliasMap(graph: DiagramGraph): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const node of graph.nodes) {
    let alias = sanitizeId(node.id);
    if (used.has(alias)) {
      let i = 2;
      while (used.has(`${alias}_${i}`)) i++;
      alias = `${alias}_${i}`;
    }
    used.add(alias);
    aliases.set(node.id, alias);
  }
  return aliases;
}

/** The arrow operator for an edge, keyed on `arrowKind`. Composition is `*--`; bidirectional is `<-->`;
 *  association / transition / flow and anything unknown route to the plain `-->`. */
function arrowFor(arrowKind: string | null | undefined): string {
  switch (arrowKind) {
    case 'composition':
      return '*--';
    case 'bidirectional':
      return '<-->';
    case 'association':
    case 'transition':
    case 'flow':
    default:
      return '-->';
  }
}

/** Render one edge as a PlantUML relation line, resolving endpoints through the alias map. Composition edges
 *  carry their source/target cardinalities as quoted multiplicities; the edge `label` becomes the `: label`
 *  suffix. Endpoints whose nodes aren't in the alias map (dangling edge) are sanitized in place. */
function emitEdge(edge: DiagramEdge, aliases: Map<string, string>): string | null {
  const from = aliases.get(edge.from) ?? sanitizeId(edge.from);
  const to = aliases.get(edge.to) ?? sanitizeId(edge.to);
  const arrow = arrowFor(edge.arrowKind);

  let line = from;
  if (edge.arrowKind === 'composition' && edge.sourceCardinality) {
    line += ` "${escapeLabel(edge.sourceCardinality)}"`;
  }
  line += ` ${arrow}`;
  if (edge.arrowKind === 'composition' && edge.cardinality) {
    line += ` "${escapeLabel(edge.cardinality)}"`;
  }
  line += ` ${to}`;
  if (edge.label) {
    line += ` : ${escapeInline(edge.label)}`;
  }
  return line;
}

/** Emit a class node (`aggregate` diagrams, and any class-shaped node elsewhere): a `class "Label" as alias`
 *  with an optional `<<stereotype>>` and one body row per member. Non-class nodes degrade to a bare `class`. */
function emitClassNode(node: DiagramNode, alias: string): string[] {
  const lines: string[] = [];
  const stereotype = node.stereotype ? ` <<${escapeStereotype(node.stereotype)}>>` : '';
  if (isClassNode(node) && node.members.length > 0) {
    lines.push(`class "${escapeLabel(node.label)}" as ${alias}${stereotype} {`);
    for (const m of node.members) {
      lines.push(`  ${escapeMember(m.text)}`);
    }
    lines.push('}');
  } else {
    lines.push(`class "${escapeLabel(node.label)}" as ${alias}${stereotype}`);
  }
  return lines;
}

/** Build a diagram body: one block per node via `renderNode` (resolving its alias), then every edge as a
 *  relation line. The three PlantUML families differ ONLY in how a node renders, so they share this loop. */
function emitDiagram(
  graph: DiagramGraph,
  aliases: Map<string, string>,
  renderNode: (node: DiagramNode, alias: string) => string[],
): string[] {
  const lines: string[] = [];
  for (const node of graph.nodes) {
    lines.push(...renderNode(node, aliases.get(node.id)!));
  }
  for (const edge of graph.edges) {
    const line = emitEdge(edge, aliases);
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Translate a structured diagram graph to a PlantUML source string.
 *
 * `kind` selects the PlantUML diagram family:
 *   - `'aggregate'`         → class diagram (`class … { members }` with `<<stereotype>>`)
 *   - `'statemachine'`      → state diagram (`state …`, `A --> B : label`)
 *   - `'contextmap'`        → component diagram (`component "…" as id`, relation arrows)
 *   - `'integration-events'` and any unknown kind → component diagram (graceful default)
 *
 * Node ids are sanitized to legal PlantUML identifiers (`[A-Za-z0-9_]`, dots/spaces/etc → `_`) and an
 * alias map keeps edges resolving to the sanitized ids. Labels, member rows, stereotypes and the title
 * are escaped so quotes/newlines can't break the output. The result is always wrapped in
 * `@startuml`/`@enduml`; an empty graph yields a valid empty skeleton.
 */
export function diagramToPlantUml(graph: DiagramGraph, kind: string, caption: string): string {
  const aliases = buildAliasMap(graph);

  let body: string[];
  switch (kind) {
    case 'statemachine':
      body = emitDiagram(graph, aliases, (node, alias) => [`state "${escapeLabel(node.label)}" as ${alias}`]);
      break;
    case 'contextmap':
    case 'integration-events':
      body = emitDiagram(graph, aliases, (node, alias) => [`component "${escapeLabel(node.label)}" as ${alias}`]);
      break;
    case 'aggregate':
    default:
      body = emitDiagram(graph, aliases, emitClassNode);
      break;
  }

  const lines: string[] = ['@startuml'];
  if (caption && caption.trim().length > 0) {
    lines.push(`title ${escapeInline(caption)}`);
  }
  lines.push(...body);
  lines.push('@enduml');
  return `${lines.join('\n')}\n`;
}

/** Sanitize text for a Mermaid `classDiagram`: flatten newlines and drop the characters that are structural
 *  in Mermaid (`"` quotes, `[]` label brackets, `{}` body braces, backticks) so a label/member/edge string
 *  can't break the document. */
function mermaidText(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/"/g, "'").replace(/[[\]{}`]/g, '');
}

/** Render one edge as a Mermaid `classDiagram` relation. Composition is `*--` (carrying its cardinalities);
 *  everything else degrades to a plain `-->` (Mermaid classDiagram has no bidirectional arrow). */
function mermaidEdge(edge: DiagramEdge, from: string, to: string): string {
  const arrow = edge.arrowKind === 'composition' ? '*--' : '-->';
  let line = `  ${from}`;
  if (edge.arrowKind === 'composition' && edge.sourceCardinality) line += ` "${mermaidText(edge.sourceCardinality)}"`;
  line += ` ${arrow}`;
  if (edge.arrowKind === 'composition' && edge.cardinality) line += ` "${mermaidText(edge.cardinality)}"`;
  line += ` ${to}`;
  if (edge.label) line += ` : ${mermaidText(edge.label)}`;
  return line;
}

/**
 * Translate a structured diagram graph to a Mermaid `classDiagram` string (issue #271).
 *
 * The Studio domain canvas fuses several source diagrams into one class-shaped view, so "Copy Mermaid" emits
 * ONE valid Mermaid document for the merged graph — concatenating the per-source Mermaid snippets would
 * produce multiple `classDiagram` headers, which Mermaid rejects. Node ids are sanitized to legal Mermaid
 * class names (via {@link buildAliasMap}); labels/members/edge text are stripped of Mermaid-structural
 * characters; composition edges keep their cardinalities; dangling edges (an endpoint with no declared node)
 * are skipped. An empty graph yields a bare `classDiagram` (valid and empty).
 */
export function diagramToMermaid(graph: DiagramGraph): string {
  const aliases = buildAliasMap(graph);
  const lines: string[] = ['classDiagram'];
  for (const node of graph.nodes) {
    const alias = aliases.get(node.id)!;
    lines.push(`  class ${alias}["${mermaidText(node.label)}"]`);
    for (const m of node.members) {
      lines.push(`  ${alias} : ${mermaidText(m.text)}`);
    }
  }
  for (const edge of graph.edges) {
    const from = aliases.get(edge.from);
    const to = aliases.get(edge.to);
    if (from && to) lines.push(mermaidEdge(edge, from, to)); // Mermaid needs both classes declared
  }
  return `${lines.join('\n')}\n`;
}

// --- SVG export from the live maxGraph canvas (issue #271 Task 2) -------------
// The domain canvas is already an SVG drawing (the maxGraph cell SHAPES) overlaid with HTML-label
// `<foreignObject>` boxes (the themed `.koi-node` compartments). `canvasToSvg` clones that live tree into a
// STANDALONE, self-contained SVG string: it carries the `xmlns`, a concrete `width`/`height`/`viewBox`, the
// HTML node labels (so the `.koi-node[data-qname]` markup travels with the export), and — crucially — the
// DDD palette resolved to literal hex, so nothing renders as an unresolved `var(--koi-…)` once the SVG
// leaves Studio (where those custom properties are defined on the theme root, not on the SVG).

/** The DDD palette custom properties the diagram's SVG styling depends on, with their `_dark.scss` values as
 *  a FALLBACK only. The dark theme is the canvas default, but Studio also ships a light theme, so the actual
 *  values are read from the live theme root at export time ({@link resolvePalette}) — these constants just
 *  cover a headless/unstyled DOM (tests) or a token the theme leaves unset. They cover the swimlane stroke
 *  (`--koi-line`), context-header text (`--koi-muted`), edge connectors (`--koi-diagram-edge`), node/edge
 *  label text (`--koi-fg`), the label-pill background (`--koi-paper`/`--koi-paper-2`) and the accent. */
const SVG_PALETTE_DARK: Record<string, string> = {
  '--koi-line': '#2a3242',
  '--koi-muted': '#7d8694',
  '--koi-diagram-edge': '#5d6b8e',
  '--koi-fg': '#d6dde8',
  '--koi-paper': '#0e1117',
  '--koi-paper-2': '#161b22',
  '--koi-accent': '#5aa9ff',
};

/** The palette resolved for the current export — set by {@link canvasToSvg} from the live theme. canvasToSvg
 *  is synchronous, so a per-export module field is safe and avoids threading the map through every helper. */
let activePalette: Record<string, string> = SVG_PALETTE_DARK;

/** Resolve each palette token from the live theme root (`getComputedStyle(:root)`), so a light-theme export
 *  bakes in light-theme colours rather than the frozen dark defaults. Any token the computed style leaves
 *  blank (e.g. an unstyled/headless DOM under tests) falls back to its {@link SVG_PALETTE_DARK} value. */
function resolvePalette(): Record<string, string> {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const computed = root ? getComputedStyle(root) : null;
  const out: Record<string, string> = {};
  for (const token of Object.keys(SVG_PALETTE_DARK)) {
    const live = computed?.getPropertyValue(token)?.trim();
    out[token] = live ? live : SVG_PALETTE_DARK[token];
  }
  return out;
}

/** Build a `<style>` element that defines every palette token on `:root`/`svg` so any `var(--koi-…)` left
 *  in the cloned tree resolves to the concrete DDD value when the SVG is rendered standalone. */
function buildPaletteStyle(doc: Document): SVGStyleElement {
  const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
  const decls = Object.entries(activePalette)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
  style.textContent = `:root, svg { ${decls} }`;
  return style;
}

/** Replace every remaining `var(--token[, fallback])` reference in a presentation attribute with the
 *  resolved palette value (or the inline fallback) so the serialized SVG carries NO `var(` — it must paint
 *  with concrete colours outside Studio even in a renderer that ignores the `<style>` custom-property defs. */
function resolveVarAttributes(svg: SVGSVGElement): void {
  const colorAttrs = ['fill', 'stroke', 'color', 'stop-color', 'flood-color'];
  const all = [svg, ...Array.from(svg.querySelectorAll('*'))];
  for (const el of all) {
    for (const attr of colorAttrs) {
      const v = el.getAttribute(attr);
      if (v && v.includes('var(')) el.setAttribute(attr, resolveVarExpression(v));
    }
    const styleAttr = el.getAttribute('style');
    if (styleAttr && styleAttr.includes('var(')) el.setAttribute('style', resolveVarExpression(styleAttr));
  }
}

/** Resolve a CSS value that may contain `var(--token)` / `var(--token, fallback)` to a concrete string:
 *  a known palette token → its resolved value; an inline fallback → that; otherwise a neutral slate so
 *  nothing paints as a literal `var(…)`. */
function resolveVarExpression(value: string): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, token: string, fallback?: string) => {
    return activePalette[token] ?? (fallback != null ? fallback.trim() : '#94a3b8');
  });
}

/** The live `<svg>` drawing surface for a built canvas. maxGraph's draw pane (`getView().getCanvas()`) is a
 *  `<g>` whose `ownerSVGElement` is the surface; fall back to the container's first `<svg>`. */
function findCanvasSvg(handle: CanvasHandle): SVGSVGElement {
  const view = handle.graph.getView();
  const pane = view.getCanvas?.() as Element | undefined;
  const owner = (pane as SVGElement | undefined)?.ownerSVGElement ?? null;
  if (owner) return owner as SVGSVGElement;
  const container = handle.graph.container as HTMLElement | undefined;
  const found = container?.querySelector('svg');
  if (found) return found as SVGSVGElement;
  throw new Error('canvasToSvg: no <svg> drawing surface found on the canvas handle');
}

/** A safe, positive integer from a (possibly NaN/zero/negative) bounds dimension. */
function dim(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : fallback;
}

/**
 * Serialize a built canvas ({@link CanvasHandle}) to a STANDALONE SVG string suitable for download
 * (issue #271). The live drawing surface is deep-cloned (never mutated), made self-contained — `xmlns`, a
 * concrete `width`/`height`/`viewBox` derived from the graph bounds, the HTML node labels folded in, and
 * the DDD palette inlined (both a `<style>` block defining the custom properties and a literal rewrite of
 * any `var(--koi-…)` attribute to its hex) — then serialized with `XMLSerializer`. The result renders
 * identically outside Studio, with no unresolved `var(` left in the output.
 *
 * @throws if the handle exposes no `<svg>` surface (it always does for a built canvas).
 */
export function canvasToSvg(handle: CanvasHandle): string {
  activePalette = resolvePalette(); // snapshot the live theme so the export matches what's on screen
  const svg = findCanvasSvg(handle);
  const doc = svg.ownerDocument ?? document;
  const clone = svg.cloneNode(true) as SVGSVGElement;

  // maxGraph renders HTML cell labels (the `.koi-node` compartments carrying `data-qname`) as
  // `<foreignObject>` groups. In a real browser those live INSIDE the SVG; under happy-dom they end up as
  // `<g>` siblings of the `<svg>` in the container. Fold any such sibling label groups into the clone so the
  // exported SVG carries the node markup standalone in either environment.
  if (!clone.querySelector('[data-qname]')) {
    let sib = svg.nextElementSibling;
    while (sib) {
      if (sib.tagName.toLowerCase() === 'g' && sib.querySelector('foreignObject, [data-qname]')) {
        clone.appendChild(sib.cloneNode(true));
      }
      sib = sib.nextElementSibling;
    }
  }

  // Make it a standalone document: the SVG namespace, the foreignObject XHTML namespace, and a concrete
  // geometry derived from the laid-out graph bounds (guarded against a zero/empty/headless box).
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const bounds = handle.graph.getGraphBounds?.();
  const w = dim(bounds?.width ?? 0, 800);
  const h = dim(bounds?.height ?? 0, 600);
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  const bx = Number.isFinite(bounds?.x) ? Math.floor(bounds!.x) : 0;
  const by = Number.isFinite(bounds?.y) ? Math.floor(bounds!.y) : 0;
  clone.setAttribute('viewBox', `${bx} ${by} ${w} ${h}`);

  // Inline the DDD palette: define the custom properties (so var() resolves where supported) AND rewrite any
  // remaining var(--koi-…) presentation attribute to its concrete hex (so nothing paints as a literal var()).
  clone.insertBefore(buildPaletteStyle(doc), clone.firstChild);
  resolveVarAttributes(clone);

  return new XMLSerializer().serializeToString(clone);
}

// --- PNG rasterization + export orchestrator (issue #271 Task 3) --------------
// `svgToPng` rasterizes a standalone SVG string offscreen via the browser's Image → <canvas> pipeline; it
// is the only piece of the export path that needs a real raster engine, so it's written to be cleanly
// stubbable (the test swaps in a fake `Image` + canvas in happy-dom, which has no rasterizer). `exportDiagram`
// is the format dispatcher: it derives a safe download filename from the diagram caption, turns the diagram
// into bytes for the chosen format, and hands them to the host's `save` callback — returning whatever `save`
// resolves to, so a user cancellation propagates as `false`.

/** Best-effort `width`/`height` from a raw SVG string's root attributes (numeric leading digits), used as a
 *  fallback when the loaded `Image` reports a 0 intrinsic size (e.g. percentage sizing or a headless engine). */
function parseSvgSize(svg: string): { width: number; height: number } | null {
  const wMatch = /<svg[^>]*\swidth="([\d.]+)/i.exec(svg);
  const hMatch = /<svg[^>]*\sheight="([\d.]+)/i.exec(svg);
  const w = wMatch ? parseFloat(wMatch[1]) : NaN;
  const h = hMatch ? parseFloat(hMatch[1]) : NaN;
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { width: w, height: h };
  return null;
}

/** Decode a `data:image/png;base64,…` data URL to its raw PNG bytes. */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Rasterize a standalone SVG string to PNG bytes (issue #271). The SVG is loaded as an `Image` from a
 * `data:image/svg+xml` URL, drawn onto an offscreen `<canvas>` scaled by `scale` (so the PNG is crisp at 2×
 * by default), and read back as PNG bytes via `canvas.toDataURL('image/png')`. The canvas is sized from the
 * image's intrinsic dimensions, falling back to the SVG's declared size, then to 800×600 — so a headless
 * engine that reports a 0 size still produces a sensibly-sized bitmap. Rejects if the image fails to load or
 * the 2D context is unavailable.
 *
 * Written to be stubbable: the test replaces `Image`, `canvas.getContext` and `canvas.toDataURL` in happy-dom
 * (which has no real rasterizer) and asserts that bytes come out — no pixel-exact assertion is possible there.
 */
export function svgToPng(svg: string, scale = 2): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const declared = parseSvgSize(svg);
        const baseW = img.width > 0 ? img.width : (declared?.width ?? 800);
        const baseH = img.height > 0 ? img.height : (declared?.height ?? 600);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(baseW * scale));
        canvas.height = Math.max(1, Math.round(baseH * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('svgToPng: 2D canvas context is unavailable'));
          return;
        }
        ctx.scale(scale, scale);
        ctx.drawImage(img as unknown as CanvasImageSource, 0, 0);
        resolve(dataUrlToBytes(canvas.toDataURL('image/png')));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error('svgToPng: failed to rasterize SVG image'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/** Derive a filesystem-safe base name from a diagram caption: strip leading/trailing whitespace, replace any
 *  path-hostile character (`/ \ : * ? " < > |`) and whitespace runs with a single `_`, trim stray separators,
 *  and fall back to `'diagram'` when nothing usable remains. Hyphens are KEPT (legal in filenames) so
 *  `Order-Management` and `Order Management` don't collapse to the same name. No extension is added. */
function safeBaseName(caption: string): string {
  const base = caption
    .trim()
    .replace(/[/\\:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return base.length > 0 ? base : 'diagram';
}

const EXTENSIONS: Record<'svg' | 'png' | 'plantuml', string> = {
  svg: '.svg',
  png: '.png',
  plantuml: '.puml',
};

/** One shared UTF-8 encoder for the text formats (PlantUML / SVG) — stateless, so a single module-level
 *  instance is reused across exports rather than re-allocated per call. */
const TEXT_ENCODER = new TextEncoder();

/**
 * Export a Studio diagram in the chosen format and hand it to the host's `save` callback (issue #271).
 *
 * The download filename is derived from `diagram.caption` (sanitized to a safe base name, `'diagram'` when
 * blank) plus the format extension (`.svg` / `.png` / `.puml`). The diagram is encoded to bytes per format:
 *   - `'plantuml'` → {@link diagramToPlantUml} text, UTF-8 encoded
 *   - `'svg'`      → {@link canvasToSvg} of the live canvas, UTF-8 encoded
 *   - `'png'`      → {@link svgToPng} of that SVG (rasterized to PNG)
 *
 * Returns whatever `save` resolves to, so a user-cancelled save (`false`) propagates straight through.
 */
export async function exportDiagram(
  format: 'svg' | 'png' | 'plantuml',
  diagram: Diagram,
  handle: CanvasHandle,
  save: (name: string, bytes: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
  const name = `${safeBaseName(diagram.caption)}${EXTENSIONS[format]}`;

  let bytes: Uint8Array;
  switch (format) {
    case 'plantuml':
      bytes = TEXT_ENCODER.encode(diagramToPlantUml(diagram.graph, diagram.kind, diagram.caption));
      break;
    case 'svg':
      bytes = TEXT_ENCODER.encode(canvasToSvg(handle));
      break;
    case 'png':
      bytes = await svgToPng(canvasToSvg(handle));
      break;
  }

  return save(name, bytes);
}
