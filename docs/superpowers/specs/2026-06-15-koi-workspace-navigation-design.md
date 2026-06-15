# Koine `.koi` Cross-File (Workspace) Navigation — Design

**Date:** 2026-06-15
**Status:** Draft — awaiting user review
**Scope:** Make go-to-definition and hover resolve across all `.koi` files in the workspace, not just the open document. Completion is explicitly out of scope (stays single-file/lexer-only).
**Builds on:** `docs/superpowers/specs/2026-06-15-koi-intellisense-design.md` (the single-file IntelliSense already merged).

## 1. Problem

The shipped IntelliSense resolves hover and go-to-definition against **only the open document**. Real Koine models are split across files — one `context` per file (e.g. `catalog.koi`, `customers.koi`, `ordering.koi`). So:

- A reference like `ProductId` in `ordering.koi`, whose `entity Product identified by ProductId` lives in `catalog.koi`, resolves to nothing → the editor shows "Cannot find declaration to go to."
- `*Id` value objects are not navigable at all (they have no standalone declaration node; they are synthesized from `identified by`).

Both manifest as the feature looking broken on any multi-file model. This design fixes both.

## 2. Goals / Non-goals

**Goals**
- Go-to-definition resolves to declarations in **any** `.koi` file in the workspace, returning the correct target file URI.
- Hover renders a card for a symbol declared in **any** workspace file.
- `*Id` references navigate to the `entity … identified by XId` that owns them.
- Files **open in the editor** use their live (possibly-unsaved) text; unopened files are read from disk.

**Non-goals (this round)**
- Cross-file **completion** (stays single-file, lexer-only).
- Live re-indexing of files edited **outside** the editor (baseline is scanned at startup; see §7).
- Rename, find-references, workspace symbols.

## 3. Architecture

```
LspServer.cs (Koine.Cli)
  • captures rootUri / workspaceFolders on `initialize`
  • scans workspace for *.koi → _workspaceFiles (uri → on-disk text)
  • overlays _docs (open/edited files) on top
  • builds the merged uri→text map, calls the workspace-aware service
        │
        ▼
KoineLanguageService (Koine.Compiler.Services)
  • DefinitionAt(documents, activeUri, line, character)
  • HoverAt(documents, activeUri, line, character)
  • uses TokenLocator on the active doc to find the cursor token
        │
        ▼
WorkspaceIndex (Koine.Compiler.Services) — NEW
  • built from a uri→text map; parses each doc once
  • Lookup(name) → declaration locations across all files
```

`WorkspaceIndex` is the new editor-agnostic unit: a plain `uri → text` map in, name-resolution out. No LSP/JSON, fully unit-testable.

## 4. `WorkspaceIndex`

**Construction:** from `IReadOnlyDictionary<string, string> documents` (URI → source). For each document, run `KoineCompiler.Parse`; if it parses (`model != null`), record its declarations. A document that fails to parse contributes nothing (one broken file does not poison the rest).

**Indexed declarations** (each entry carries the owning `Uri` and a `SourceSpan`):
- Declared types — value/quantity, entity, aggregate, enum, event (and read-model/query if present): `Name → (uri, decl.Span)`.
- Specs: `spec.Name → (uri, spec.Span)`.
- Enum members: `member.Name → (uri, member.Span)` (also remembers the owning enum name, for hover text).
- **ID types:** for every `EntityDecl` with `IdentityName == XId`, map `XId → (uri, entity.Span)` so an ID reference navigates to its owning entity.

A single name can map to several locations (the same name declared in multiple files/contexts, or shared enum members) — `Lookup` returns **all** of them.

**API (illustrative):**
```csharp
public sealed record DeclLocation(string Uri, SourceSpan Span, DeclCategory Category, string? OwnerEnum = null);
public enum DeclCategory { Type, EnumMember, Spec, IdType }

public sealed class WorkspaceIndex
{
    public WorkspaceIndex(IReadOnlyDictionary<string, string> documents);
    public IReadOnlyList<DeclLocation> Lookup(string name);
    // For hover rendering, also exposes the resolved TypeDecl/owning info per location
    // (reusing the single-file RenderHover logic).
}
```

## 5. Resolution semantics

The cursor token name comes from `TokenLocator.Locate` on the **active** document (unchanged).

**Go-to-definition** (`DefinitionAt(documents, activeUri, line, character)`):
1. Locate the token; if none / inside string-or-regex → null.
2. `WorkspaceIndex.Lookup(name)`.
3. **Local-first:** if any location's `Uri == activeUri`, prefer it (so a `Currency` declared in the current file wins over one elsewhere). Among same-file matches, apply the single-file precedence already used (type > enum member > spec) and the existing enum-member ambiguity rule (≥2 owning enums in that file → skip enum-member match).
4. Else if exactly **one** other file declares the name → navigate there.
5. Else (no match, or ambiguous across ≥2 other files) → null.
6. Return `DefinitionResult(Uri, Span)`.

**Hover** (`HoverAt(documents, activeUri, line, character)`): same lookup/precedence; render the card from the resolved declaration (reusing the existing per-kind markdown). Returns `HoverResult(Markdown)` (no URI needed). Ambiguity across files → null (consistent with definition).

**ID navigation:** because `XId` is indexed to its owning entity, both `DefinitionAt` and `HoverAt` resolve `ProductId` → the `Product` entity (in whatever file declares it). Hover shows the entity card; definition jumps to the entity's declaration keyword.

