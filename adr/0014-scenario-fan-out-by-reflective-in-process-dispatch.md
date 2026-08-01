---
id: 14
title: Scenario fan-out dispatches downstream reactions reflectively, inside the existing sandbox child
status: proposed
date: 2026-08-01
tags: [tooling, scenario-runner, execution]
links: [{type: relates-to, target: 11}, {type: relates-to, target: 12}]
---

# Scenario fan-out dispatches downstream reactions reflectively, inside the existing sandbox child

## Context and Problem Statement

A scenario today is a single-aggregate story: given a state, run one command or factory on one target,
report the timeline. The executed runner ([#236](https://github.com/Atypical-Consulting/Koine/issues/236),
"Approach A", [ADR 0011](0011-scenario-execution-sandbox.md)) drives the emitted C# for that one
aggregate and stops when the command returns. But a Koine model does not stop there: an `emit` is the
*start* of a story, not its end, and the fidelity review that produced
[#1758](https://github.com/Atypical-Consulting/Koine/issues/1758) named this gap #5 — the runner shows a
`ChargeCaptured` step and says nothing about the ledger entry the model says that event posts.

The language has exactly two downstream surfaces, verified by grep rather than assumed, and they differ
in kind:

1. **`policy P when E then Target.member(args)`** — in-context, cross-aggregate. `PolicyDecl` carries a
   `PolicyReaction(TargetType, CommandName, Args)`, and the target member is a real emitted method. So
   this **is executable**, and `ModelIndex.PoliciesTriggeredByEvent` already builds the graph. The
   pizzeria's `policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)` is the
   shipped example.
2. **`publishes E` / `subscribes Publisher.E`** — cross-context. Every emitter produces only a bodiless
   handler seam (C#: `IHandle<E>`), so there is **nothing to run**: the model declares that Kitchen,
   Delivery and Payment react to `OrderPlaced`, and declares nothing about *how*.

Koine has no `handles` / `on <event>` declaration, so those two are the whole surface.

Three forces shape the decision. First, **a scenario run is an interactive click** — ADR 0011 already
pays process start plus a full parse/emit/Roslyn-compile (~1.5–2.4 s measured in
[#1738](https://github.com/Atypical-Consulting/Koine/pull/1738)), and fan-out must not multiply that.
Second, **the downstream aggregate is a different object with a different state**, and the scenario's
`given` describes only the primary one — so something has to decide what the downstream aggregate starts
from. Third, **a context map can be cyclic**: a policy chain, or an event that re-enters its own
aggregate, must not be able to cascade until the sandbox's wall clock kills the run, because a timeout
is reported as "your model may loop" and would be a lie.

The rule this must not break is [#1738](https://github.com/Atypical-Consulting/Koine/pull/1738)'s: the
runner **never invents state**. Everything it cannot establish is a note naming precisely what was
missing.

## Considered Options

* **(a) Reflective in-process dispatch, inside the sandbox child that already ran the primary command.**
  Resolve the emitted event to its declared policy reactions, establish the downstream aggregate's state,
  and invoke the reaction's method on the *same* loaded assembly — one emit, one compile, one process.
* **(b) One emit + compile per downstream aggregate.** Treat each reaction as a nested scenario run, with
  its own emit/compile/execute cycle.
* **(c) Emit a real message bus into the generated code** — a dispatcher the emitted aggregates publish
  to, so fan-out happens the way it would in production.
* **(d) Resolve the downstream targets but do not run them** — report the declared reactions as notes and
  leave execution to the user.

## Decision Outcome

Chosen option: **(a) — reflective in-process dispatch inside the existing sandbox child**, because the
assembly that can answer the question is already loaded in the process that already ran the primary
command, and neither of the other executing options buys anything for what they cost.

Option (b) was rejected on arithmetic: emit and Roslyn-compile are the expensive halves of a run, and
they produce *the same assembly every time* — the model does not change between the primary command and
the reaction it triggers. A three-reaction chain would pay that cost four times, turning an interactive
click into ten seconds for no additional fidelity. Option (c) was rejected on layering: a message bus is
a runtime concern the emitters do not have and should not grow *for the runner's benefit* — it would
change shipped generated code (and every snapshot) to serve a tooling feature, and it would make fan-out
fidelity a property of each of the six code emitters rather than of the runner. Option (d) is honest but
answers a weaker question: the value of executed mode is that the downstream invariant *really fires*,
which resolution alone can never show. It survives inside (a) as the treatment of the non-executable
surface — subscriptions are reported, never simulated.

We will therefore:

- **Resolve before dispatching.** `ScenarioFanOutResolver` maps an emitted event onto what the model
  declares: *executable* policy reactions (resolved to the entity that really owns the member — a
  reaction may name the aggregate, `Books.record`, while the method lives on `LedgerEntry`), and
  *declared-only* cross-context subscribers. The second list is reported as an honest note — "the model
  declares no executable handler" — and never as a fabricated step. The resolver reads the model only:
  it emits nothing, reflects over nothing, and never throws.
- **Establish the downstream state by rule, never by guess (D2).** In priority order: a **per-aggregate
  `given`** slice — keys of the form `<Entity>.<member>`, routed to that entity with the prefix stripped
  and constructed through its own emitted all-args constructor; a **factory** target, which builds its
  own instance and so needs no prior state; otherwise **unavailable**, with a reason naming the aggregate
  and the exact key that would drive it. A bare (undotted) key is always the primary aggregate's and is
  never routed downstream. Per-aggregate keys need no wire-shape change: `Scenario.Given` is already
  `IReadOnlyDictionary<string, ScenarioValue>`, so dotted keys are purely additive.
- **Bound the cascade (D5).** A fixed maximum fan-out depth **and** a visited set over
  `(aggregate, event)` pairs. Hitting either is reported in `Notes`. The cap must bite well inside the
  wall-clock budget, so a cyclic model is diagnosed as a cycle rather than as a timeout.
- **Keep `Ok` about the primary operation (D6).** A downstream invariant failure is a *failed step
  attributed to that aggregate*, carrying the real `DomainInvariantViolationException` message — which is
  a feature under [#1738](https://github.com/Atypical-Consulting/Koine/pull/1738)'s taxonomy, not an
  error — plus a note. It does not flip the primary result, because the primary command really did
  succeed and saying otherwise would misreport it.
- **Confine this to executed mode (D7).** `ScenarioInterpreter` (Approach B) is untouched and keeps
  single-aggregate semantics: it cannot construct a downstream aggregate's state or run its command
  without becoming a second, divergent execution engine. `ScenarioExecutor.Run` still never throws.
- **Change no boundary.** Fan-out runs entirely inside ADR 0011's child process under ADR 0012's
  confinement, adds no process, no protocol change and no new artifact. `Ast/` stays target-agnostic and
  `Semantics/` stays Approach B's home; the mechanism lives in `src/Koine.Execution/`.

## Consequences

**Easier:**

- The runner answers the question the model actually poses. `ChargeCaptured` now shows the ledger entry
  it posts, with the downstream aggregate's real computed state and its real invariant outcomes — the
  same four gaps executed mode closes for the primary aggregate, closed for the ones it triggers.
- Fan-out is nearly free at runtime: the assembly is already loaded, so a reaction costs a reflective
  construction and a method call, not a compile. The interactive budget ADR 0011 promised is unaffected.
- The `given`-routing rule is a pure function of a dictionary and an entity name, so the rule is unit
  tested without emitting or compiling anything — the expensive half is exercised only where it earns it.
- The two downstream surfaces stay visibly different in the output. A user who wonders why Kitchen shows
  no steps for `OrderPlaced` is told, by the run itself, that the model declares a subscription and no
  behaviour — which is a modelling fact worth learning, not a runner limitation to hide.
- The starting-state rule generalizes what was already there: the executor's construction and snapshot
  machinery is now parameterized by entity rather than pinned to one, so the downstream path is the
  *same* code as the primary path rather than a parallel implementation that can drift.

**Harder / trade-offs accepted:**

- **A downstream aggregate with no `<Entity>.<member>` given produces a note, not a run.** That is the
  point — the alternative is a default instance whose invariants are a fiction — but it does mean the
  most interesting fan-out cases need the scenario author to describe a second aggregate, and the feature
  looks inert until they do. The reason string is therefore part of the feature, not an error message:
  it names the aggregate, what the given state does describe, and the exact key to add.
- **A construction that a domain invariant rejects is not "unavailable".** It is surfaced with its real
  message so it can be reported as the failed step it is. Collapsing the two would hide a genuine domain
  finding behind a runner-shaped note, so the mechanism carries a distinct outcome for it and refuses to
  swallow the exception.
- **`Ok: true` with a failed downstream step will read as a bug to someone.** It is recorded here so that
  it reads as a decision instead: `Ok` answers "did the operation under test complete", and a policy's
  reaction is not the operation under test. The step's attribution and the note are what carry the
  downstream verdict.
- **The depth cap is arbitrary and will occasionally truncate a legitimate chain.** A fixed number cannot
  distinguish a deep model from a cyclic one; the visited set catches true cycles, and the cap catches
  what it cannot. Both are reported in `Notes` rather than silently applied, so a truncated run is
  visible as truncated.
- **Executed and interpreted mode now differ in more than fidelity.** Until #1758, Approach B differed
  from Approach A only in what it could *evaluate*; now it also differs in what it *covers*. One timeline
  still renders either mode (the step contract is unchanged, with attribution as an additive property),
  but "run this scenario" means slightly different things in the two modes, and the UI has to say which
  one produced a result.
- **Resolution is by simple name, as everywhere else in the runner.** A reaction targeting a type name
  declared in more than one context is reported as ambiguous rather than guessed at — the same
  limitation, and the same treatment, as `ScenarioExecutor.TryResolveType` already applies to the primary
  target. Qualifier support belongs in both runners at once, not in fan-out alone.
- **Reflective dispatch inherits reflection's failure modes.** A reaction whose emitted method cannot be
  bound (an argument the runner cannot map from the event's payload) is a note naming what could not be
  driven, not a step — which keeps the "never a guess" rule but means some declared reactions will show
  up only as prose.
