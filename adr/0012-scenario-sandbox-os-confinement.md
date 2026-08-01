---
id: 12
title: Scenario sandbox confinement uses each platform's native mechanism, best-effort
status: proposed
date: 2026-08-01
tags: [tooling, scenario-runner, safety]
links: [{type: relates-to, target: 11}]
---

# Scenario sandbox confinement uses each platform's native mechanism, best-effort

## Context and Problem Statement

[ADR 0011](0011-scenario-execution-sandbox.md) put scenario execution in a killable child process and
was explicit about what that did *not* buy: process isolation, a wall-clock deadline with a
process-tree kill, a scrubbed environment and a per-run temp working directory — but "no `seccomp`
filter, no macOS `sandbox_init`/`sandbox-exec` profile, no Windows Job Object, no user/namespace
confinement". It named OS-level hardening as a documented follow-up. This is that follow-up
([#1759](https://github.com/Atypical-Consulting/Koine/issues/1759)).

The trust model ADR 0011 rests on — emitted C# contains no I/O primitives *by construction*, and the
model author *is* the operator — holds for the common case and fails in two concrete ones:

1. **A model the user did not author.** Opening a shared or downloaded `.koi` and pressing "Execute
   generated code" makes the author someone other than the operator, which is precisely the case ADR
   0011 says must be revisited before it ships.
2. **An emitter bug.** "No I/O by construction" is a property of the emitter, not an enforced boundary.
   A bug — or a future feature that emits an HTTP client or a transport layer — erodes it silently,
   with nothing in the build to catch the change.

There is a third, more mundane force: a runaway allocation is the most likely real-world failure of an
executed scenario, and today it is bounded only by the wall clock, so a model can make the machine swap
for the whole budget before anything stops it.

The constraint that shapes every option below: **.NET gives no pre-exec hook.** There is no place
between fork and exec to call `setrlimit`, `sandbox_init`, or install a Landlock ruleset, and
`Process.Start` offers no `CREATE_SUSPENDED`. Whatever is chosen has to be expressible either as *the
program being launched* or as something attachable to a process that is already running.

## Considered Options

* **Per-platform native confinement, applied at spawn, degrading gracefully.** `sandbox-exec` on macOS,
  an unprivileged network namespace on Linux, a Job Object on Windows, plus a portable managed-heap
  ceiling and a `RLIMIT_CPU` ceiling on Unix.
* **Resource caps only** — memory and CPU, no filesystem or network confinement.
* **Run the child in a container.** Uniform and strong across platforms.
* **Static-analyse the emitted C# and refuse to run anything referencing I/O namespaces.**
* **Keep ADR 0011's boundary and rely on the trust model.**

## Decision Outcome

Chosen option: **per-platform native confinement, applied at spawn, degrading gracefully**, because it
is the only option that enforces the premise the trust model asserts rather than restating it, and
because each mechanism is the platform's own supported answer rather than something Koine invents.

We will:

- **Cap resources on every platform.** A managed-heap hard limit (`DOTNET_GCHeapHardLimit`) is set on
  the child — portable, enforced by the child's own runtime, and landing exactly where a runaway
  allocation in emitted code lands. A processor-time ceiling is applied through `RLIMIT_CPU` on Unix and
  a Job Object on Windows. The CPU ceiling is **derived from the wall-clock budget** (every core's worth
  of the budget, with a floor), so it is a backstop against a process the tree-kill missed rather than a
  second, tighter deadline that would kill slow-but-honest runs.
- **Confine filesystem and network where the platform has a mechanism.** macOS gets a `sandbox-exec`
  profile that denies the network and denies writes outside the per-run directory; Linux gets an
  unprivileged user + network namespace (`unshare --user --map-root-user --net`), which denies the
  network. **Reads stay unrestricted everywhere** — the child must load the .NET runtime, the shared
  framework and its own assemblies, all outside the run directory, and a read restriction tight enough
  to matter would stop the runtime starting.
- **Apply confinement by becoming it.** On Unix the child *is* the confining launcher, which `exec`s
  into the real command: the PID, the three redirected pipes and therefore ADR 0011's
  `Kill(entireProcessTree: true)` and stdio protocol all survive untouched. On Windows the Job Object is
  attached immediately after `Process.Start`.
- **Probe availability, never assume it.** Every wrapper is run once per host process against a trivial
  command and the result cached. A mechanism that is missing, refused by the kernel, or that rejects its
  own profile is dropped *before* it can turn a working scenario into a failed one.
- **Degrade honestly, and never fatally.** Anything requested that this platform cannot enforce is
  appended to the result's `notes` and reported on `ScenarioChildRun.SandboxNotes`. A scenario never
  fails *because* confinement is unavailable. This is the same truthfulness rule `mode` already follows.
- **Distinguish a cap breach from a deadline.** A child stopped at a resource ceiling gets a note naming
  that ceiling, not the timeout note — telling a user their model loops when it actually allocated sends
  them hunting the wrong bug.
- **Shut the diagnostics IPC channel** (`DOTNET_EnableDiagnostics=0`): a control surface through which
  anything on the machine could attach a profiler to the child, which the sandbox has no use for.

This **amends** ADR 0011's Consequences rather than superseding the ADR: its decision — execution runs
in a killable child process — stands unchanged, and only the "no OS-level confinement" trade-off it
recorded is now partly retired. Per `adr/README.md`'s partial-supersession rule, both ADRs carry a
`relates-to` link and ADR 0011's Consequences point here.

**Not chosen, and why.** *Resource caps only* addresses the likeliest failure but leaves the
exfiltration case entirely open, so it does not close the issue's motivation. *A container* is strong
and uniform but makes a container runtime a hard dependency of an editor feature, and image pull/start
cost dwarfs the ~1.5–2.4 s round trip measured in [#1738](https://github.com/Atypical-Consulting/Koine/pull/1738)
— unacceptable for an interactive click. *Static analysis of the emitted C#* is cheap and portable and
enforces exactly the premise the trust model rests on, but it is a denylist that reflection or
`Type.GetType` defeats: worth adding as defence in depth later, never as a substitute for OS
enforcement. *Keeping the v1 boundary* fails case 1 above and leaves nothing to catch the emitter
growing an I/O primitive.

## Consequences

**Partial supersession of [ADR 0011](0011-scenario-execution-sandbox.md).** ADR 0011's decision — scenario
execution runs in a killable child process — stands unchanged and is not superseded. What this ADR retires
is one *trade-off* it recorded: the bullet stating there is no seccomp filter, no `sandbox-exec` profile,
no Job Object and no filesystem or network denial. That bullet now carries an amendment pointing here, and
both ADRs carry a `relates-to` link, per `adr/README.md`'s partial-supersession rule. ADR 0011's status and
the rest of its content stay as they are — including its trust model, which still governs.

**Easier:**

- The premise ADR 0011 asserts is now *checked* on macOS rather than merely stated: a child that tries
  to write outside its run directory or open a socket is denied by the kernel, whatever the emitter did.
- A runaway allocation meets a ceiling instead of the machine's swap, and says so — the note names the
  limit rather than blaming the wall clock.
- A process that escapes the tree-kill still dies: `RLIMIT_CPU` is inherited by everything the child
  starts, and the Job Object's `KILL_ON_JOB_CLOSE` makes the handle a dead-man's switch if the editor
  host itself crashes.
- Confinement is testable without a hostile model. The suite drives purpose-built stub children through
  `KOINE_SCENARIO_EXEC_COMMAND` and asserts the *enforced* behaviour — a write outside the run directory
  denied, a write inside it allowed, a connection refused, a spin loop stopped by the CPU ceiling rather
  than the deadline — with the confinement-off run kept as the control.

**Harder / trade-offs accepted:**

- **Coverage is uneven, and the code says so rather than implying otherwise.** macOS gets filesystem and
  network confinement; Linux gets network only — Landlock needs a ruleset installed in the child between
  fork and exec (no hook), and bubblewrap is a dependency an editor feature cannot assume; Windows gets
  neither, because a restricted or low-integrity token requires `CreateProcessAsUser` and hand-plumbing
  all three redirected pipes. Each gap is a note on the run.
- **CI covers one of the three platforms.** `build-and-test` runs on `ubuntu-latest` only, so the macOS
  `sandbox-exec` path and the whole Windows Job Object path ship **manually verified, not CI-verified** —
  the same blind spot that produced PR #1738's Windows-only review findings. The macOS path was verified
  by hand on macOS 26 (the full suite green, including the real pizzeria round trip under the profile);
  the Windows path has not been executed at all, and is written so that any failure in it degrades to a
  note rather than a broken run.
- **The Job Object is attached a moment after the child starts.** `Process.Start` offers no
  `CREATE_SUSPENDED`, so there is a window — runtime start-up, before any model-derived code runs — in
  which the caps are not yet in force. Closing it means replacing `Process.Start` with a hand-rolled
  `CreateProcess`, a large amount of interop for a window nothing can currently reach.
- **`sandbox-exec` is deprecated by Apple.** It remains functional and is the only mechanism a
  command-line tool launched from an editor can apply to itself without an App Sandbox entitlement. If a
  future macOS removes it, the probe fails and the run degrades to a note — noisy, but not broken.
- **Availability probes cost one trivial process launch per mechanism per host process**, cached for the
  lifetime of that process.
- **A degraded platform adds a note to every run.** On Linux every result carries the
  filesystem-confinement note and on Windows the filesystem-and-network one. That is deliberate: the
  alternative is a sandbox that looks stronger than it is. It does mean a caller comparing the sandbox's
  tree against another engine's must subtract `ScenarioChildRun.SandboxNotes` — which is why that list is
  reported separately rather than left to be recognised by its wording.
- **The trust model still governs.** This is defence in depth, not a containment boundary against a
  hostile actor: reads are open everywhere, Windows has no filesystem or network confinement, and a
  degraded platform has none at all. Executing a model authored by someone other than the operator — a
  hosted playground, a CI bot running a PR's model — still needs its own review before it ships.
