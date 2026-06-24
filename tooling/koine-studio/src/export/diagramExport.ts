// Client-side PlantUML emitter for Studio's structured diagram graphs (issue #271). The Koine compiler
// never emits PlantUML — instead we translate the already-fetched `DiagramGraph` (DocsFile.diagrams[].graph)
// to PlantUML text in the browser, so "Export as PlantUML" needs no extra round-trip and no compiler change.
//
// This is a PURE function of (graph, kind, caption): the same input always yields the same string, which keeps
// it trivially unit-testable (string assertions over fixture graphs) with no DOM, no maxGraph, no LSP.
import type { DiagramEdge, DiagramGraph, DiagramNode } from '@/lsp/protocol';
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
  const stereotype = node.stereotype ? ` <<${escapeInline(node.stereotype)}>>` : '';
  if (isClassNode(node) && node.members.length > 0) {
    lines.push(`class "${escapeLabel(node.label)}" as ${alias}${stereotype} {`);
    for (const m of node.members) {
      lines.push(`  ${escapeInline(m.text)}`);
    }
    lines.push('}');
  } else {
    lines.push(`class "${escapeLabel(node.label)}" as ${alias}${stereotype}`);
  }
  return lines;
}

/** Build a class diagram body (used for `aggregate` and as the default for unknown class-shaped kinds). */
function emitClassDiagram(graph: DiagramGraph, aliases: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const node of graph.nodes) {
    lines.push(...emitClassNode(node, aliases.get(node.id)!));
  }
  for (const edge of graph.edges) {
    const line = emitEdge(edge, aliases);
    if (line) lines.push(line);
  }
  return lines;
}

/** Build a state diagram body (`statemachine`): `state "Label" as alias` plus transition arrows. */
function emitStateDiagram(graph: DiagramGraph, aliases: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const node of graph.nodes) {
    lines.push(`state "${escapeLabel(node.label)}" as ${aliases.get(node.id)!}`);
  }
  for (const edge of graph.edges) {
    const line = emitEdge(edge, aliases);
    if (line) lines.push(line);
  }
  return lines;
}

/** Build a component diagram body (`contextmap`, `integration-events`): `component "Label" as alias` plus
 *  relation arrows. */
function emitComponentDiagram(graph: DiagramGraph, aliases: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const node of graph.nodes) {
    lines.push(`component "${escapeLabel(node.label)}" as ${aliases.get(node.id)!}`);
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
      body = emitStateDiagram(graph, aliases);
      break;
    case 'contextmap':
    case 'integration-events':
      body = emitComponentDiagram(graph, aliases);
      break;
    case 'aggregate':
    default:
      body = emitClassDiagram(graph, aliases);
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

// --- SVG export from the live maxGraph canvas (issue #271 Task 2) -------------
// The domain canvas is already an SVG drawing (the maxGraph cell SHAPES) overlaid with HTML-label
// `<foreignObject>` boxes (the themed `.koi-node` compartments). `canvasToSvg` clones that live tree into a
// STANDALONE, self-contained SVG string: it carries the `xmlns`, a concrete `width`/`height`/`viewBox`, the
// HTML node labels (so the `.koi-node[data-qname]` markup travels with the export), and — crucially — the
// DDD palette resolved to literal hex, so nothing renders as an unresolved `var(--koi-…)` once the SVG
// leaves Studio (where those custom properties are defined on the theme root, not on the SVG).

/** The Koine DDD palette custom properties the diagram's SVG styling depends on, resolved to concrete
 *  values so a standalone export renders identically outside Studio (these mirror the `_dark.scss` theme,
 *  the canvas's default). They cover the swimlane stroke (`--koi-line`), the context header text
 *  (`--koi-muted`), edge connectors (`--koi-diagram-edge`), node/edge label text (`--koi-fg`), the label
 *  pill background (`--koi-paper`) and the accent (`--koi-accent`). */
const SVG_PALETTE: Record<string, string> = {
  '--koi-line': '#2a3242',
  '--koi-muted': '#7d8694',
  '--koi-diagram-edge': '#5d6b8e',
  '--koi-fg': '#d6dde8',
  '--koi-paper': '#0e1117',
  '--koi-paper-2': '#161b22',
  '--koi-accent': '#5aa9ff',
};

/** Build a `<style>` element that defines every palette token on `:root`/`svg` so any `var(--koi-…)` left
 *  in the cloned tree resolves to the concrete DDD value when the SVG is rendered standalone. */
function buildPaletteStyle(doc: Document): SVGStyleElement {
  const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
  const decls = Object.entries(SVG_PALETTE)
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
 *  a known palette token → its hex; an inline fallback → that; otherwise a neutral slate so nothing paints
 *  as a literal `var(…)`. */
function resolveVarExpression(value: string): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, token: string, fallback?: string) => {
    return SVG_PALETTE[token] ?? (fallback != null ? fallback.trim() : '#94a3b8');
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
