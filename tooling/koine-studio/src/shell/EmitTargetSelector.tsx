import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppState } from '@/store/index';
import { EMIT_TARGETS } from '@/shared/emitTargets';

export interface EmitTargetSelectorProps {
  store: StoreApi<AppState>;
  /** Commit a new emit target — the host persists it (User setting or the active workspace override) and
   *  applies it live, then mirrors the effective value back into the store, which re-renders this panel. */
  onChange: (target: string) => void;
}

// The top-bar emit-target selector (chrome v2, #923): the persistent project output language, given a
// home in the bar. It reflects the store's `emitTarget` (a mirror of the previewTarget setting, so it
// tracks changes made from Settings too) and opens a menu of the live EMIT_TARGETS; a pick routes
// through `onChange`. The status bar echoes the same store value (see ide.ts). It's a normal reactive
// panel (like HistoryControls / WorkspaceProblemsBadge): rendered once into #emit-target-host and left
// to re-render off the store — so it must NOT be given the render-once treatment the rail islands need.
export function EmitTargetSelector({ store, onChange }: EmitTargetSelectorProps) {
  const target = useStore(store, (s) => s.emitTarget);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Read EMIT_TARGETS live (replaced in place at boot from the backend capability query). The label is
  // the current target's displayName; an unknown id (a backend target the built-in list hasn't seen)
  // degrades to the raw id rather than showing nothing.
  const current = EMIT_TARGETS.find((t) => t.id === target);
  const label = current?.displayName ?? target;

  // Dismiss the menu on an outside click or Escape while it's open (mirrors the diagram Export ▾ menu).
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(id: string): void {
    setOpen(false);
    if (id !== target) onChange(id);
  }

  return (
    <div class="emit-wrap" ref={rootRef}>
      <button
        type="button"
        class="emit"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        title="Emit target language"
        onClick={() => setOpen((v) => !v)}
      >
        <span class="lang-dot" data-lang={target} aria-hidden="true" />
        <span class="emit-lbl">Emit</span>
        <span class="emit-name">{label}</span>
        <svg class="emit-caret" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6.5 8 10l4-3.5" />
        </svg>
      </button>
      {open && (
        <div class="emit-menu" role="menu" aria-label="Emit target">
          {EMIT_TARGETS.map((t) => (
            <button
              type="button"
              class="emit-menu-item"
              role="menuitemradio"
              aria-checked={t.id === target ? 'true' : 'false'}
              key={t.id}
              onClick={() => pick(t.id)}
            >
              <span class="lang-dot" data-lang={t.id} aria-hidden="true" />
              <span class="emit-menu-name">{t.displayName}</span>
              <span class="emit-menu-ext">{t.fileExtension}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
