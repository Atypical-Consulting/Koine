# Changelog

All notable changes to Koine are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Koine is pre-1.0, so minor versions
may include breaking changes.

## [0.245.0](https://github.com/Atypical-Consulting/Koine/compare/v0.244.0...v0.245.0) (2026-07-02)


### ⚠ BREAKING CHANGES

* **emit:** extract each emitter into its own Koine.Emit.<Target> project ([#861](https://github.com/Atypical-Consulting/Koine/issues/861)) (#968)

### Features

* demand-generate value-object / scalar division in TS, Python, and Rust emitters ([#879](https://github.com/Atypical-Consulting/Koine/issues/879)) ([#933](https://github.com/Atypical-Consulting/Koine/issues/933)) ([5d09c3a](https://github.com/Atypical-Consulting/Koine/commit/5d09c3a744257c5aaec74cb4187e01f8e86f8d7a))
* **design-sync:** ship Koine Studio panels as live components via a Preact→React adapter ([#913](https://github.com/Atypical-Consulting/Koine/issues/913)) ([3dabd10](https://github.com/Atypical-Consulting/Koine/commit/3dabd1083c3676ca9423a09a7343d797cdb9f9dc))
* **emit:** extract each emitter into its own Koine.Emit.&lt;Target&gt; project ([#861](https://github.com/Atypical-Consulting/Koine/issues/861)) ([#968](https://github.com/Atypical-Consulting/Koine/issues/968)) ([9169d5e](https://github.com/Atypical-Consulting/Koine/commit/9169d5ed98b253e25b8ff40d16e24c07305e02ef))
* **studio:** add an Initialize Repository button to the Source Control panel ([#911](https://github.com/Atypical-Consulting/Koine/issues/911)) ([05af580](https://github.com/Atypical-Consulting/Koine/commit/05af58035a86b39cbfd499bbd4fe4dc9a4dd5cec))
* **studio:** adopt Concept Colors — one DDD concept, one color everywhere ([#936](https://github.com/Atypical-Consulting/Koine/issues/936)) ([#941](https://github.com/Atypical-Consulting/Koine/issues/941)) ([dfe7a94](https://github.com/Atypical-Consulting/Koine/commit/dfe7a943532deeb024d270d80d3a774d87fd4288))
* **studio:** default desktop workspace root to Documents/Koine ([#915](https://github.com/Atypical-Consulting/Koine/issues/915)) ([#949](https://github.com/Atypical-Consulting/Koine/issues/949)) ([78633da](https://github.com/Atypical-Consulting/Koine/commit/78633dafa62bc1beaf87ea4d532423f03a7c5d77))
* **studio:** extract Studio's reusable UI into @atypical/koine-ui ([#905](https://github.com/Atypical-Consulting/Koine/issues/905)) ([#932](https://github.com/Atypical-Consulting/Koine/issues/932)) ([7011c55](https://github.com/Atypical-Consulting/Koine/commit/7011c55531484a736c344b28d11b2de5f0507ce1))
* **studio:** redesign the top bar & status bar chrome (chrome v2) ([#923](https://github.com/Atypical-Consulting/Koine/issues/923)) ([#924](https://github.com/Atypical-Consulting/Koine/issues/924)) ([8f338a3](https://github.com/Atypical-Consulting/Koine/commit/8f338a3315c954697214cce8fd1e94137e0eac15))
* **studio:** ship-ready desktop MCP exposure and expandable tool-call cards ([#934](https://github.com/Atypical-Consulting/Koine/issues/934)) ([#935](https://github.com/Atypical-Consulting/Koine/issues/935)) ([8fd3cef](https://github.com/Atypical-Consulting/Koine/commit/8fd3cefad47bd81cca08048e6ae068272720ad84))


### Bug Fixes

* **design-sync:** drop orphan .d.ts and classify structural tokens ([#920](https://github.com/Atypical-Consulting/Koine/issues/920)) ([bb805e4](https://github.com/Atypical-Consulting/Koine/commit/bb805e46567943a42a834c177d649e54d0da5924))
* **emit-php:** parenthesise (new Decimal('n'))-&gt;… for a Decimal-literal receiver in WriteAsDecimal ([#907](https://github.com/Atypical-Consulting/Koine/issues/907)) ([#963](https://github.com/Atypical-Consulting/Koine/issues/963)) ([cdc2553](https://github.com/Atypical-Consulting/Koine/commit/cdc255312d76fa4d4dc1f586ab005a2d92840ad6))
* **emit-php:** parenthesise WriteAsDecimal fallthrough arm's new-chaining for Int members ([#849](https://github.com/Atypical-Consulting/Koine/issues/849)) ([#903](https://github.com/Atypical-Consulting/Koine/issues/903)) ([05579dd](https://github.com/Atypical-Consulting/Koine/commit/05579ddb91a5443ee6c77460c105b7874c5bad69))
* **emit-rust:** coerce a derived member's body to its declared numeric type ([#961](https://github.com/Atypical-Consulting/Koine/issues/961)) ([#967](https://github.com/Atypical-Consulting/Koine/issues/967)) ([fc83bcf](https://github.com/Atypical-Consulting/Koine/commit/fc83bcf5feb4f319cf807c43b87d3ce9ca1c7fca))
* **emit-rust:** map over Option for optional numeric fields scaled/divided by a scalar ([#960](https://github.com/Atypical-Consulting/Koine/issues/960)) ([#964](https://github.com/Atypical-Consulting/Koine/issues/964)) ([3cf4425](https://github.com/Atypical-Consulting/Koine/commit/3cf4425ebaee8e14c2cc92ea860749d565662b47))
* **emit-rust:** scale & divide an Int field by a Decimal scalar via coerce-and-truncate ([#937](https://github.com/Atypical-Consulting/Koine/issues/937)) ([#952](https://github.com/Atypical-Consulting/Koine/issues/952)) ([9a1ae00](https://github.com/Atypical-Consulting/Koine/commit/9a1ae00c0df2a6e84423503b5e417ecd0071d8ad))
* **scripts:** preserve caller's working directory in ps1 scripts ([#912](https://github.com/Atypical-Consulting/Koine/issues/912)) ([cabb776](https://github.com/Atypical-Consulting/Koine/commit/cabb77628b77eab91f28d2ce4dd13c3bb865e3ea))
* **semantics:** reject reversed scalar / value-object division ([#878](https://github.com/Atypical-Consulting/Koine/issues/878)) ([#906](https://github.com/Atypical-Consulting/Koine/issues/906)) ([2565bec](https://github.com/Atypical-Consulting/Koine/commit/2565becf05bce00fedda1200175b197e91f06556))
* **semantics:** reject scalar arithmetic on a value object with no numeric field ([#939](https://github.com/Atypical-Consulting/Koine/issues/939)) ([#951](https://github.com/Atypical-Consulting/Koine/issues/951)) ([11d2feb](https://github.com/Atypical-Consulting/Koine/commit/11d2feb63fe49456ec6cea6f97c5b2f85b3d4266))
* **studio:** gate cold-boot start-intent on lsp.start() to fix "LSP not started" ([#955](https://github.com/Atypical-Consulting/Koine/issues/955)) ([d3a6044](https://github.com/Atypical-Consulting/Koine/commit/d3a604418c73ddc5554ad3d4ca1b7ae5878a43e4))
* **studio:** intermittent Windows CI failure in inspectorController.test.ts ([#848](https://github.com/Atypical-Consulting/Koine/issues/848)) ([#904](https://github.com/Atypical-Consulting/Koine/issues/904)) ([bbf54b5](https://github.com/Atypical-Consulting/Koine/commit/bbf54b5b86cb214bbb0004a309e636df2388fd24))
* **studio:** key mcp_endpoint cache on the requested port ([#947](https://github.com/Atypical-Consulting/Koine/issues/947)) ([#953](https://github.com/Atypical-Consulting/Koine/issues/953)) ([847fcf1](https://github.com/Atypical-Consulting/Koine/commit/847fcf10d9ecbc65f5a363429e7eea742b11c175))
* **studio:** paint Concept Colors & semantic tokens over the grammar highlighter ([#962](https://github.com/Atypical-Consulting/Koine/issues/962)) ([bd01db0](https://github.com/Atypical-Consulting/Koine/commit/bd01db0c9b9d404c155888e51d7052fd685f973b))
* **studio:** reject the zero-byte placeholder when resolving the bundled koine sidecar ([#969](https://github.com/Atypical-Consulting/Koine/issues/969)) ([225bf74](https://github.com/Atypical-Consulting/Koine/commit/225bf74f21e52af208ba9892f6235e395a142e23))
* **studio:** repair 30 verified bugs across shell, hosts, editor, AI, and panels ([#930](https://github.com/Atypical-Consulting/Koine/issues/930)) ([badb772](https://github.com/Atypical-Consulting/Koine/commit/badb772b622575d9e3f241fbb3fc625b5c47f17b))
* **studio:** sync desktop/package version with the Koine release version ([#957](https://github.com/Atypical-Consulting/Koine/issues/957)) ([3faf88e](https://github.com/Atypical-Consulting/Koine/commit/3faf88e10e9d257005c06893251b98d5e6af2029))
* **website:** serve /blog/rss.xml under trailingSlash:always to unblock the docs deploy ([#948](https://github.com/Atypical-Consulting/Koine/issues/948)) ([#954](https://github.com/Atypical-Consulting/Koine/issues/954)) ([6c94b1a](https://github.com/Atypical-Consulting/Koine/commit/6c94b1a0513620cb041874bc06248be2e5157d4a))

## [0.244.0](https://github.com/Atypical-Consulting/Koine/compare/v0.243.0...v0.244.0) (2026-07-01)


### Features

* **gbnf:** require whitespace at word-to-word boundaries + character-level engine test ([#448](https://github.com/Atypical-Consulting/Koine/issues/448)) ([#896](https://github.com/Atypical-Consulting/Koine/issues/896)) ([27f8309](https://github.com/Atypical-Consulting/Koine/commit/27f83091a39ac4a63caaafe3cb6f3cce0603151b))
* **wasm:** warm remaining interop handlers (EmitPreview, Completions, WorkspaceSymbols, CodeActions, EmitKoine, ApplyModelEdit) ([#464](https://github.com/Atypical-Consulting/Koine/issues/464)) ([#895](https://github.com/Atypical-Consulting/Koine/issues/895)) ([4c732ff](https://github.com/Atypical-Consulting/Koine/commit/4c732ff76ab31feb61ed80733ba6d8b089ea2a7f))
* **wasm:** warm remaining interop handlers (EmitPreview, Completions, WorkspaceSymbols, CodeActions, EmitKoine, ApplyModelEdit) ([#464](https://github.com/Atypical-Consulting/Koine/issues/464)) ([#895](https://github.com/Atypical-Consulting/Koine/issues/895)) ([e3cc6de](https://github.com/Atypical-Consulting/Koine/commit/e3cc6dec877f46aca996a935cb5b0295e193ec82))

## [Unreleased]

### Added
- **Koine Studio — Initialize Repository button in the Source Control panel.** The Source Control
  panel's not-a-repo empty state no longer tells the Domain Developer to run `git init` themselves —
  it now offers an **Initialize Repository** button that shells `git init` on the open workspace folder
  and, on success, transitions the panel straight into the freshly-initialized (clean) repo, with no
  extra wiring beyond the panel's existing post-mutation reload. Desktop-only, following the same
  `canUseGit`-gated pattern as every other git verb (issue #859; completes the Source Control panel
  from #272).
- **Koine Studio — workspace settings.json now uses the same grouped key shape as user settings.json.**
  The workspace scope of the Settings JSON editor (User / Workspace scope toggle introduced in #736) now
  uses the same `group.docKey` key shape as the user scope: `preview.target`, `editor.formatOnSave`,
  `editor.wordWrap`, and `lsp.trace` instead of the previous flat runtime keys (`previewTarget`, etc.).
  This means a field can be copy-pasted between the User and Workspace editors without any key-shape
  change — the cross-scope consistency wart flagged by a reviewer on #781 is resolved. The internal
  `koine.studio.wsOverrides.*` localStorage blobs keep their flat runtime-key format and are unaffected;
  the `jsonDocToWorkspaceOverrides` parser accepts both the new grouped format and the old flat format, so
  existing saved workspace-override documents continue to load without data loss. (issue #792;
  follow-up to #736 and #750)
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
- **C# emitter: direct same-type `value + value` / `value - value` validated but emitted CS0019.** A plain
  (non-`quantity`) value object combined with another of its own type *directly* — `total: Money = fee + fee`
  or `diff: Money = fee - fee`, written outside a `sum` fold — passed validation but emitted C# that called
  operators the emitter never generated (two CS0019s): `operator +` was demand-generated only by a `sum`
  fold, and `operator -` was never generated for plain value objects at all. The C# emitter now records the
  direct-binary additive/subtractive need (reusing the existing `BuildValueObjectArithmeticNeeds` analysis,
  the same map the PHP emitter consumes) and demand-generates `operator +`/`operator -` for plain value
  objects, mirroring scalar `*`/`/` (#832) and the `sum`-fold `+`. Both route through the validating
  constructor, so e.g. a negative difference still throws the declared `invariant` at construction. The fix
  is C#-emitter-only; no grammar, parser, or `Ast/` change, and no change to other targets (issue #833).
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
