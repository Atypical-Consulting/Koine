# Scenario runner spike & scope (#149)

> **Status: SCOPED — Approach B (model-level interpreter) chosen for v1; Approach A (WASM
> emit-and-execute) is a flagged follow-up.** This note is the design contract the rest of
> [#149](https://github.com/Atypical-Consulting/Koine/issues/149) is built against: what the existing
> semantic layer can already compute, the scenario shape, and the honest gap between interpreting the
> model (B) and executing the emitted code (A).

**Issue:** [#149](https://github.com/Atypical-Consulting/Koine/issues/149) — *Koine Studio
(north-star): interactive scenario runner — exercise a domain service / aggregate.*

## Goal

Let a modeller exercise the domain **inside Studio without leaving the editor**: pick an aggregate
command (or factory), supply a starting state and arguments, run it, and watch the
`command → events → invariant-checks` timeline. The point is a tight feedback loop on the *ubiquitous
language* — "if I place this draft order, what happens?" — answered against the live `.koi`, before a
single line of C# is generated.

## Two approaches

| | **A — emit & execute** | **B — interpret the model** |
|---|---|---|
| How | Emit C# (or TS), compile, run the command, read back events/state | Walk the semantic model's command body directly, evaluating its expressions over a runtime state map |
| Fidelity | Exactly what ships — the real generated behaviour | High for the modelled subset; no codegen quirks, but re-implements expression semantics |
| Cost | Needs the full WASM compile-and-run toolchain in the loop; slow; couples the runner to one target | Pure in-process; fast; **target-agnostic** (no C# concept involved) |
| Backend reach | Tauri can shell the CLI; browser needs the whole Blazor/WASM compiler warm | Works identically on both Studio backends — it's just another `koine/*` LSP method |

**Decision: B for v1.** It is the simplest viable fidelity, it is backend-agnostic, and it keeps the
runner inside the existing `Semantics/` layer with **no `Ast/` leakage and no emitter dependency**.
A is deferred behind a follow-up (Task 4) because it buys "bug-for-bug identical to the shipped code"
at the price of dragging the entire compile-and-execute toolchain into an interactive loop — a poor
trade until B's fidelity is shown to be insufficient.

## What the existing semantic layer can already compute

The honest inventory (it shaped the build): **`Semantics/` type-checks and constant-folds, but has no
value-level evaluator with variable bindings.** So "reuse the existing expression/invariant
evaluation" means reusing the *AST*, the *operator semantics*, and the *name-resolution index* — and
building the one missing piece (a runtime evaluator over a state map) once, in `Semantics/`.

| Reused as-is | Where | What it gives the interpreter |
|---|---|---|
| Expression AST | `Ast/Expressions.cs` | `BinaryExpr`/`UnaryExpr`/`MemberAccessExpr`/`CallExpr`/`LambdaExpr`/`ConditionalExpr`/`CoalesceExpr`/`IdentifierExpr`/`LiteralExpr`/`MatchExpr` — the exact node set to evaluate |
| Command/event/invariant nodes | `Ast/Nodes.cs` | `CommandDecl`/`FactoryDecl` bodies (`RequiresClause`, `Transition`, `Initialization`, `EmitClause`, `ResultClause`), `EventDecl`, `Invariant`, `StatesDecl` |
| Operator semantics | `Semantics/ConstantFolder.cs` | The canonical meaning of every `BinaryOp`/`UnaryOp` over numbers/bools/strings (decimal arithmetic, ordinal string equality, div-by-zero → not-a-value) — mirrored, not duplicated, in the runtime evaluator |
| Name resolution | `Ast/ModelIndex.cs` | `TryGetDecl`, `Classify`, member/enum lookups — find the aggregate root, its commands, its events, resolve a bare `Draft` to `OrderStatus.Draft` |
| Built-in op vocabulary | `Emit/CSharp/CSharpExpressionTranslator.cs` | The authoritative list (and meaning) of member ops (`isEmpty`/`count`/`isPresent`/`isNone`/`length`/`trim`/`lower`/`upper`/`isBlank`) and calls (`all`/`any`/`none`/`min`/`max`/`sum`/`distinctBy`/`startsWith`/`endsWith`/`contains`), plus special identifiers `now` and `id`. The interpreter matches these so an interpreted result equals what the emitted C# would do. |

**What did not exist and is built by this issue:** a `ScenarioInterpreter` that holds an aggregate
root's fields as a runtime value map, evaluates `Expr` over it (literals, identifiers, the operators
and built-ins above, lambdas inside collection ops), executes a command/factory body
(check `requires` → apply `->` transitions / `<-` initializations → collect `emit`s → compute
`result`), then re-checks every invariant against the resulting state. It degrades gracefully:
an expression it cannot evaluate becomes an `Indeterminate` outcome with a note, never a crash.

## Scenario shape (`given → when → then`)

```
given   state    a starting aggregate-root instance: field → value
when    command  one command or factory, with its arguments: param → value
then    result   the command → events → invariant-checks timeline
```

Modelled as target-agnostic records in `Semantics/Scenarios/` (no JSON, no C# concepts), so xUnit can
drive the interpreter directly and the LSP host owns the JSON ↔ value mapping:

```csharp
record Scenario(string Target, string Operation,
                IReadOnlyDictionary<string, ScenarioValue> Given,
                IReadOnlyDictionary<string, ScenarioValue> Args);

record ScenarioResult(bool Ok, string Target, string Operation,
                      IReadOnlyList<ScenarioStep> Steps,            // ordered timeline
                      IReadOnlyDictionary<string, string> ResultingState,
                      IReadOnlyList<InvariantCheck> Invariants,
                      string? Result, IReadOnlyList<string> Notes);
```

`ScenarioValue` is a small neutral value union (`Num`/`Bool`/`Text`/`EnumMember`/`List`/`Record`/
`Absent`/`Instant`/`Unknown`) used for inputs, evaluation, and display. `ScenarioStep` is a sealed
timeline-entry hierarchy (`requires` / `transition` / `emit` / `result`), each carrying a `Kind` tag
the LSP layer serialises.

The JSON shape that crosses the LSP boundary (`koine/runScenario`), mirroring the existing `koine/*`
methods:

```jsonc
// request params
{ "textDocument": { "uri": "…" },
  "target": "Order", "operation": "place",
  "given": { "status": "Draft", "lines": [ { "quantity": 2 } ] },
  "args":  {} }

// ScenarioResult
{ "ok": true, "target": "Order", "operation": "place",
  "steps": [
    { "kind": "requires", "message": "only a draft order can be placed", "outcome": "passed" },
    { "kind": "transition", "field": "status", "from": "Draft", "to": "Placed" },
    { "kind": "emit", "event": "OrderPlacedInternally", "args": { "orderId": "…", "lineCount": "1" } }
  ],
  "resultingState": { "status": "Placed", "placedAt": "now" },
  "invariants": [ { "message": "every line needs a positive quantity", "outcome": "passed" } ],
  "result": null, "notes": [] }
```

The headline fixture is the pizzeria `Ordering` aggregate (`templates/pizzeria/ordering.koi`): `Order`
with `command place` / `command cancel`, a `create open` factory, three invariants, and a `states`
machine — exactly the surface v1 targets.

## v1 scope (what ships in this issue)

**In:** entity / aggregate-root commands and factories; given-state + args supplied as JSON;
statement execution (`requires`, `->`, `<-`, `emit`, `result`); the operator + built-in vocabulary
above; lambdas inside collection ops; `now`/`id` specials; post-command invariant checks; the Studio
panel rendering the timeline; works on both the Tauri (CLI `koine lsp`) and browser (WASM) backends.

**Out (documented, not silently dropped):**

- **Approach A** (emit & execute) — Task 4 spike + follow-up.
- **Cross-aggregate / context-map effects** — integration-event fan-out, sagas, other aggregates
  reacting to an `emit`. The runner exercises *one* aggregate in isolation.
- **State-machine legality as a hard stop** — a `status -> X` transition is applied and surfaced;
  enforcing the `states` block as a rejection is a natural enhancement, noted not gated.
- **Multi-command sequences** — one command per run in v1 (chaining is a follow-up).
- **Specs / domain services / policies / queries** as runnable entry points — v1 runs commands and
  factories on aggregate roots only.
- Any expression the evaluator does not model resolves to `Indeterminate` with a `note`, so the gap
  is visible in the UI rather than hidden.

## Why this ordering

B first because it is the cheapest path to a real, in-editor feedback loop and it stays inside the
target-agnostic `Semantics/` layer the whole project is organised around. A is a fidelity upgrade
whose cost (toolchain-in-the-loop) only pays off once B's interpreted fidelity is measured against the
emitted behaviour — which is precisely what Task 4 sets up.
