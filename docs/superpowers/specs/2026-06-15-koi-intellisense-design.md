# Koine `.koi` IntelliSense — Design

**Date:** 2026-06-15
**Status:** Draft — awaiting user review
**Scope:** Completion, hover, and go-to-definition for `.koi` files, served by the existing Koine LSP server. Target editor: Rider/IntelliJ via the LSP4IJ plugin (matches the current diagnostics setup).

## 1. Summary

The Koine CLI already ships a BCL-only LSP server (`src/Koine.Cli/LspServer.cs`) that pushes diagnostics over stdio. This design extends it with three interactive features — completion, hover, go-to-definition — by adding an **editor-agnostic language-services layer** in `Koine.Compiler` and keeping `LspServer.cs` as a thin LSP-JSON translation shell.

All three features share a single **lexer-only token-locator** built on the existing `KoineLexer`. Because it never depends on a successful parse, **completion works on syntactically-broken (mid-edit) documents** — the case where it matters most. Hover and go-to-definition do build a model (via `KoineCompiler.Parse`) and degrade gracefully to "no result" when parsing fails.

This mirrors the existing layering: the compiler stays editor-agnostic (as `KoineCompiler.Diagnose` already is), and the CLI owns the JSON-RPC plumbing.

## 2. Architecture

```
LSP client (Rider/LSP4IJ)
        │  JSON-RPC over stdio (Content-Length framed)
        ▼
LspServer.cs  ── thin translation: LSP JSON ⇄ service calls, _docs cache, capability flags
        │
        ▼
KoineLanguageService  ── editor-agnostic: CompleteAt / HoverAt / DefinitionAt
        │                 returns plain records (no LSP/JSON types)
        ├── TokenLocator (lexer-only) ── shared "what is under the cursor" core
        └── KoineCompiler.Parse → new ModelIndex(model) ── for hover/definition/type candidates
```

New files live in `src/Koine.Compiler/Services/` next to `KoineCompiler.cs`.

## 3. The token-locator core

`TokenLocator` is a new `internal static` class in `src/Koine.Compiler/Services/TokenLocator.cs`. It is the single "what is under the cursor" engine all three features use.

**Input:** the full document `source` and an LSP 0-based `(line, character)`.

**Mechanics:**

1. **Position → offset.** Normalize text with the existing `LspServer.SplitLines` (CRLF→LF) and convert the 0-based `(line, character)` to a flat character offset via a new `internal static int OffsetOf(string[] lines, int line, int character)`. Clamp `line`/`character` to bounds — during typing the cursor often sits one past the end of a line.
2. **Lex by reusing `KoineLexer`.** `var lexer = new KoineLexer(new AntlrInputStream(source)); lexer.RemoveErrorListeners(); var stream = new CommonTokenStream(lexer); stream.Fill();`. Reusing the real lexer means the `REGEX_MODE` push after `matches` is reproduced for free — no hand-rolled scanner, no risk of mis-tokenizing `/regex/`.
3. **Channel filtering.** `WS`, `//` (`LINE_COMMENT`), and `/* */` (`BLOCK_COMMENT`) are `-> skip` and never enter the token stream — there is nothing to drop. `DocComment` is on the `DOC` channel; filter the default-channel token list and additionally treat any position inside a `DocComment` token's `[StartIndex, StopIndex]` as **not-code** (return no context).
4. **Locate.** Using ANTLR `IToken` `StartIndex`/`StopIndex` vs the flat offset: the *current* token contains `offset-1`; otherwise take the nearest token ending before the cursor (the token being typed/just-finished). `Partial` = the already-typed prefix of an `Identifier`/keyword token (`text[0 .. offset-StartIndex]`), empty when the cursor sits right after punctuation like `:` or `.`.
5. **Return `TokenContext`** — a record with: `PrecedingToken` (`IToken?`, the first default-channel token strictly before the cursor token — the *trigger*), `CurrentToken` (`IToken?`), `Partial` (`string`), and `EnclosingHint` from a cheap backward bracket/keyword scan (nearest enclosing decl keyword; whether we are inside an open `<…>`; whether a `matches` regex / string literal encloses us). The hint is heuristic and token-based, so it survives broken syntax.

`TokenLocator` never throws on malformed input (error listeners removed); worst case it returns a context with nulls and the caller yields nothing.

