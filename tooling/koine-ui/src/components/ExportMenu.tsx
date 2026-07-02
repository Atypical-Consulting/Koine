// The diagram Export ▾ floating menu (Koine Studio issues #271/#534), extracted from CanvasPalette as a
// dedicated, tested Preact component (#759 — consolidating the floating-menu pattern, cf. #547), and
// moved here verbatim (issue #905, Task 4). It is a native `<details class="koi-export">` disclosure:
// compact, keyboard-accessible without an ARIA menu pattern, and closing on its own `<summary>`. Picking
// an item closes the menu (here) and fires the callback; the two remaining dismissal paths a transient
// menu needs — outside-click and overlay-open — stay a document-level imperative listener in the
// consuming app (Koine Studio's `src/shell/exportMenuDismiss.ts`), an intentional seam no per-component
// effect should duplicate.

/** The canvas export targets — the live diagram itself, never a `.koi` construct, so never context-gated. */
export type ExportFormat = 'svg' | 'png' | 'plantuml';

const EXPORTS: { format: ExportFormat; label: string; tooltip: string }[] = [
  { format: 'svg', label: 'SVG', tooltip: 'Download the diagram as a standalone SVG' },
  { format: 'png', label: 'PNG', tooltip: 'Download the diagram as a 2× PNG image' },
  { format: 'plantuml', label: 'PlantUML', tooltip: 'Download the diagram as PlantUML (.puml) source' },
];

export function ExportMenu(props: {
  /** Export the current Visual canvas as SVG / PNG / PlantUML (#271). */
  onExport: (format: ExportFormat) => void;
  /** Copy the current diagram's Mermaid source to the clipboard (#271). */
  onCopyMermaid: () => void;
  /** Initial open state, for stories/tests; the native `<details>` toggles freely after mount. */
  defaultOpen?: boolean;
}) {
  // Close the enclosing Export <details> after an item is picked (#534). A native disclosure only toggles
  // via its own <summary>, so without this the popover lingers open over the canvas (and could paint above
  // a later modal scrim). Removing `open` is idempotent and keyboard-safe (Enter/Space fires `click` too).
  const closeMenu = (ev: Event): void => {
    (ev.currentTarget as HTMLElement).closest('details.koi-export')?.removeAttribute('open');
  };

  return (
    <details class="koi-export" open={props.defaultOpen}>
      <summary class="koi-palette-btn koi-export-summary" title="Export this diagram" aria-label="Export diagram">
        <span class="koi-palette-label">Export ▾</span>
      </summary>
      <div class="koi-export-menu">
        {EXPORTS.map((e) => (
          <button
            type="button"
            class="koi-export-item"
            data-export={e.format}
            key={e.format}
            title={e.tooltip}
            onClick={(ev) => {
              closeMenu(ev);
              props.onExport(e.format);
            }}
          >
            {e.label}
          </button>
        ))}
        <button
          type="button"
          class="koi-export-item"
          data-export="mermaid"
          title="Copy the diagram's Mermaid source to the clipboard"
          onClick={(ev) => {
            closeMenu(ev);
            props.onCopyMermaid();
          }}
        >
          Copy Mermaid
        </button>
      </div>
    </details>
  );
}
