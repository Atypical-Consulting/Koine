# Epic R15 — Model Versioning & Evolution (implementation plan)

_Companion to [the design spec](../specs/2026-06-16-r15-model-versioning-design.md). Shipped 2026-06-16._

Follows the standard strictly-layered pipeline order. R15.1 lands first because R15.2's diff
reads the same AST.

## R15.1 — version stamp + `@since` / `@deprecated`

1. **Grammar** (`Grammar/KoineLexer.g4`, `KoineParser.g4`)
   - Lexer: `VERSION : 'version'` (after `MODULE`); `AT : '@'` (near `QUESTION`).
   - Parser: `contextDecl` gains `( VERSION IntLiteral )?`; new `annotation : AT Identifier ( LPAREN ( IntLiteral | StringLiteral ) RPAREN )?`; prepend `annotation*` to `member` and each type decl (`value`, `quantity`, `entity`, `aggregate`, `enum`, `event`, `integration event`); add `VERSION` to `declKeyword`.
2. **AST** (`Ast/Nodes.cs`) — `ContextNode.Version (int?)`; `TypeDecl.Since (int?)` + `Deprecated (string?)` (init props, like `ModulePath`, so they survive `with`); same two on `Member`.
3. **Visitor** (`Parsing/KoineModelBuilderVisitor.cs`) — read the context version in `BuildContext`; a `ReadAnnotations(ctx.annotation())` helper mapping `since`/`deprecated` (reusing `StripQuotes`/`UnescapeString`); wire into every type/member builder.
4. **Merge** (`Services/KoineCompiler.cs`) — `Version = existing.Version ?? ctx.Version` (first-seen wins).
5. **Diagnostics** (`Diagnostics/DiagnosticCodes.cs`) — `KOI1501` + catalogue entry.
6. **Validator** (`Semantics/SemanticValidator.cs`) — `ValidateAnnotationVersions` per context (recurses into aggregate nested types); Warning when `@since > version`.
7. **Emitter** (`Emit/CSharp/CSharpEmitter.cs`) — `WriteObsolete` + `EscapeCSharpString` helpers; call after `WriteXmlDoc` at each type/property site; add `[Obsolete(` to the `System` using trigger in `Assemble`.
8. **Glossary** (`Emit/Glossary/GlossaryEmitter.cs`) — context `— version N` heading; `Tag()` suffix for type/field `since`/`deprecated`.

## R15.2 — `koine check --baseline`

9. **Checker** (`Services/CompatibilityChecker.cs`, new) — `Check(baseline, current) → CompatibilityReport`; `PublishedSurface` + `DiffFields`; pure on `KoineModel`.
10. **Diagnostics** — `KOI1510`–`KOI1514` + catalogue entries.
11. **CLI** (`src/Koine.Cli/Program.cs`) — `check` dispatch; `RunCheck` (positional current + `--baseline`); `TryParseModel`; exit non-zero iff breaking; usage line.

## Tests (`tests/Koine.Compiler.Tests/`)
- `R15VersioningTests.cs` — 14 tests: parse/soft-keywords, `[Obsolete]` on type/property/integration-event-field, quote escaping, no-annotation cleanliness, glossary version+since+deprecated, KOI1501 (field, type, within-version, unversioned).
- `R15CheckTests.cs` — 14 tests: each breaking code, additive cases, identical, internal-ignored, shared-kernel field/type removal, open-host optional→required, plain-context exclusion, enum value add/remove.
- `EmitterSnapshotTests.cs` — `R15_fixture_emits_expected_csharp` + verified snapshot.

All 449 tests green via `./build.sh`. CLI exit codes smoke-tested (breaking → 1, compatible → 0).
