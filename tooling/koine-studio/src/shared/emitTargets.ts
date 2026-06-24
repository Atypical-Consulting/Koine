// The single front-end source of truth for Koine's emit targets (issue #282).
//
// The backend's `EmitterRegistry` already knows every target the compiler supports; this list is the
// ONE place the Studio front-end mirrors it. The output-language picker, the generate-project wizard,
// the Generated-tab labels and the assistant's `koine_compile` tool enum all DERIVE from `EMIT_TARGETS`
// instead of re-declaring the set, so adding a target no longer means editing a fistful of call sites.
//
// These built-ins are the offline fallback: a later step seeds the list from a backend capability
// query (`koine/emitTargets` / the WASM bridge) so a registry-only target surfaces in the IDE with no
// front-end edit. Syntax highlighting stays a small static map by design (a CodeMirror mode must be
// bundled per target) — see `langExt` in `editor/editor.ts`, which degrades unknown targets to plain
// text rather than treating its map as a second source of truth.

/** One emit target the IDE can offer: the backend id, its human label, and the file extension it emits. */
export interface EmitTarget {
  /** The target identifier the compiler uses, e.g. `"csharp"` (case-insensitive on the wire). */
  id: string;
  /** The human-facing label shown in the picker / wizard / tab, e.g. `"C#"`. */
  displayName: string;
  /** The file extension the target emits, e.g. `".cs"`. */
  fileExtension: string;
}

/** The built-in emit targets, in display order — the offline fallback for the backend-fetched list. */
export const EMIT_TARGETS: EmitTarget[] = [
  { id: 'csharp', displayName: 'C#', fileExtension: '.cs' },
  { id: 'typescript', displayName: 'TypeScript', fileExtension: '.ts' },
  { id: 'python', displayName: 'Python', fileExtension: '.py' },
  { id: 'php', displayName: 'PHP', fileExtension: '.php' },
  { id: 'rust', displayName: 'Rust', fileExtension: '.rs' },
];
