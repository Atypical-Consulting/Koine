---
id: 11
title: Scenario execution runs in a killable child process
status: proposed
date: 2026-08-01
tags: [tooling, scenario-runner, safety]
links: [{type: relates-to, target: 626}]
---

# Scenario execution runs in a killable child process

## Context and Problem Statement

The scenario runner ([#149](https://github.com/Atypical-Consulting/Koine/issues/149), "Approach B")
*interprets* the semantic model: it walks the command body and evaluates expressions itself. That is
safe by construction — nothing outside the interpreter ever runs — but it cannot answer four questions
that matter most when you are checking a domain: whether a derived value object really computes, whether
a value object's own invariants really fire while the given state is built, whether the emitted state
machine really rejects an illegal transition, and what the real
`DomainInvariantViolationException` message says. Those answers only exist if the model's emitted C# is
*executed*. Issue [#236](https://github.com/Atypical-Consulting/Koine/issues/236) is that mode
("Approach A"): emit → Roslyn-compile → drive the generated types reflectively.

Executing emitted code raises a question interpreting never did: **where does it run?** The caller is
the editor backend — `koine lsp` over stdio, and the same code path inside Koine Studio, which brokers
the `koine` binary as a Tauri sidecar. That process is long-lived and holds the user's workspace state.
Whatever runs a scenario shares its fate:

- a derived member with an unbounded loop never returns;
- an aggregate that allocates without bound takes the process's memory with it;
- a `StackOverflowException` or a failfast in the generated code cannot be caught at all — the process
  dies, and with it every open document's diagnostics, hover, and completion.

The forces are asymmetric: a scenario run is a *foreground, interactive* operation the user triggers
repeatedly from a panel, so it must be cheap and cancellable; but the emitted code is arbitrary
computation whose termination we cannot decide from the model.

The interpreter already met a small version of this problem and solved it locally: `VisitMatch` bounds
a model-authored regex with a 1 s `Regex.IsMatch` timeout, because a pathological pattern like `(x+)+y`
backtracks effectively forever inside the single-threaded host ([#626](https://github.com/Atypical-Consulting/Koine/issues/626)).
That fix worked because `Regex` *offers* a timeout. An emitted `while` loop offers nothing equivalent.

## Considered Options

* **A — Run the scenario in a sandboxed child process**, driven over a stdio JSON protocol, killed on a
  wall-clock deadline.
* **B — Run it in-process in a collectible `AssemblyLoadContext` with a watchdog thread**, unloading the
  context when the run finishes.
* **C — Hybrid: interpret first, escalate to execution per step** when the interpreter reports
  `Indeterminate`.

## Decision Outcome

Chosen option: "**A — run the scenario in a sandboxed child process**", because it is the only option
that can actually *stop* a run that will not stop by itself.

Option B was rejected on a hard platform fact, not a preference: .NET cannot safely abort a runaway
managed thread. `Thread.Abort` throws `PlatformNotSupportedException` on .NET Core and later, and there
is no supported replacement — cooperative cancellation requires the running code to poll a token, which
generated domain code neither has nor should have. So a watchdog thread can *observe* the deadline and
nothing more: the runaway thread keeps burning a core inside the LSP for the life of the editor session,
each subsequent hung run leaks another one, and an allocation storm in that thread OOM-kills the whole
editor backend. A collectible `AssemblyLoadContext` does not help here either — it reclaims the
*assembly* after the run completes, which is precisely the case that was never the problem.

Option C was rejected **for v1**, not on principle: interleaving interpretation and execution inside one
timeline gives a step-by-step run two different evaluation semantics, and the reconciliation ("which
engine produced this value?") is a UX and correctness question we do not need to answer yet. It stays
available later at no architectural cost, because A returns B's exact `ScenarioResult` contract — the
same `requires`/`transition`/`emit`/`result` step kinds — so one timeline renders either mode.

We will therefore:

- Add a **hidden `koine scenario-exec` command**. It reads one JSON request on stdin (the model's `.koi`
  sources, plus target / operation / given / args), runs the scenario, writes the `ScenarioResult` JSON
  tree on stdout, and exits 0 — including for failures, which are reported *inside* the tree as
  `ok: false` plus notes, never as an exit code the host has to interpret.
- Add **`ScenarioExecutionHost`**, which spawns that command as a child of the editor backend, streams
  the request in, drains stdout and stderr concurrently, and enforces a **wall-clock deadline (5 s by
  default)**. On expiry it kills the child *and its whole process tree*
  (`Process.Kill(entireProcessTree: true)`) and returns a not-ok result carrying a timeout note. The
  child runs with a **scrubbed environment**, its working directory set to a **per-run temp directory**
  whose removal is attempted on every path — success, failure, and kill alike — with a short bounded
  retry, because on Windows the run directory is the killed child's current directory and the OS holds
  a handle on it until the process is fully reaped. Cleanup stays *best effort*: a directory the OS will
  not release must not turn a completed run into a failed one, so the last word belongs to the temp
  reaper, not to us.
- **Reuse the `koine` binary the host is already running** as the child, rather than shipping a second
  executable: Koine Studio already brokers `koine` as a Tauri sidecar, and the VS Code extension already
  launches `koine lsp`, so the sandbox adds no new artifact to package, sign, or keep version-matched.
- Draw the boundary **before emit**, not after compile: the request carries the model's `.koi` source,
  so parsing, emitting, Roslyn-compiling and executing all happen in the child. The host never runs any
  model-derived work in its own process — not even the compile.

## Consequences

**Easier:**

- A hung or crashing scenario costs the user one killed child process and a `ok: false` result with an
  honest note. The editor backend keeps its workspace, its diagnostics, and its responsiveness — the
  last one only because the run is dispatched **off the LSP message-loop thread**: the loop is
  single-threaded, so an inline run would stop the server from reading or answering *anything* for the
  length of the budget. The worker answers the JSON-RPC request itself (framed writes are serialized),
  and a per-workspace semaphore keeps two `execute: true` requests from becoming two concurrent Roslyn
  compiles.
- The timeout is a real deadline rather than a best effort, so the Studio panel can promise bounded
  latency and offer a retry.
- Crash isolation comes free: a `StackOverflowException` or an `Environment.FailFast` in generated code
  kills only the child, and the host reports it as a failed run.
- The v1 boundary is testable end-to-end without mocks — the round-trip test drives the real child
  process and asserts its result tree is byte-identical to the in-process executor's.

**Harder / trade-offs accepted:**

- **This is NOT an OS-level sandbox, and v1 does not pretend to be one.** There is no `seccomp` filter,
  no macOS `sandbox_init`/`sandbox-exec` profile, no Windows Job Object, no user/namespace confinement.
  A .NET child process cannot cheaply deny filesystem or network access from managed code — the BCL is
  loaded, `File` and `Socket` are right there — and the .NET sandboxing story (Code Access Security) was
  removed on purpose and never replaced.
- The trust model this rests on, stated plainly so nobody mistakes the boundary for a security one:
  1. the emitted C# is produced by **our own emitter** from the user's model, and by construction
     contains no I/O primitives — no file, socket, process, or reflection-into-the-host surface;
  2. the model author **is the local user** — the same person who could run `koine build` and then
     `dotnet run` the generated code with their own credentials, so the child gains them nothing;
  3. the sandbox's job is to protect the **editor host** from hangs, crashes, and resource exhaustion —
     it is **not** a containment boundary against a hostile actor, and must not be relied on as one.
  If Koine ever executes a model authored by someone other than the operator (a hosted playground
  running an uploaded `.koi`, a CI bot running a PR's model), this ADR must be revisited *before* that
  ships. OS-level hardening — a seccomp profile on Linux, a sandbox profile on macOS, a Job Object with
  memory/CPU caps on Windows — is a documented follow-up, not a v1 guarantee.
- The child pays process startup plus a full parse/emit/Roslyn-compile per run (hundreds of milliseconds
  to a few seconds on a large model), where an in-process runner would pay only the compile. Caching the
  compiled assembly across runs is a later optimization the protocol leaves room for.
- `Koine.Cli` now references `Koine.Execution`, so the packaged `koine` tool carries Roslyn
  (`Microsoft.CodeAnalysis.CSharp`). The global tool and the self-contained single-file publish grow
  accordingly.
- The wall-clock deadline is a blunt instrument: a legitimately slow model on a slow machine is
  indistinguishable from an infinite loop, and gets the same not-ok-plus-note treatment. The default is
  a knob (`ScenarioExecutionHost.DefaultTimeout`) rather than a constant precisely so a host can raise it.
- Relation to [#626](https://github.com/Atypical-Consulting/Koine/issues/626): the interpreter's 1 s
  `Regex.IsMatch` timeout stays as-is and remains the right fix for *its* engine, which evaluates
  model-authored patterns itself. It bounds one specific API that happens to offer a timeout; it is not
  a general termination guarantee, and executed mode has no in-process equivalent. A killable process is
  the only cure for an infinite loop in an emitted derived member.
