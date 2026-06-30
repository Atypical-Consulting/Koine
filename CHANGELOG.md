# Changelog

All notable changes to Koine are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Koine is pre-1.0, so minor versions
may include breaking changes.

## [Unreleased]

### Added
- **Koine Studio — "On startup" setting (Home vs Last workspace).** A new **Settings → Appearance → On
  startup** dropdown lets power users opt into reopening the last workspace automatically on a cold
  Studio boot, reversing the always-Home default introduced by #766 without affecting it for everyone
  else. The default remains `Home screen` (no change in behaviour for users who don't touch the
  setting). Choosing `Last workspace` auto-resumes the editor when a prior workspace exists; a pristine
  first-load (no prior workspace) still lands on Home so the user is never stranded on a blank editor.
  Explicit `#/editor` deep-links and `#model=…` share links continue to win regardless of the setting.
  The boot resolver (`resolveInitialRoute`) stays pure / IO-free — the setting and the persisted-
  workspace flag are passed in by `main.ts` at the only IO boundary, preserving the no-flash contract
  from #368. The `startupView: 'home' | 'lastWorkspace'` field is persisted in Settings and exposed in
  the Settings JSON editor for advanced users. (issue #770; follow-up to #766 / #768)

### Changed
- **Koine Studio Web now always opens on Home.** Opening Studio (a cold load at the base URL / `#/`) lands
  on the Home start console every time instead of auto-skipping a returning user straight into the editor —
  the persisted "workspace was opened" flag is no longer a routing input (issue #766). The returning-user
  fast path is preserved as a one-click **Resume** control on a cold-open Home, so getting back to the last
  workspace is now a deliberate choice rather than an automatic jump. Explicit `#/editor` deep-links (and
  same-tab editor refreshes) and `#model=…` share links still open the editor, and #368's no-flash,
  single-view boot is unchanged.

### Fixed
- **Live Playground compiler failed to boot ("Koine worker timed out after 30s").** The marketing-site
  Playground's in-browser compiler hung at boot: its wasm Web Worker installed the message loop with a
  top-level `self.onmessage = …`, which clobbers the `message` channel the .NET WebAssembly runtime
  installs while `dotnet.create()` boots inside a Worker, so the boot never settled (no `ready`, no
  `boot-failure`) and the host waited out its 30s timer (issue #492). This is the exact #357/#358 Studio
  hang, re-introduced on the un-ported website copy. Ported the proven Studio fix: the worker now
  installs its RPC loop via `self.addEventListener('message', …)` **after** `dotnet.create()` resolves,
  never as a top-level `self.onmessage =`. Added a headless-Chromium boot smoke test
  (`website/scripts/smoke-boot.mjs`) that boots the real deploy bundle and asserts the compiler reaches
  `ready` and round-trips a compile — wired into the docs deploy as a gate so a non-booting worker can
  never ship silently again.

### Added
- **Koine Studio — Settings JSON `User | Workspace` scope toggle.** The Settings JSON view now has a
  VS Code-style **User | Workspace** segmented toggle above the editor, so the four workspace-scopable
  fields (`previewTarget`, `formatOnSave`, `wordWrap`, `lspTrace`) can be hand-edited per workspace in a
  flat `settings.json` overlay without touching the global user settings. The `Workspace` pill is
  disabled with an empty-state note ("Open a folder to edit workspace settings") when no workspace is
  open; switching scope re-seeds the editor with the appropriate document; valid edits are persisted to a
  per-workspace `wsOverrides` blob and live-applied via `effectiveSettings`; removing a key from the
  workspace doc reverts that field to the user value (issue #736).
- **Koine Studio — Settings JSON reorganized into VS Code-style namespaced groups (+ new options).** The
  editable `settings.json` document is now grouped under `appearance` / `editor` / `ai` / `mcp` / `preview` /
  `lsp` / `account` namespaces instead of a flat bag of keys, so hand-edits are easy to scan and a new setting
  has an obvious home (issue #750). A single declarative field map (`runtimeKey → group.docKey`) is the source
  of truth driving the serializer, the nested JSON Schema (with per-field `title`/`description` metadata), the
  parser, and a three-way parity test in lockstep. The runtime `Settings` type stays **flat**, so there is no
  localStorage migration and no churn to existing read sites — only the document the user edits is grouped — and
  an old/hand-saved **flat** document still parses through a legacy fallback. The encrypted AI API key remains
  absent from the schema and document (re-injected on save). Ships three new, fully-wired options: **`editor.tabSize`**
  (indent width 1–8, applied as the editor's indent unit / tab width), **`appearance.fontFamily`** (an editor
  font-stack override; blank uses the theme default), and **`ai.temperature`** (0–2 sampling temperature sent on
  every assistant request) — each with a runtime coercer, a real consumer, and a Visual-pane control.
- **Koine Studio — Settings is now a gear-launched center page (Visual/JSON).** The toolbar gear opens
  Settings as a transient center view (a peer of Visual/Code/Documentation) rather than a modal, with a
  **Visual/JSON** segmented toggle in the page header. The Visual side is the same two-pane preference form
  as before; the new **JSON** side is a schema-validated, editable `settings.json` whose valid edits
  live-apply through the very same `onChange` hook the Visual controls commit through (an invalid document
  surfaces a diagnostics strip and is never saved). The encrypted AI API key stays encrypted and never
  appears in the JSON — it is stripped from the serialized document and re-injected on save.
- **Playground — graceful boot degradation (watchdog + main-thread fallback).** The marketing-site
  Playground now survives a worker boot that goes wrong for any reason (a future runtime regression, an
  exotic browser, a corrupted cached bundle), not just the #492 channel-clobber. The wasm worker carries
  a **boot watchdog**: if `dotnet.create()` neither resolves nor rejects within ~20s it posts an explicit
  `boot-failure`, so the host fails fast with a named diagnostic instead of silently waiting out its 30s
  timer. And the host now has a **guarded main-thread fallback** — when the worker never reaches `ready`,
  the compiler boots on the UI thread instead so the Playground still works (a large compile may briefly
  freeze the page) rather than bricking. The worker stays the fast path; the fallback fires only as the
  safety net, mirroring Koine Studio's shipped #357/#358 resilience (issue #510).
- **Koine Studio — Source Control (git) panel.** A new right-rail **Source Control** view brings git into
  the IDE for `.koi` models kept under version control (issue #272): the current branch with a switcher,
  changed files grouped into **Staged** / **Changes** / **Untracked** with per-row stage/unstage and an
  inline diff, a commit box, and the recent-commit log. Git is a host capability behind a new `canUseGit`
  flag on `Platform` — the desktop (Tauri) host shells `git` in the opened folder via new `git_*` sidecar
  commands (`git_status`/`git_diff`/`git_stage`/`git_unstage`/`git_commit`/`git_branches`/`git_checkout`/
  `git_log`), while the browser host (no shell) degrades gracefully to a "desktop only" empty state, and a
  non-repo folder shows a "not a git repository" empty state. This is the umbrella git plumbing the
  per-element inspector history (#150) reuses.
- **TypeScript & Python infrastructure layer (`--layers infrastructure`).** The opt-in
  `--layers infrastructure` selector — previously C#-only (EF Core) — now also applies to the
  **TypeScript** and **Python** targets (issue #241), closing the largest cross-emitter parity gap.
  Per bounded context with an entity-rooted aggregate, each emits a **dependency-light**, runnable
  realization of the domain contracts: a concrete repository over an injectable `AggregateStore` with a
  zero-dependency **in-memory default** (declarative finders → concrete lookups), a concrete unit of
  work, a transactional **outbox** + dispatcher (publishing contexts only), validation/transaction
  **pipeline behaviors**, and a composition-root factory (TS) / provider helper (Python). Shared
  primitives live once in an emitted `infrastructure-runtime.ts` / `koine_infrastructure.py`. Off by
  default — an unconfigured emit is byte-identical; the output is `tsc --strict` / `mypy --strict`-clean.
- **Koine Studio — aggregate-scoped palette constructs (Repository & Rule).** The visual editor's
  structured-edit seam now targets a *selected aggregate* (not only a context): a new
  `addAggregateMember` edit inserts a re-validating `aggregateMember` and re-emits the whole aggregate.
  The two muted palette buttons are activated, gated on an aggregate being selected — **Repository**
  inserts `repository { operations: add, getById }`, and **Rule** maps to an aggregate-scoped
  `spec <Name> on <Root> = true` (a named, reusable boolean rule over the root; no new grammar). A
  second repository on the same aggregate is refused; a duplicate rule name is rejected by re-validation.
- **MCP server (`koine-mcp`).** A Model Context Protocol server (`src/Koine.Mcp`) that lets an AI agent
  author a complete domain in `.koi` over stdio: `koine_validate`, `koine_compile`
  (csharp/typescript/glossary/docs), and `koine_format` tools, plus `koine_reference` and
  `koine_examples` (also exposed as `koine://` resources) so the agent learns the language. Reuses the
  same parser, validator, and emitters as `koine build`. Packaged as a `dotnet tool`.
- Documentation emitter (`--target docs`): emits Markdown with Mermaid diagrams (context maps as
  flowcharts, state machines as state diagrams, integration-event flows) — _in progress_.

## [0.17.x] — Tooling & multi-target

### Added
- **R16 — Multi-target emitters & emitter configuration.** TypeScript emitter (`--target typescript`)
  behind the same target-agnostic `IEmitter` seam as C#, plus per-target output configuration via
  `koine.config`. Generated C# is grouped into DDD "kind" subfolders.
- **R17 — Editor tooling & developer experience.** TextMate grammar for `.koi` (Rider + VS Code),
  a `koine lsp` language server (live diagnostics, completion, hover, go-to-definition across files),
  AST-scoped rename / extract-value-object refactorings, and the `fmt` / `init` / `watch` CLI commands.
- Build-time ubiquitous-language **glossary** emission (`--target glossary`).

## [0.1.0 – 0.16.x] — Core language (R1–R15)

The full tactical *and* strategic DDD toolkit on the C# emitter, delivered as releases R1–R15:

- **Tactical building blocks** — value objects, entities (`identified by`, identity strategies),
  aggregates, smart enums, derived/default fields, invariants (incl. regex `matches` and `when` guards),
  the pure expression sublanguage, factories, specifications, domain services, and policies.
- **Persistence & application layer** — repositories, optimistic concurrency (`versioned`), the
  application layer (Unit of Work, read models, CQRS queries/handlers).
- **Strategic design** — multi-file compilation, imports & modules, context maps, integration events,
  and model versioning / evolution checks.
- Self-contained `Koine.Runtime` markers emitted alongside the generated code (no external dependency).
- Snapshot (Verify) + in-memory Roslyn compile/execute meta-tests throughout.

[Unreleased]: https://github.com/Atypical-Consulting/Koine/commits/main
