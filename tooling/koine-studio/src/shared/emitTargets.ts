// The single front-end source of truth for Koine's emit targets (issue #282).
//
// The backend's `EmitterRegistry` knows every target the compiler supports; this list mirrors it so
// the output-language picker, the generate-project wizard, the Generated-tab labels and the
// assistant's compile-tool enum all read ONE list instead of re-declaring the set. The list is
// SEEDED at boot from the backend capability query (`koine/emitTargets` / the WASM `ListEmitTargets`
// bridge) via `setEmitTargets`, so adding a target to the registry surfaces it in the IDE with no
// front-end edit. The built-ins below are the offline fallback when that query is unavailable.
//
// Read `EMIT_TARGETS` LIVE at point-of-use (it is replaced in place at boot) — do not snapshot it at
// module load, or a backend-seeded target won't show. Syntax highlighting stays a small static map by
// design (a CodeMirror mode must be bundled per target): `langExt` in `editor/editor.ts` degrades an
// unknown target to plain text rather than treating its map as a second source of truth.

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
export const BUILTIN_EMIT_TARGETS: readonly EmitTarget[] = [
  { id: 'csharp', displayName: 'C#', fileExtension: '.cs' },
  { id: 'typescript', displayName: 'TypeScript', fileExtension: '.ts' },
  { id: 'python', displayName: 'Python', fileExtension: '.py' },
  { id: 'php', displayName: 'PHP', fileExtension: '.php' },
  { id: 'rust', displayName: 'Rust', fileExtension: '.rs' },
  { id: 'java', displayName: 'Java', fileExtension: '.java' },
  { id: 'asyncapi', displayName: 'AsyncAPI', fileExtension: '.yaml' },
  { id: 'openapi', displayName: 'OpenAPI', fileExtension: '.yaml' },
];

/**
 * The active emit-target list, in display order. Starts as the built-ins and is replaced IN PLACE by
 * {@link setEmitTargets} at boot once the backend query resolves, so every surface that reads this
 * array reference reflects the registry. Consumers must read it live (not snapshot it at module load).
 */
export const EMIT_TARGETS: EmitTarget[] = BUILTIN_EMIT_TARGETS.map((t) => ({ ...t }));

/**
 * Seed {@link EMIT_TARGETS} from the backend capability query. A null/empty list (offline, or the
 * query failed) falls back to {@link BUILTIN_EMIT_TARGETS}, so the IDE always offers every built-in
 * target. Replaces the contents in place so existing references to {@link EMIT_TARGETS} stay live.
 */
export function setEmitTargets(list: readonly EmitTarget[] | null | undefined): void {
  const next = list && list.length > 0 ? list : BUILTIN_EMIT_TARGETS;
  EMIT_TARGETS.splice(0, EMIT_TARGETS.length, ...next.map((t) => ({ ...t })));
}

/** True when `id` is one of the active emit targets (case-sensitive, as the backend reports ids). */
export function isEmitTarget(id: unknown): boolean {
  return typeof id === 'string' && EMIT_TARGETS.some((t) => t.id === id);
}
