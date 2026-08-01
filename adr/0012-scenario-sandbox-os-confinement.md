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
  network confinement; Linux gets filesystem confinement on any kernel ≥ 5.13 (see the amendment below —
  originally this read "network only") and network confinement only where unprivileged user namespaces are
  permitted; Windows gets neither, because a restricted or low-integrity token requires
  `CreateProcessAsUser` and hand-plumbing all three redirected pipes. Each gap is a note on the run.
- **Linux's network denial is conditional, and often unavailable.** An unprivileged network namespace
  needs unprivileged user namespaces to be permitted, and several distributions restrict them — Ubuntu
  24.04's AppArmor policy blocks them by default, which is why this repo's own `ubuntu-latest` CI runner
  probes as unable and degrades to a note. So in practice a large share of Linux hosts get the resource
  ceilings and nothing else. The probe is what keeps that honest rather than fatal. **The amendment below
  records three mechanisms measured to work on exactly those hosts**; the note now names the AppArmor
  restriction as the likely reason rather than describing the symptom generically.
- **Exit codes are not a portable diagnosis.** `ulimit -t` sets the soft *and* hard `RLIMIT_CPU`, so a
  child that blows the ceiling may be observed as signalled (`SIGXCPU`, 152) or killed outright
  (`SIGKILL`, 137) depending on the shell and kernel — macOS reports the former, Linux the latter. Both
  are read as the same event, which means a genuine external kill or an out-of-memory kill of a child
  that produced no output is attributed to the CPU ceiling too; the note says so rather than overstating.
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
- **A degraded platform adds a note to every run.** Before the amendment below, every Linux result carried
  the filesystem-confinement note; on Windows every result still carries the filesystem-and-network one,
  and on a Linux host that cannot create an unprivileged network namespace the network note. That is
  deliberate: the
  alternative is a sandbox that looks stronger than it is. It does mean a caller comparing the sandbox's
  tree against another engine's must subtract `ScenarioChildRun.SandboxNotes` — which is why that list is
  reported separately rather than left to be recognised by its wording.
- **The trust model still governs.** This is defence in depth, not a containment boundary against a
  hostile actor: reads are open everywhere, Windows has no filesystem or network confinement, and a
  degraded platform has none at all. Executing a model authored by someone other than the operator — a
  hosted playground, a CI bot running a PR's model — still needs its own review before it ships.

## Amendment — Linux write confinement, and what an AppArmor-restricted host can still do (issue #1781)

*Added 2026-08-01. The **decision** above is unchanged — confinement still uses each platform's native
mechanism, applied by making the child BE the confining launcher, still probed, still degrading to a note.
What changes is one recorded trade-off: "Linux gets network only" was true of the mechanisms considered,
not of the platform.*

**What was wrong, and why.** The original reasoning was that `landlock_restrict_self(2)` must be called by
the process being confined, between fork and exec, and .NET offers no hook there. That is correct — but it
overlooked that this ADR's own chosen shape *is* the hook: a launcher that installs a ruleset on itself and
then `execve`s the real command needs no pre-exec callback, because the process boundary is one this repo
already owns. Landlock is inherited across `execve` and can never be relaxed, so what the command inherits
is a process that may read anywhere and write only beneath its run directory. `koine sandbox-landlock`
(hidden, exactly as `scenario-exec` is) is that launcher.

**The survey.** Measured on `ubuntu-latest` — Ubuntu 24.04.4 LTS, kernel 6.17.0-1020-azure, unprivileged
(`CapEff: 0`), `kernel.apparmor_restrict_unprivileged_userns=1` — by a temporary workflow on the
implementing PR, rather than reasoned about:

| Mechanism | Unprivileged on Ubuntu 24.04 | Kernel floor | Evidence |
|---|---|---|---|
| `unshare --user --map-root-user --net` *(what shipped)* | ❌ | — | `write failed /proc/self/uid_map: Operation not permitted` |
| `unshare --net`, no `--user` | ❌ | — | `unshare failed: Operation not permitted` (wants `CAP_SYS_ADMIN`) |
| **`unshare --user --net`, no uid map** | ✅ **denies TCP** | 4.x | exit 0; probe `network=denied`, control `network=allowed` |
| `bubblewrap` | ❌ | — | not installed by default; once installed, `setting up uid map: Permission denied` |
| **Landlock filesystem (ABI v1)** | ✅ | 5.13 | kernel reports **ABI 7**; writes confined; a .NET app starts fine under it |
| **Landlock network, `CONNECT_TCP` (ABI v4)** | ✅ **denies TCP** | 6.7 | probe `network=denied`, control `network=allowed` |
| **seccomp-bpf denying `socket(2)`** | ✅ **denies TCP** | any | needs only `PR_SET_NO_NEW_PRIVS` |

**Consequences of the amendment.**

- **Linux now gets write confinement, and it is the *unconditional* half.** Landlock needs no privileges
  and no user namespace, so it works on precisely the AppArmor-restricted hosts where the network namespace
  does not — including this repo's own CI runner, where these tests now execute the enforcement for real
  rather than skipping.
- **The answer to "does a permitted network mechanism exist on those hosts" is yes — three of them.**
  Dropping `--map-root-user` is the cheapest and is measured to work; Landlock's own ABI-4 network bits
  would let one mechanism serve both halves on kernels ≥ 6.7; seccomp-bpf works everywhere. Recording the
  answer was this issue's deliverable; **choosing and implementing one is deliberately left to a follow-up**,
  because dropping the uid map leaves the child mapped to `nobody` inside the namespace and whether it can
  still write its own run directory has to be proven, not assumed.
