# R16 — Multi-Target Emitters (TypeScript first) — Design

## Context

Koine compiles a target-agnostic `KoineModel` to source code. Today the only real backend is
the C# emitter (`src/Koine.Compiler/Emit/CSharp/`); a `GlossaryEmitter` produces Markdown.
Epic R16 (multi-target emitters) was **explicitly deferred "until the code is strong"** — that
bar is now met: the AST gained full source ranges, lossless trivia, a `SemanticModel`/`Symbol`
layer, and a refactor engine. The roadmap (`website/src/content/docs/guides/roadmap.md:98-125`)
specifies R16.1 (C# config), R16.2 (TypeScript), R16.3 (Rust), R16.4 (conformance harness).

**Scope (confirmed):** ship **R16.1 + R16.4 + R16.2 (TypeScript) end-to-end**; **Rust (R16.3)
is deferred** to a documented next phase. Fold in the two remaining real follow-ups (below).

**The architecture is already R16-ready** — this epic is largely additive:
- `IEmitter` (`Emit/IEmitter.cs`): `{ string TargetName; IReadOnlyList<EmittedFile> Emit(KoineModel, SemanticModel?) }`. `EmittedFile(string RelativePath, string Contents)`. `CSharpEmitter` and `GlossaryEmitter` already implement it.
- `KoineCompiler.Compile(IReadOnlyList<SourceFile>, IEmitter)` parses → builds one `SemanticModel` → validates → `emitter.Emit(model, semantic)`.
- The CLI (`Program.cs`) already parses `--target` and selects the emitter via a `switch`; `KoineConfig` already tolerates a reserved `targets.*` block (`KoineConfig.cs`).

**Reuse vs new** (from architecture survey): reuse `OperatorNeedsAnalyzer`, `EmitContext`, the
orchestration loop, namespace→folder logic, spec inlining, and guard patterns. New per target:
type mapper, naming, expression translator, runtime base types, file extension. ~40–50% new code.

## Goals / non-goals

- **Goal:** a TypeScript backend that emits idiomatic, `tsc`-clean code preserving Koine's
  invariants/identity/enum semantics, selectable via `koine build --target typescript`.
- **Goal:** a conformance harness that keeps every backend honest and `Ast/` target-agnostic.
- **Non-goal (this phase):** Rust (R16.3); per-build emission of multiple targets at once
  (single `--target` per invocation, config carries per-target options).

---

## Phase R16.1 — C# emitter configuration + config plumbing

Files: `src/Koine.Cli/KoineConfig.cs`, `src/Koine.Cli/Program.cs`, `Emit/CSharp/EmitContext.cs`.

- Extend `KoineConfig` to parse the structured `targets.<name>.*` keys it currently ignores
  (still tolerate unknown keys for forward-compat). Surface a per-target options bag, e.g.
  `TargetOptions { string? OutDir; IReadOnlyDictionary<string,string> NamespaceMap; InstantMode; Layout }`.
- Thread C# options into `CSharpEmitter` via `EmitContext` (currently carries `Index`,
  operator needs, context names, ID strategies): namespace remapping (e.g. `Catalog → Acme.Catalog`),
  `Instant` mode (`DateTimeOffset` default vs NodaTime), and file layout (file-per-type today).
- `WriteOutputAtomic` already groups by top-level folder; add per-target output dir resolution
  (`--out` ?? `targets.<t>.out` ?? `out`).

Acceptance: existing C# output is **byte-identical** when no target options are set (snapshot tests
unchanged); options demonstrably change output (new tests).

## Phase R16.4 — Conformance harness (built before TS so TS is validated as it lands)

Files: `tests/Koine.Compiler.Tests/Conformance/` (new), `tests/.../TestSupport.cs`.

1. **`Ast` purity guard:** a test asserting no type under `Koine.Compiler.Ast` references
   `Koine.Compiler.Emit.*` (reflection over assembly types / namespaces) — locks in target-agnosticism.
2. **TypeScript type-check harness:** `TestSupport.TypeCheckTypeScript(files)` writes emitted `.ts`
   to a temp dir and runs `tsc --noEmit --strict` (Node toolchain already present in `website/` and
   `tooling/koine-textmate`). Returns diagnostics like the Roslyn `Compile` harness does for C#.
   Skips gracefully (not fail) when no Node/`tsc` is found locally, but runs in CI.
