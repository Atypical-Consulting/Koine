// The element inspector (#142, Task 3): a read-only details panel for the selected domain element,
// driven by the selection bus. It reads a single `DiagramNode` from the living-docs graph — the same
// projection the diagram renders — so it shows the stereotype, properties, behaviors, and enum values
// the model already exposes. Pure DOM, no LSP wiring, so it unit-tests under happy-dom.
//
// Deferred (not on the wire for a single node, tracked separately): invariants and the repository
// binding are not carried by the diagram graph; published-events / relationships are edge-derived and
// belong to the Events & Relationships tables (#144). Those sections are intentionally omitted rather
// than faked.
import type { Diagram, DiagramNode, DocsResult, SourceSpan } from './lsp';

export interface InspectorHandlers {
  /** Jump the editor to the element's declaration (the header acts as a go-to-source link). */
  onGoto(span: SourceSpan): void;
}

/**
 * Index every diagram node by its qualified name across all living-docs diagrams, so a selection
 * (from the outline or the canvas) resolves to a node. When the same qualified name appears in more
 * than one diagram, the richer node — the one carrying class members — wins, so the inspector shows
 * the full class body rather than a simple box.
 */
export function buildNodeIndex(docs: DocsResult): Map<string, DiagramNode> {
  const index = new Map<string, DiagramNode>();
  for (const file of docs.files) {
    for (const diagram of file.diagrams as Diagram[]) {
      for (const node of diagram.graph.nodes) {
        const existing = index.get(node.qualifiedName);
        if (!existing || (existing.members.length === 0 && node.members.length > 0)) {
          index.set(node.qualifiedName, node);
        }
      }
    }
  }
  return index;
}

/** Builds the inspector for a node (or an empty state when nothing is selected). */
export function renderInspector(node: DiagramNode | null, handlers: InspectorHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-inspector';

  if (!node) {
    const empty = document.createElement('p');
    empty.className = 'koi-inspector-empty muted';
    empty.textContent = 'Select an element in the outline or a diagram to see its details.';
    root.appendChild(empty);
    return root;
  }

  // Header: the element name (jumps to source when it has a span) + its stereotype.
  const header = document.createElement('div');
  header.className = 'koi-inspector-head';
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'koi-inspector-name';
  name.textContent = node.label;
  const span = node.sourceSpan;
  if (span) {
    name.title = 'Go to definition';
    name.addEventListener('click', () => handlers.onGoto(span));
  } else {
    name.disabled = true;
  }
  header.appendChild(name);
  if (node.stereotype) {
    const stereo = document.createElement('span');
    stereo.className = 'koi-inspector-stereotype';
    stereo.textContent = node.stereotype;
    header.appendChild(stereo);
  }
  root.appendChild(header);

  // Member compartments, only those that have rows.
  appendSection(root, 'Properties', node.members.filter((m) => m.kind === 'field').map((m) => m.text));
  appendSection(root, 'Behaviors', node.members.filter((m) => m.kind === 'method').map((m) => m.text));
  appendSection(root, 'Values', node.members.filter((m) => m.kind === 'value').map((m) => m.text));

  return root;
}

/** Append a titled list section, or nothing when there are no rows. */
function appendSection(root: HTMLElement, title: string, rows: string[]): void {
  if (rows.length === 0) return;
  const section = document.createElement('section');
  section.className = 'koi-inspector-section';
  const h = document.createElement('h4');
  h.textContent = title;
  section.appendChild(h);
  const list = document.createElement('ul');
  for (const row of rows) {
    const li = document.createElement('li');
    li.textContent = row;
    list.appendChild(li);
  }
  section.appendChild(list);
  root.appendChild(section);
}