## 6. API & server changes

**Result type:** `DefinitionResult(SourceSpan Target)` → `DefinitionResult(string Uri, SourceSpan Target)`. `HoverResult` unchanged.

**`KoineLanguageService`:**
- `DefinitionAt(IReadOnlyDictionary<string,string> documents, string activeUri, int line, int character)` and `HoverAt(...)` — workspace-aware. They build (or are given) a `WorkspaceIndex`, resolve per §5.
- The existing single-file `DefinitionAt(source, line, character)` / `HoverAt(...)` overloads are **replaced** by the doc-map forms (the server always has at least the active doc, so it always calls the workspace form). Existing single-file service tests migrate to a one-entry document map (`{ activeUri: source }`).
- `CompleteAt` is **unchanged**.

**`LspServer` (`Koine.Cli`):**
- On `initialize`, read `params.rootUri` (and `params.workspaceFolders[*].uri`); store the root path(s).
- Build `_workspaceFiles` (`uri → text`): recursively enumerate `*.koi` under the root(s) and read each. Skip `bin/`, `obj/`, `.git/`, hidden dirs. Tolerate read errors per file (skip + `Log`).
- Keep the existing `_docs` (open/edited files). The **merged map** for a request = `_workspaceFiles` overlaid by `_docs` (open version wins; an open file not yet on disk is still included).
- `textDocument/definition` and `textDocument/hover` build the merged map and call the workspace-aware service. Definition emits `Location { uri = result.Uri, range = zero-width at Target }` (target URI may differ from the request URI now).
- `didOpen/didChange/didSave` keep `_docs` current (already do). `didClose` drops from `_docs` (falls back to the on-disk baseline).
- URI↔path conversion: handle `file://` URIs (the only scheme Rider/LSP4IJ sends). A small helper converts both ways; non-`file:` URIs are skipped.

**Capabilities:** unchanged (`hoverProvider`/`definitionProvider` already advertised). Optionally set `workspace.workspaceFolders.supported` — not required for v1.

## 7. Edge cases & limitations

- **External edits to closed files:** the on-disk baseline is scanned at `initialize`; files changed outside the editor (and not open) re-index only on server restart. Open files are always live via `did*`. Per-file caching keyed by content/version is a future perf optimization.
- **Cross-file ambiguity:** a name declared as a type in ≥2 *other* files → null (no misleading jump). Documented.
- **Per-file parse errors:** a file that fails to parse contributes nothing to the index; references *into* it won't resolve until it's fixed, but every other file still resolves.
- **No workspace root** (server started without `rootUri`): fall back to single-document behavior (only `_docs` in the map) — equivalent to today.
- **Large workspaces:** definition/hover are on-demand (not per-keystroke); re-parsing N small files per request is acceptable for v1. Caching noted above.

## 8. File layout

| File | Change | Purpose |
|---|---|---|
| `src/Koine.Compiler/Services/WorkspaceIndex.cs` | NEW | Multi-document declaration index + `Lookup` |
| `src/Koine.Compiler/Services/KoineLanguageService.cs` | Modify | Workspace-aware `DefinitionAt`/`HoverAt`; `DefinitionResult` gains `Uri` |
| `src/Koine.Cli/LspServer.cs` | Modify | rootUri capture, `*.koi` scan, `_docs` overlay, URI↔path, target-URI in definition |
| `tests/Koine.Compiler.Tests/WorkspaceIndexTests.cs` | NEW | Multi-doc resolution: cross-file type, ID→entity, local-first, ambiguity→null, broken-file isolation |
| `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs` | Modify | Migrate hover/definition tests to the doc-map API; add cross-file cases |
| `tests/Koine.Compiler.Tests/LspServerTests.cs` | Modify | Protocol test: open file A, definition in A resolves to a declaration in file B (target URI = B) |
| `README.md`, `tooling/README.md` | Modify | Note cross-file navigation; update the documented limitation |

## 9. Test plan

**`WorkspaceIndex` (unit):**
- Cross-file type: doc A references `Money`, doc B declares `value Money` → `Lookup("Money")` returns B's location.
- ID → entity: doc A references `ProductId`, doc B has `entity Product identified by ProductId` → `Lookup("ProductId")` returns B's entity location, category `IdType`.
- Local-first: both A and B declare `Currency`; resolving from A returns A's location.
- Ambiguity: `Widget` declared as a type in B and C (neither is the active file) → resolution yields null.
- Broken-file isolation: doc B has a syntax error; doc A still resolves its own symbols and any in doc C.

**`KoineLanguageService` (service):** migrate existing hover/definition tests to single-entry maps; add a two-document map test asserting `DefinitionResult.Uri` is the other file and the span is the declaration.

**`LspServer` (protocol):** `didOpen` **both** files (so both land in `_docs`, exercising the overlay without touching disk), then send `textDocument/definition` for a cross-file reference in file A; assert the response's `uri` is file B (the declaring file) and a `range` is present. A separate test covers the disk-scan path by pointing `rootUri` at a temp directory containing a `.koi` file and asserting it resolves without a `didOpen`.

## 10. Out of scope

Cross-file completion; live external-edit watching; rename/find-references/workspace-symbols; multi-root precedence rules beyond "scan all roots."