- **`bubblewrap` is rejected as a fallback, on evidence.** It is absent from `ubuntu-latest` and, once
  installed, fails there for the same reason `unshare --map-root-user` does. It covers no host Landlock
  does not, so a second mechanism would be maintenance for nothing.
- **The character-device allowance is mandatory, not cosmetic.** A first survey iteration without rules for
  `/dev/null` and friends made a plain `2>/dev/null` in the confined child fail with `Permission denied`.
  The ruleset grants read+write on those the way the macOS profile does.
- **`LANDLOCK_ACCESS_FS_IOCTL_DEV` (ABI v5) is deliberately left unhandled**, so device `ioctl`s stay
  unrestricted — the same allowance the macOS profile makes explicitly. `REFER` (v2) and `TRUNCATE` (v3)
  *are* handled where the ABI has them: without `REFER` the kernel denies every cross-directory rename,
  including legitimate ones inside the run directory.
- **The probe budget did not move.** Availability is decided by asking the kernel its Landlock ABI — a
  version query that builds nothing and costs microseconds — plus a check that the launcher verb resolves
  to a file. No child is spawned, so `ScenarioSandbox.MaxProbeCost` is unchanged.
- **The launcher fails loud.** If the ruleset cannot be installed it exits non-zero *without* running the
  command. Silently running unconfined would be worse than no sandbox: the result tree would carry no note,
  so the caller would be told the code was confined when it was not.
- **`TMPDIR`/`TMP`/`TEMP` now point at the run directory whenever writes are confined.** The host's scrub
  keeps the ambient temp directory, which is the run directory's *parent* — so a runtime wanting a temp
  path would write exactly where the confinement says no, and fail for a reason unrelated to the model.
- **The command override is not consulted for the launcher.** `KOINE_SCENARIO_EXEC_COMMAND` names a program
  to run the *scenario* with (in the tests, a shell stub), and a stub knows nothing about
  `sandbox-landlock`. An embedder reachable only through that override gets an honest degradation note
  instead of a wrapper pointed at a program that cannot honour it.

## Amendment — macOS and Windows join CI; the Job Object interop executes for the first time (issue #1782)

*Added 2026-08-01. The **decision** above is unchanged. What changes is the Consequences bullet "CI covers
one of the three platforms" — a targeted `sandbox-confinement` job (`.github/workflows/ci.yml`, matrix
`[macos-latest, windows-latest]`, filtered to `ScenarioSandboxTests`, additive alongside `build-and-test`)
now runs on every .NET-touching push/PR, so the macOS `sandbox-exec` path and the Windows Job Object path
are CI-verified, not just manually verified once.*

**What CI now executes, per platform.**

- **Linux (`build-and-test`, unchanged):** the whole suite, unfiltered — Landlock write confinement, the
  `unshare --user --net` network denial, and everything platform-agnostic.
- **macOS (new):** 11 of 16 `ScenarioSandboxTests` execute for real (only the 4 Linux-only Landlock tests
  and the Windows Job Object floor test skip) — `sandbox-exec` filesystem *and* network confinement,
  exercised through `RequireFilesystemConfinement`/`RequireNetworkConfinement`'s fail-don't-skip rule, so a
  regression here reddens CI rather than reading as a platform fact.
- **Windows (new, and the headline result):** skip count dropped from 10/16 (measured on an early,
  ungated scratch job) to 6/16. `WindowsJobObject.TryCreate`/`TryAssign` — the 194 lines of `kernel32`
  P/Invoke over three hand-mirrored ABI structs this ADR's Consequences called "not CI-verified" — **have
  now executed against a real Windows kernel and passed**, with no struct-layout or `LimitFlags` defect
  found. The CPU-ceiling behavioural test (a spinning child stopped by the Job Object's time limit,
  reported via `ScenarioConfinement.DescribeExit`'s `STATUS_QUOTA_EXCEEDED`/`ERROR_NOT_ENOUGH_QUOTA`
  branch as a cap breach, not a timeout) now runs for real too, via a Windows `.cmd` form of the stub
  children (`WriteStub`, invoked through `cmd.exe /q /c <stub>` — `CreateProcess` cannot launch a `.cmd`
  directly under the `UseShellExecute=false` the sandbox always uses, and `/q` suppresses cmd.exe's
  default command echo, which otherwise corrupts the child's JSON answer on stdout).
- **What remains manually verified, not CI-verified:** Windows filesystem and network confinement — this
  ADR's `WindowsJobObject` covers only the resource ceilings (memory, processor time); tracked separately
  as issue #1780. `A_confined_child_cannot_open_a_network_connection` stays POSIX-only (needs bash's
  `/dev/tcp`), the one test `RequireUnixStubs()` still gates.

**One real (pre-existing) defect this surfaced, not fixed here.**
`A_run_that_exhausts_the_memory_ceiling_names_it_instead_of_reporting_a_generic_fault` — a test that
predates this ADR — fails intermittently on the Windows leg (3 of 4 observed CI runs): a race between
`DOTNET_GCHeapHardLimit` (the CLR heap ceiling) and `WindowsJobObject`'s own `JobMemoryLimit` (both sized
identically), where only the former is currently recognised by `ScenarioSandbox.ResourceCeilingNote`.
Unrelated to the Job Object interop itself (which this amendment's new floor test proves sound) — tracked
as issue #1791.
