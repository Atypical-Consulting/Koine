# Contributing to Koine

Thanks for your interest in Koine! This document explains how to build the project, the conventions we
follow, and how to get a change merged. By contributing you agree that your contributions are licensed
under the project's [Apache-2.0 License](LICENSE).

## Ground rules

- Be respectful — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Open an issue before starting non-trivial work so we can align on the approach.
- Keep the pipeline layering intact (see below) — it's the invariant that keeps Koine multi-target.

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/)
- For the docs site / playground: Node.js 20+ (only if you touch `website/`)

## Build & test

The solution is the modern `Koine.slnx`.

```bash
./scripts/build/build.sh   # build + test (build.ps1 / build.cmd are equivalents)
dotnet build      # build only
dotnet test       # run the full suite (~670 tests)

# Run a single test class
dotnet test --filter "FullyQualifiedName~R9ValueObjectTests"

# Try the CLI
dotnet run --project src/Koine.Cli -- build examples/billing.koi --target csharp --out ./generated
```

A **green build proves the domain**: the emitted C# is snapshot-tested *and* compiled/executed in-memory
with Roslyn, so a passing `dotnet test` means the generated code is correct and usable.

## Architecture: keep the pipeline layered

```
.koi source
  → ANTLR lexer/parser (Grammar/*.g4)
  → KoineModelBuilderVisitor (Parsing/) → semantic model (Ast/, target-agnostic)
  → SemanticValidator (Semantics/) → diagnostics with line/column
  → IEmitter (Emit/CSharp, Emit/TypeScript, …) → source files
```

**No target-specific (C#, TypeScript, …) concept may leak into `Ast/`.** That boundary is what lets Koine
add emitters without touching the parser or semantic model. When adding a language feature, touch the
layers in order: grammar (`.g4`) → builder visitor (`Parsing/`) → semantic model (`Ast/`) → validators
(`Semantics/`) → emitter(s) → tests.

> Don't hand-edit generated parser code under `Grammar/gen/` — edit the `.g4` files; ANTLR regenerates
> them at build time.

## Tests & snapshots

- Tests live in `tests/Koine.Compiler.Tests/`, named per release (`R1…Tests.cs` … `R17…Tests.cs`) plus
  focused suites. New features need a new `R##…Tests.cs` with **snapshot + Roslyn-compile coverage**.
- Snapshots are [Verify](https://github.com/VerifyTests/Verify) `.verified.txt` files. When you change
  emitter output, review the `.received.txt` diff — *that diff is the review of the generated code* — and
  accept it deliberately. Don't blindly overwrite.
- This project's tests use plain **xUnit asserts** (not Shouldly) — match the surrounding file.

## Commit & PR conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `chore:`, `refactor:`, `test:`, optionally scoped (`feat(r16): …`).
- One logical change per PR. Update `README.md` and the `website/` reference docs when a construct's
  emitted shape changes.
- Make sure `dotnet test` is green before opening the PR.
- Fill in the PR template and link the issue it closes.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/Atypical-Consulting/Koine/issues/new/choose). For bugs,
a minimal `.koi` snippet that reproduces the problem is the single most helpful thing you can include.
