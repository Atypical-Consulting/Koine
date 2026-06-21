// The joined model index (issue #142): the workspace-merged glossary (the complete type inventory —
// the outline backbone) joined with the richest matching `DiagramNode` (stereotype + class-body rows
// — the inspector's source). Extracted from `ide.ts` so the non-trivial join — diagram nodes are
// named `context.simpleName` while glossary entries are `context.aggregate.name` — is unit-tested.
import type { DiagramNode, DocsResult, GlossaryEntry, GlossaryModel } from './lsp';

/** A glossary entry joined with its diagram node (absent when the element has no class diagram). */
export interface ModelElement {
  entry: GlossaryEntry;
  node?: DiagramNode;
}

export interface ModelIndex {
  /** The glossary backbone (kept for re-rendering the outline). */
  glossary: GlossaryModel;
  /** Elements keyed by their canonical glossary qualified name (the selection key). */
  byQn: Map<string, ModelElement>;
  /** Maps a diagram node's `context.simpleName` back to the canonical glossary qualified name. */
  qnByCtxName: Map<string, string>;
}

/** A node is "richer" the more class-body rows + stereotype it carries (prefer the aggregate node). */
function nodeRichness(node: DiagramNode): number {
  return (node.members?.length ?? 0) + (node.stereotype ? 1 : 0);
}

/**
 * Build the joined index. Diagram nodes are merged by their `context.simpleName`, keeping the richest
 * (the aggregate class node beats the bare state/box node of the same name), then joined to glossary
 * entries via the synthesized `context.name` key.
 */
export function buildModelIndex(glossary: GlossaryModel, docs: DocsResult): ModelIndex {
  const nodesByCtxName = new Map<string, DiagramNode>();
  for (const file of docs.files) {
    for (const diagram of file.diagrams) {
      for (const node of diagram.graph.nodes) {
        const existing = nodesByCtxName.get(node.qualifiedName);
        if (!existing || nodeRichness(node) > nodeRichness(existing)) {
          nodesByCtxName.set(node.qualifiedName, node);
        }
      }
    }
  }

  const byQn = new Map<string, ModelElement>();
  const qnByCtxName = new Map<string, string>();
  for (const entry of glossary.entries) {
    if (entry.kind === 'context') continue;
    const ctxName = `${entry.context}.${entry.name}`;
    byQn.set(entry.qualifiedName, { entry, node: nodesByCtxName.get(ctxName) });
    if (!qnByCtxName.has(ctxName)) qnByCtxName.set(ctxName, entry.qualifiedName);
  }
  return { glossary, byQn, qnByCtxName };
}

/**
 * Resolve a selection key to its element, accepting EITHER the canonical glossary qualified name OR a
 * diagram node's `context.simpleName` (the two key forms a selection can carry). Returns the element
 * plus its canonical qualified name (for outline cross-highlight), or null when the key is unknown.
 */
export function lookupElement(
  index: ModelIndex,
  key: string,
): { element: ModelElement; canonicalQn: string } | null {
  const direct = index.byQn.get(key);
  if (direct) return { element: direct, canonicalQn: key };
  const mapped = index.qnByCtxName.get(key);
  if (mapped) {
    const element = index.byQn.get(mapped);
    if (element) return { element, canonicalQn: mapped };
  }
  return null;
}