> **All token matching MUST reference named `KoineLexer` constants** (`KoineLexer.COLON`, `.DOT`, `.LT`, `.COMMA`, `.LPAREN`, `.RPAREN`, `.LBRACE`, `.RBRACE`, `.ASSIGN`, `.RARROW`, `.StringLiteral`, `.Identifier`, `.Regex`, `.DocComment`, `.ON`, `.FROM`, `.THEN`, `.NATURAL`). Never hard-code the integer values.

## 4. The language service API

`KoineLanguageService` (public, `src/Koine.Compiler/Services/KoineLanguageService.cs`) is the gateway the LSP server uses, holding a `KoineCompiler` like `LspServer` already does.

```csharp
public IReadOnlyList<CompletionItem> CompleteAt(string source, int line, int character);
public HoverResult?                  HoverAt(string source, int line, int character);
public DefinitionResult?             DefinitionAt(string source, int line, int character);

public record CompletionItem(string Label, CompletionItemKind Kind, string? Detail, string? Documentation);
public record HoverResult(string Markdown, SourceSpan Span);
public record DefinitionResult(SourceSpan Target);

public enum CompletionItemKind { Keyword, Class, Enum, EnumMember, Field, Property, Method }
```

**Model acquisition (precise).** `KoineCompiler.Parse(source)` returns `(KoineModel? Model, IReadOnlyList<Diagnostic>)` and yields `(null, errors)` on **any** syntax error. So each method does:

```csharp
var (model, _) = _compiler.Parse(source);
// model may be null on a broken doc
var index = model is null ? null : new ModelIndex(model);   // mirrors SemanticValidator.cs:17
```

`CompleteAt` proceeds with keyword-only candidates when `index` is null. `HoverAt`/`DefinitionAt` return `null` when `model` is null. (Note: `Parse` does **not** return a `ModelIndex` — the service constructs it.)

## 5. Completion rules

Driven entirely by `TokenContext`. Rules are evaluated in order; first match wins. All candidates are prefix-filtered by `Partial` (case-sensitive). Each rule names its trigger by `KoineLexer` constant.

1. **Type position** — `PrecedingToken` is `COLON` (member/param/readmodel-field type), or `COLON` right after `RPAREN` (operation/usecase/finder/query return), or `ON`/`FROM`/`THEN` (policy reaction), or `LPAREN` right after `NATURAL`, or a generic-arg position (see rule 1a). Emit `ModelIndex.CandidateTypeNames`, kind from `ModelIndex.Classify` (Value/Entity/Aggregate/Enum/Event/ReadModel/Query + primitives + `List`/`Set`/`Map`/`Range` + ID type names). When `index` is null, fall back to a static list of primitives + collection keywords only.
   - **1a. Generic args (`<…>`)** — only treat `LT`/`COMMA` as a type-arg position when the token immediately before the `LT` is a known/candidate type name **and** we are already in a type-reference context (after `COLON`/decl), per `EnclosingHint`. Otherwise suppress — `LT` is also the relational operator and `COMMA` appears in expressions, and a lexer cannot otherwise distinguish `Map<…>` from `a < b`. Documented limitation: mid-expression `<` offers no type completion (acceptable).
2. **Enum-member value position** — `PrecedingToken` is `ASSIGN` (`=`) on a member/param whose declared type is a known enum, or inside a `states` block per `EnclosingHint`. If the governing enum resolves, emit its `EnumDecl.Members` (kind `EnumMember`); otherwise (broken doc / unresolved) emit **all** keys of `ModelIndex.EnumMemberToType` as a best-effort fallback.
3. **Member-access position** — `PrecedingToken` is `DOT`. **Only when a model exists** and the receiver type can be resolved: emit `ModelIndex.MemberNames(receiverType)` (kind `Property`), plus the synthetic `id` for entities and the built-in pseudo-members (`length`/`trim`/`lower`/`upper`/`isBlank`/`count`/`isEmpty`/`isNotEmpty`/`isPresent`/`isNone`). If the model is null or the receiver cannot be reconstructed from tokens, **return no member completions** (no `TypeResolver.Infer` on the broken path — it needs a parsed `Expr` + `TypeScope`).
4. **Declaration-starter position** — `Partial` at a statement start (`PrecedingToken` is `LBRACE`/`RBRACE`/start-of-file, not a type/`DOT` trigger). Emit the keywords valid for the nearest enclosing decl per `EnclosingHint`: file → `context`; context → value/quantity/entity/aggregate/enum/event/spec/service/policy/readmodel/query; aggregate → type decls + spec + repository; entity body → states/command/create; service → operation/usecase; repository → operations/find. Kind `Keyword`.
5. **Suppression (fallback)** — if `EnclosingHint` says we are inside a `Regex` or `StringLiteral`, or the cursor is inside a `DocComment` token, or `PrecedingToken` is null with no model, **return empty**. Also return empty (not the full list) when `Partial` matches nothing.

