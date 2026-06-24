// Client-side PlantUML emitter for Studio's structured diagram graphs (issue #271). The Koine compiler
// never emits PlantUML — instead we translate the already-fetched `DiagramGraph` (DocsFile.diagrams[].graph)
// to PlantUML text in the browser, so "Export as PlantUML" needs no extra round-trip and no compiler change.
//
// This is a PURE function of (graph, kind, caption): the same input always yields the same string, which keeps
// it trivially unit-testable (string assertions over fixture graphs) with no DOM, no maxGraph, no LSP.
import type { DiagramEdge, DiagramGraph, DiagramNode } from '@/lsp/protocol';

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
