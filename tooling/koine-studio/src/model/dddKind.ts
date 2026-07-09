// The canonical DDD-kind alias-fold (issue #1162). `Koine.Compiler/Emit/Glossary/GlossaryModelBuilder
// .KindOf` emits `"quantity"` (not `"value"`) for a `quantity` value object and `"integration event"`
// — a SPACE, not a hyphen — for an integration event. Two independent call sites used to hand-fold
// these same two spellings (`src/launcher/buildCatalog.ts`'s `normalizeKind` and this module's own
// `constructKey`) and had already drifted on their fallback behaviour. This module is the single
// source of truth both delegate to: pure, DOM-free, and deliberately not exported from `inspector.ts`
// so the launcher's pure-join `buildCatalog.ts` can consume it without pulling in DOM-heavy modules.
export function normalizeDddKind(kind: string): string {
  if (kind === 'quantity') return 'value';
  if (kind === 'integration event') return 'integration-event';
  return kind;
}