## 6. Hover rules

`HoverAt` locates the identifier-or-soft-keyword token (accept both `Identifier` **and** decl-keyword token types, since soft keywords like `value` can be used as names). With a parsed model, resolve in priority order:

1. `ModelIndex.TryGetDecl(name)` → render `**name** *(kind)*` (kind from `Classify`) + a kind-specific body + the node's `Doc` (already stripped/joined by the visitor).
2. Else `ModelIndex.EnumsDeclaring(name)`: exactly one → render as that enum's member; ≥2 → an "ambiguous member (declared in EnumA, EnumB)" card.
3. Else `ModelIndex.IsAnySpec(name)`/`AllSpecs` → spec card with target type + `Doc`.
4. Else walk `ModelIndex.Model.Contexts[].Services` (and their nested operations/use-cases) and `.Policies` by name — these are not in `ModelIndex._byName`.

**Per-kind body:** Value/Quantity → member list `name : Type` (`MemberAnalysis.IsDerived` tags derived); Entity → identity type + id strategy (+ backing type for `Natural`) + members + command/factory names; Aggregate → root name + versioned flag + nested-type count; Enum → member names (+ signature when it has associated data); Event → members; ReadModel → source type + fields; Query → criteria + result type. Primitives / collection keywords / ID value objects (no `TypeDecl`) render a minimal kind-only card. Returns `null` when the model is null or nothing resolves. `Span` is the located token start.

## 7. Go-to-definition rules

`DefinitionAt` resolves the located identifier to a declaration `SourceSpan`; the server converts it to an LSP `Location`. Resolution mirrors hover:

1. Type reference → `ModelIndex.TryGetDecl(name)` → `decl.Span`.
2. Enum member → `EnumMemberToType[member]` → enum decl → matching `EnumMember.Span` (lands on the member, not just the enum). Ambiguous (`EnumsDeclaring ≥ 2`) → pick first deterministically (documented limitation).
3. Spec → `TryGetSpec`/`AllSpecs` → `SpecDecl.Span`.
4. Service/operation/policy → walk `Model.Contexts`.

Returns `null` when the model is null, no decl matches, or the target has no node/`Span` (primitives, ID value objects, collection keywords — not navigable).

> **Span caveat (v1, documented):** `KoineModelBuilderVisitor.SpanOf` is `new(ctx.Start.Line, ctx.Start.Column + 1)` — it points at the **declaration keyword** (`value`/`entity`/`enum`/…), not the name token, and `Column` is already 1-based. So go-to-definition lands on the keyword. The server converts to a 0-based LSP range as `start = (Target.Line - 1, Target.Column - 1)` and returns a **zero-width range** there (`end == start`) rather than widening over token text (widening would underline the keyword, not the name). A precise name-token span is out of scope (would require changing `SpanOf`).

## 8. Server changes (`LspServer.cs`)

1. **Capabilities** (in the `initialize` result dictionary): add `["completionProvider"] = new Dictionary<string,object?> { ["resolveProvider"] = false, ["triggerCharacters"] = new[] { ":", "." } }`, `["hoverProvider"] = true`, `["definitionProvider"] = true`. Keep `["textDocumentSync"] = 1`.
2. **Document cache** `private readonly Dictionary<string,string> _docs = new();` — populate on `didOpen`/`didChange`, update on `didSave` (when text present), remove on `didClose`. The position-only requests read the latest text from here (no-result when the uri is absent).
3. **`private readonly KoineLanguageService _ls = new();`** next to `_compiler`.
4. **Three new `case` labels** in the `Loop()` switch (requests-with-id — must leave the `default` branch that returns `-32601`): `textDocument/completion`, `textDocument/hover`, `textDocument/definition`. Each extracts the uri (`TryGetUri`) and position (new `TryGetPosition` reading `params.position.{line,character}`), looks up `_docs`, calls the matching `_ls` method, translates, and `Respond`s. Null result → `Respond(root, (object?)null)`.
5. **Response shapes** (use `Dictionary<string,object?>` to match existing code):
   - Completion: `{ "isIncomplete": false, "items": [ { label, kind, detail, documentation } ] }`, mapping `CompletionItemKind` → LSP numbers (Keyword=14, Class=7, Enum=13, EnumMember=20, Field=5, Property=10, Method=2).
   - Hover: `{ "contents": { "kind": "markdown", "value": <markdown> } }`.
   - Definition: `{ "uri": <same uri>, "range": { start, end } }` with `start == end` per §7.