3. **Snapshot tests** for TS output (Verify), mirroring `EmitterSnapshotTests`.
4. **Behavioral parity (best-effort):** for a couple of fixtures, run a scripted scenario in both
   C# (Roslyn, in-memory) and TS (`tsc` + `node`) asserting the same invariant-violation / equality
   outcomes. Kept small; expand later.

## Phase R16.2 — TypeScript emitter

New: `src/Koine.Compiler/Emit/TypeScript/{TypeScriptEmitter.cs, TypeScriptTypeMapper.cs, TypeScriptNaming.cs, TypeScriptExpressionTranslator.cs, TsRuntime.cs}`. Register `"typescript"` in the `Program.cs` target switch.

**Type mapping**

| Koine | TypeScript |
| --- | --- |
| `String` | `string` |
| `Int` | `number` |
| `Bool` | `boolean` |
| `Decimal` | `Decimal` (emitted runtime type; string-backed for money fidelity — `number` is lossy) |
| `Instant` | `Instant` (branded ISO-8601 string; `now` → runtime `Instant.now()`) |
| `List<T>` / `Set<T>` / `Map<K,V>` | `readonly T[]` / `ReadonlySet<T>` / `ReadonlyMap<K,V>` |
| optional `T?` | `T \| undefined` |

**Semantics**
- **Value objects:** immutable classes (or `readonly` interfaces + factory) with structural
  equality (`equals`) and derived members; scalar/additive operators where `OperatorNeedsAnalyzer`
  (reused) says so.
- **Entities:** identity equality by id; **branded primitive** id types (`type OrderId = string & { readonly __brand: 'OrderId' }`).
- **Enums:** string-literal **union** + a `const` object of members + smart-enum helpers
  (`Match`/`Switch`/`Try*`) emitted as functions, mirroring the C# smart-enum API.
- **Invariants:** throw `DomainInvariantViolationError` (TS runtime), same guard logic as C#
  (reuse the guard-shaping pattern; only the throw/exception name differs).
- **Naming (`TypeScriptNaming`):** `PascalCase` types, `camelCase` members/params, no `@`-escaping.

**Runtime (`TsRuntime`)** — emitted once, like `Koine.Runtime`: `Decimal`, `Instant`,
`DomainInvariantViolationError`, a `ValueObject` structural-equality helper, `Range<T>`.

**File layout:** one `.ts` per type, namespace→folder (reuse the `ns.Replace('.', '/')` logic);
optional `index.ts` barrels are a later nicety.

**Expression translation:** reuse the `Expr` visitor shape; translate `now`, regex `matches`
(→ `RegExp.test`), `sum`/folds (→ `reduce`), member access, conditionals, `let…in` (→ IIFE or
hoisted `const`s), `result` clauses.

---

## Folded-in follow-ups

- **`now`-shadow warning** (`Semantics/SemanticValidator.cs`): optional INFO/WARN when a field is
  named `now` (it legally shadows the builtin). Non-breaking.
- **`enums.md` doc sentence** (`website/src/content/docs/reference/enums.md` ~:245): note that the
  enclosing expected type (field/return/default) also disambiguates a bare enum member.

(Confirmed already done, not in scope: KOI0002 LSP surfacing; `let`/`in`/`result` TextMate + formatter.)

---

## Risks / decisions

- **`IEmitter` enrichment:** keep `IEmitter` as-is; introduce a shared `TargetEmitter` base only if
  the TS emitter reveals real duplication worth hoisting. Don't pre-abstract.
- **Decimal/money fidelity in JS:** `number` is lossy for money — emit a string-backed `Decimal`
  runtime type. Decision baked into `TsRuntime`.
- **CI dependency:** the TS harness needs Node + `tsc`; gate it to run in CI and skip-with-notice
  locally when absent (never silently pass).
- **Smart-enum API parity:** the TS enum helpers must match the C# `Match`/`Switch`/`Try*` surface
  so the conformance scenarios line up.

## Verification

- `dotnet test` green (C# byte-identical when no options set; new tests for config, TS output).
- Conformance: `Ast` purity guard passes; emitted TS passes `tsc --noEmit --strict`; TS snapshots
  reviewed; the best-effort behavioral-parity scenarios agree across C# and TS.
- End-to-end: `koine build demo/... --target typescript --out generated/ts` produces a tree that
  type-checks; spot-check the demo domain (value objects, an entity with a command + invariant, a
  smart enum) in the emitted TS.
