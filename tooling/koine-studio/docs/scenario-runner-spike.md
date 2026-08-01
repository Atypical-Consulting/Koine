# Scenario runner spike & scope (#149)

> **Status: SCOPED — Approach B (model-level interpreter) chosen for v1; Approach A (WASM
> emit-and-execute) is a flagged follow-up.** *(Since 2026-08-01, Approach A has shipped as an opt-in,
> desktop/CLI-only execute mode — see the [addendum](#addendum-2026-08-01--a-shipped-as-the-opt-in-execute-mode-236)
> at the end of this note; the browser path is still a follow-up.)* This note is the design contract the rest of
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

## Task 4 — Approach A (emit & execute) evaluation

**Verdict: defer A as an opt-in "high-fidelity" mode (CLI/Roslyn first), not the default.** B's
interpreted fidelity covers the north-star's core loop on the modelled subset; A is worth pursuing
only to close the specific gaps below, and its cost (a compile-and-run toolchain in an interactive
loop, plus an arbitrary-code-execution surface) does not justify making it the default. A follow-up
issue tracks it.

### Where B diverges from A (the fidelity gap that A would close)

These are the concrete points where interpreting the model differs from running the emitted code. Each
is a *documented* gap — the interpreter surfaces it as `Indeterminate` + a note, never a wrong answer:

| # | Construct | B (interpreter) | A (emit & execute) |
|---|---|---|---|
| 1 | Derived members / value-object arithmetic — e.g. `total = lines.sum(l => l.payable)`, `subtotal = unitPrice * quantity` | `Indeterminate` (no value-object value model; `EvalSum` returns `Unknown` for a VO selector) | the generated `operator+` / derived getters compute a real `Money` |
| 2 | Value-object construction & its invariants — e.g. a `Money { amount < 0 }` supplied in given-state | accepted as data (B never constructs the VO, so its `invariant amount >= 0` does not run) | the emitted VO constructor throws `DomainInvariantViolationException` |
| 3 | State-machine legality — a `status -> X` not allowed by the `states` block | applied and shown (legality is not enforced) | the emitted transition guard throws |
| 4 | Exact failure semantics / messages | a precondition `Failed` halts; messages mirror the source | the real exceptions, ordering and short-circuit behaviour of the shipped code |
| 5 | Cross-aggregate / integration-event fan-out | out of scope (one aggregate in isolation) | could run the real downstream reaction of a `policy … then Target.member(…)` — but a cross-context `publishes`/`subscribes` pair gets only a bodiless handler seam from every emitter, so there is nothing there for *any* approach to run (see [Fan-out](#fan-out-what-the-model-says-happens-next-1758)) |

The existing **Roslyn meta-test** (`tests/Koine.Compiler.Tests`, which compiles *and executes* the
emitted C#) is effectively Approach A already, in a test harness — proof that A is feasible and the
natural place its machinery would be reused.

### Cost of A (why it is deferred)

- **CLI / Tauri:** emit C# → compile with Roslyn → load the assembly → reflectively construct the
  aggregate and invoke the command → read back events/state. Seconds per run, a non-trivial reflective
  driver for *arbitrary* aggregates, and — critically — it **executes generated code from a
  user-authored model**, an arbitrary-code-execution surface that needs sandboxing.
- **Browser / WASM:** Studio already ships the Blazor/.NET compiler in-browser, but *executing* the
  emitted C# there means a second Roslyn-in-WASM compile-and-load (or an emit-to-WASM) step — heavy,
  and gated by the very per-tab memory ceilings the mobile spike flags
  ([#219](https://github.com/Atypical-Consulting/Koine/issues/219), `mobile-wasm-spike.md`).

### Recommendation

Keep **B as the default** runner. Pursue **A as an opt-in mode** ("execute generated code"),
**CLI/Tauri-first** behind a flag, reusing the Roslyn meta-test harness; treat the browser path as a
later, separately-gated step. Prioritise A only if users hit gaps **#1/#2** (derived values and
value-object validation) in practice — those are the gaps most visible in the timeline today.

### Addendum (2026-08-01) — A shipped as the opt-in execute mode ([#236](https://github.com/Atypical-Consulting/Koine/issues/236))

The recommendation above is what shipped, unchanged in shape: **B remains the default**, A is a per-run
opt-in on the hosts that can run it, and — the addition the spike did not foresee — **every** response
now names the engine that produced it, so the two modes can never be confused for one another.

#### Invocation surface

| Layer | What shipped |
|---|---|
| LSP | `koine/runScenario` gained two optional params: **`execute`** (boolean, default `false`) and **`timeoutMs`** (number, default **5000**, clamped to **100 ms – 60 s**). Every response — both engines, both hosts, success *and* failure — carries **`"mode": "executed" \| "interpreted"`**. Executed runs are serialized per workspace by a `SemaphoreSlim(1,1)` in `LspServer`, so two quick `execute: true` requests run in sequence rather than as two concurrent Roslyn compiles inside the editor backend. |
| Engine | `src/Koine.Execution/` (new, non-packable): `GeneratedAssemblyCompiler` (the Roslyn compile-and-load harness, lifted out of the test project's `TestSupport` — exactly the reuse the spike predicted), `ScenarioValueBinder`, `ScenarioExecutor` (emit → compile into a collectible `AssemblyLoadContext` → drive the real types reflectively → **B's own `ScenarioResult` contract**), and `ScenarioExecutionHost` (spawn / confine / drain / deadline / kill / cleanup), with `ScenarioSandbox` + `ScenarioConfinement` + `WindowsJobObject` planning and applying the OS-level confinement described below. |
| CLI | A **hidden** `koine scenario-exec` verb (`src/Koine.Cli/Commands/ScenarioExecCommand.cs`): one JSON request on stdin, one result tree on stdout, **always exit 0** — every failure is reported *inside* the tree as `ok: false` plus a note. It is a protocol endpoint spoken by `ScenarioExecutionHost`, not a command a human runs. |
| Studio | A capability-gated checkbox **"Execute generated code (high fidelity)"** on the scenario panel, rendered only where the new `Platform.supportsScenarioExecution` capability is true (Tauri `true`, browser `false`). Default **OFF**, session-only — nothing is written to settings. The timeline header carries a mode chip read from **`result.mode`** (what actually happened), never from what was requested. |
| Browser | `execute: true` reaching the WASM backend is answered by the interpreter with `mode: "interpreted"` **plus a note that execution is not available on this host** — degraded and explicitly so, never a silently interpreted answer wearing an executed label. The flag is still forwarded, so the degradation is stated by the one component that knows it. |

#### Sandbox contract ([ADR 0011](../../../adr/0011-scenario-execution-sandbox.md))

The spike flagged "an arbitrary-code-execution surface that needs sandboxing"; ADR 0011 is the answer,
and it is deliberately narrower than the word "sandbox" suggests:

- **A killable child process, not a thread.** `ScenarioExecutionHost` spawns the hidden verb of the very
  `koine` binary the host is already running (no second artifact to package or version-match), streams the
  request in over stdin, drains stdout and stderr concurrently, and enforces a **wall-clock deadline**
  (`ScenarioExecutionHost.DefaultTimeout`, 5 s). On expiry it kills the child **and its whole process
  tree** and returns a not-ok tree carrying a timeout note. .NET cannot abort a runaway managed thread, so
  a process is the only thing that can actually *stop* a non-terminating derived member.
- **The boundary is drawn before emit, not after compile.** The request carries the model's `.koi`
  **sources**, so parse → emit → Roslyn-compile → execute all happen in the child; the editor host runs
  **zero** model-derived work in its own process — not even the compile. (This is stronger than the
  sketch in #236, which passed a pre-built assembly path.)
- **Housekeeping on every path.** The child runs with a **scrubbed environment** (an allow-list — it
  inherits none of the host's tokens, proxies or build state, and the runtime's diagnostics IPC channel
  is switched off) and a working directory set to a **per-run temp directory deleted on success, failure
  and kill alike**.
- **OS-level confinement on top of all of that** ([ADR 0012](../../../adr/0012-scenario-sandbox-os-confinement.md),
  [#1759](https://github.com/Atypical-Consulting/Koine/issues/1759)) — **best-effort, and uneven by
  platform on purpose**:
  - *Every platform:* a **managed-heap ceiling** (1 GiB by default) and a **processor-time ceiling**
    derived from the wall-clock budget. A run stopped at either gets a note **naming that ceiling**, not
    the timeout note — so "it allocated" is never reported as "it loops".
  - *macOS:* a `sandbox-exec` profile that **denies the network** and **denies writes outside the per-run
    directory**.
  - *Linux:* a **Landlock** ruleset that **denies writes outside the per-run directory** (kernel 5.13+;
    installed by a hidden `koine sandbox-landlock` launcher that `exec`s the child, since the ruleset has
    to be installed by the process it confines — [#1781](https://github.com/Atypical-Consulting/Koine/issues/1781)),
    plus an unprivileged user + network namespace (`unshare --user --map-root-user --net`) that **denies
    the network** — the latter only where the distribution permits unprivileged user namespaces (Ubuntu
    24.04's AppArmor policy does not, which is why this repo's own CI runner degrades to a note for the
    network half; Landlock needs no privileges, so the write half holds there).
  - *Windows:* a **Job Object** carrying the memory and CPU ceilings (and killing the child if the host
    dies). No filesystem or network confinement — a restricted token needs `CreateProcessAsUser`.
  - **Reads stay unrestricted everywhere** (the child must load the runtime and its own assemblies), and
    every mechanism is **probed before use**. Anything unavailable is appended to the result's `notes`
    and surfaced on `ScenarioChildRun.SandboxNotes`; **a scenario never fails because confinement is
    unavailable.**
- **It is still not a containment boundary against a hostile actor.** The confinement above is defence in
  depth: it makes the emitter's "no I/O primitives" premise an *enforced* property on macOS and on a
  Landlock-capable Linux rather than a stated one, and bounds the resource attacks that are the realistic
  failure. Its job remains protecting
  the **editor host** from hangs, crashes and resource exhaustion. ADR 0011 states that trust model
  plainly and requires revisiting *before* Koine ever executes a model authored by someone other than the
  operator (a hosted playground, a CI bot running a PR's model) — ADR 0012 does not change that, and
  notes that only the Linux path is CI-covered (`build-and-test` is `ubuntu-latest` only).

#### Fidelity gaps, revisited

Rows **#1–#4** of the gap table above are **closed in executed mode**. Row **#5 is closed for the
cross-aggregate case and honestly reported — not executed — for the cross-context one**
([#1758](https://github.com/Atypical-Consulting/Koine/issues/1758), [ADR
0014](../../../adr/0014-scenario-fan-out-by-reflective-in-process-dispatch.md)): a `policy` reaction is
really dispatched onto the aggregate it names, while a `publishes`/`subscribes` pair has no handler body
in any emitter to dispatch *to*, so it is named in the notes instead of simulated. Each row is pinned by
tests in `tests/Koine.Compiler.Tests/Semantics/ScenarioExecutionTests.cs` — #1–#4 over the pizzeria
`Ordering` fixture, #5 over a `Charge`/`LedgerEntry` posting model:

| # | Construct | Status in executed mode |
|---|---|---|
| 1 | Derived members / value-object arithmetic | **Closed** — `total = lines.sum(l => l.payable)` is the real emitted `Money`, where B returns `Indeterminate`. |
| 2 | Value-object construction & its invariants | **Closed** — a negative `Money` in the given state is rejected by the emitted constructor; the failure is reported as a failed invariant check resolved back to the *declared* invariant, not as a runner error. |
| 3 | State-machine legality | **Closed** — an illegal `status -> X` is a failed step; the transition and everything after it never happen. |
| 4 | Exact failure semantics / messages | **Closed** — the real `DomainInvariantViolationException` rule text, the real ordering and short-circuit behaviour of the shipped code. |
| 5 | Cross-aggregate / integration-event fan-out | **Closed for cross-aggregate; reported, not executed, for cross-context** — a `policy P when E then T.m(…)` reaction is really dispatched, its steps attributed to `T` and its state merged under `<Entity>.<member>` keys. A cross-context `publishes`/`subscribes` pair is resolved and named in the notes as *declared with no executable handler*, never fabricated into steps. See [Fan-out](#fan-out-what-the-model-says-happens-next-1758). |

Two consequences worth stating, because they are visible in the timeline:

- The happy-path timeline is **shape-compatible** with the interpreter's — same steps, same order, same
  kinds — with one deliberate divergence: a `placedAt -> now` transition prints B's unpinned marker `now`
  in interpreted mode and the real clock stamp in executed mode.
- Executed mode pays process startup **plus a full parse/emit/Roslyn-compile per run**, which is why it
  is opt-in, per-run, and off by default. Caching the compiled assembly across runs is a later
  optimisation the protocol leaves room for.

#### Fan-out: what the model says happens next ([#1758](https://github.com/Atypical-Consulting/Koine/issues/1758))

An `emit` is the *start* of a story, not its end. Executed mode therefore keeps going past the operation
under test: every event the emitted code really recorded is resolved against what the model declares
downstream, and the executable half of that is **dispatched reflectively inside the sandbox child that is
already running** — one emit, one compile, one process ([ADR
0014](../../../adr/0014-scenario-fan-out-by-reflective-in-process-dispatch.md)). Executed mode only:
interpreted mode (B) is untouched and keeps single-aggregate semantics.

Koine has exactly two downstream surfaces, and the runner treats them differently *because they differ in
kind*:

- **`policy P when E then Target.member(args)`** — in-context, cross-aggregate. `member` is a real
  emitted method, so the reaction is **really run**: the steps it produces are appended to the same
  timeline, each carrying the downstream entity's name, and its post-state merges into `resultingState`.
- **`publishes E` / `subscribes Publisher.E`** — cross-context. Every emitter produces only a bodiless
  handler seam (C#: `IHandle<E>`), so there is nothing to run. The subscribing contexts are **resolved and
  named in `notes`** ("the model declares a subscription and no executable handler"), never fabricated
  into steps. As the language stands this branch is also unreachable from a *recorded* event —
  `emit X` resolves `X` to an `EventDecl`, so emitting an integration event is a hard validator error
  (`KOI0601`, "unknown event") — which is why the pizzeria publishes `OrderPlaced` and emits
  `OrderPlacedInternally`. The resolver answers the question anyway, so the day `emit` accepts an
  integration event the runner reports it honestly instead of pretending the boundary was crossed.

**Attribution.** Steps gained one additive, optional property: `aggregate`. It is written **only** on a
fanned-out step — a primary-aggregate step (i.e. every step interpreted mode ever produces, and every step
executed mode produced before #1758) omits the key entirely, so an older result keeps exactly the wire
shape it had. Studio renders it as a chip naming the aggregate, on a step indented under the one that
triggered it.

**Downstream starting state — by rule, never by guess.** The scenario's `given` describes the *primary*
aggregate, so a downstream one needs its own. In priority order: a **per-aggregate `given`** — a key of
the form `<Entity>.<member>` (or `<Aggregate>.<member>`; both spellings reach the same root entity),
routed to that entity and built through its own emitted constructor; a **factory** target, which builds
its own instance and needs no prior state; otherwise **nothing is invented** — the run reports a failed
step attributed to that aggregate plus a note naming the exact key that would have driven it. A bare
(undotted) key is always the primary aggregate's and never leaks downstream.

```jsonc
// given, for `Charge.capture` with `policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)`
{ "amount": 12, "settled": false, "LedgerEntry.balance": 5, "LedgerEntry.closed": false }
// → resultingState: { "settled": "true", "amount": "12", "LedgerEntry.balance": "17", … }
```

**Bounds.** The cascade is bounded twice, because one bound cannot do the job alone: a **visited set** over
the reactions already dispatched — `(aggregate, member, policy, event)` — terminates a cyclic model, and a
**depth cap of 3** truncates a genuinely deep, non-repeating chain a visited set can never see. Both bite
far inside the sandbox's wall clock, so such a model is diagnosed as *cyclic* or *truncated* rather than
misreported as a timeout — and hitting either is always a note in `notes`, never a silent stop. The visited
key names the *reaction* rather than only the `(aggregate, event)` pair, so two policies reacting to one
event on one aggregate both run; they run against the **same** instance, in resolution order, because an
aggregate is established once per run.

**`ok` still reports the primary operation.** A downstream invariant failure is a *failed step attributed
to that aggregate*, carrying the emitted code's real rule text, plus a note — it does not flip `ok`,
because the primary command really did succeed and saying otherwise would misreport it. `Ok: true` beside a
failed downstream step is the designed behaviour, not a bug (ADR 0014, D6).