6. **`private static bool TryGetPosition(JsonElement root, out int line, out int character)`**. No `Console.Write` to stdout anywhere — use `Log()`.

## 9. File layout

| File | Change | Purpose |
|---|---|---|
| `src/Koine.Compiler/Services/TokenLocator.cs` | NEW | Lexer-only locator: `TokenContext`, `OffsetOf`, `EnclosingHint` scan |
| `src/Koine.Compiler/Services/KoineLanguageService.cs` | NEW | `CompleteAt`/`HoverAt`/`DefinitionAt` + result records + kind enum |
| `src/Koine.Cli/LspServer.cs` | CHANGED | Capabilities, `_docs` cache, `_ls`, 3 request cases, `TryGetPosition`, kind mapping |
| `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs` | NEW | Service-layer + `TokenLocator` tests |
| `tests/Koine.Compiler.Tests/LspServerTests.cs` | CHANGED | Protocol-layer completion/hover/definition + capability assertions |
| `README.md`, `tooling/README.md` | CHANGED | Document the new IntelliSense capabilities + Rider/LSP4IJ setup |

## 10. Test plan

**Service layer (`KoineLanguageServiceTests`):**
- `TokenLocator`: after `:` → `PrecedingToken == COLON`, empty `Partial`; after `matches /ab` → inside-regex hint (suppress); after `.` → `PrecedingToken == DOT`; mid-identifier `Cust|` → `Partial == "Cust"`; cursor inside a `///` doc comment → not-code.
- `CompleteAt` type position on the Billing fixture returns `CandidateTypeNames` (incl. `List`/`Decimal` + declared types); `Partial == "Ord"` filters to `Ord*`.
- `CompleteAt` on a **syntactically broken** document (missing `}`) still returns keyword + type candidates — proves the parse-independent path.
- `CompleteAt` declaration-starter: top level → only `context`; inside `service { }` → operation/usecase; inside `repository { }` → operations/find.
- `CompleteAt` enum value: `status: OrderStatus = Dr` → members starting `Dr`; broken doc with no model → all `EnumMemberToType` keys.
- `HoverAt` over a type → markdown with kind label + `Doc`; over a member declared in two enums → ambiguous card; over a primitive → minimal card.
- `DefinitionAt` over a type ref → `decl.Span` (assert it is the **keyword** start per `SpanOf`); over an ID value object / primitive → null.
- `OffsetOf` round-trips against `SplitLines` for multi-line CRLF text.

**Protocol layer (`LspServerTests`, via `RunSession`):**
- `Initialize()` output contains `"completionProvider"`, `"hoverProvider":true`, `"definitionProvider":true`.
- `DidOpen` + completion request → JSON contains `"items"`; hover → `"markdown"`; definition → `"range"`. Unknown request still → `-32601`.

## 11. Risks & limitations

- **Go-to-definition lands on the declaration keyword**, not the name token (`SpanOf` limitation); range is zero-width. Precise spans deferred.
- **`LT`/`COMMA` generic-arg vs relational-operator** is not fully lexer-distinguishable; rule 1a is conservative and skips uncertain cases rather than offering wrong candidates.
- **Member-access completion needs a parsed model** — unavailable on broken docs; returns nothing there rather than guessing.
- **Ambiguous enum members** (declared in ≥2 enums): completion lists all, hover shows an ambiguous card, definition picks the first deterministically.
- **Soft keywords as names**: hover/definition must accept decl-keyword token types as identifiers, not only `Identifier`.
- **Document cache** must stay consistent with Full-sync text and clear on `didClose` to avoid stale results.

## 12. Out of scope

Signature help; find-references; rename/prepareRename; cross-file / workspace symbols; precise name-token definition spans; incremental sync / AST reuse (still Full sync, re-parse per request); completion `resolve` and snippet/auto-import insert text.
