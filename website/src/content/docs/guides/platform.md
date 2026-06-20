---
title: "Koine as a platform"
description: "Embed the compiler from NuGet, write analyzers, and ship your own emitters against a frozen public API."
---

`Koine.Compiler` ships as a NuGet library with a **frozen, contract-gated public API**. The contract
is guarded by `Microsoft.CodeAnalysis.PublicApiAnalyzers`, so the public surface can only change
deliberately (a new public member that is not declared in the API baseline fails the build). That
makes the compiler safe to depend on: you can embed it, extend it with analyzers, and add emitters
without forking.

## Embed the compiler

Reference the package and compile a model in process:

```bash
dotnet add package Koine.Compiler
```

```csharp
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

var registry = new EmitterRegistry();                       // built-in providers (csharp, typescript, …)
registry.TryCreate("csharp", EmitterOptions.Empty, out var emitter);

var result = new KoineCompiler().Compile(source, emitter);  // string source or IReadOnlyList<SourceFile>
if (result.Success)
    foreach (EmittedFile file in result.Files)
        Console.WriteLine($"{file.RelativePath}\n{file.Contents}");
else
    foreach (var d in result.Diagnostics)
        Console.Error.WriteLine(d);
```

`CompileResult` carries the resolved `Model`, all `Diagnostics` (with source spans), and the emitted
`Files`; `Success` is `false` when any diagnostic is an error.

## Write an analyzer

An analyzer is a **target-agnostic** check over the resolved semantic model. Implement
`IModelAnalyzer` and report `Diagnostic`s through the `AnalyzerContext`:

```csharp
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;

public sealed class NoLowercaseTypeNames : IModelAnalyzer
{
    public string Id => "acme.no-lowercase-type-names";

    public void Analyze(AnalyzerContext context)
    {
        foreach (var ctx in context.Model.Contexts)
            foreach (var type in ctx.Types)
                if (char.IsLower(type.Name[0]))
                    context.Report(Diagnostic.Warning("ACME001",
                        $"type '{type.Name}' should be PascalCase", type.Span));
    }
}
```

Wire it in code via `new KoineCompiler([new NoLowercaseTypeNames()])`, or let the CLI discover it: set
the `analyzers` key in `koine.config` to a comma-separated list of assembly paths. Every public,
parameterless-constructible `IModelAnalyzer` in those assemblies runs after the built-in checks.

```ini
# koine.config
analyzers = ./build/Acme.KoineAnalyzers.dll
```

## Ship an emitter

A new backend is a new emitter, not a rewrite. Implement `IEmitterProvider` (which returns an
`IEmitter` for your target):

```csharp
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

public sealed class GoEmitterProvider : IEmitterProvider
{
    public string Target => "go";
    public IEmitter Create(EmitterOptions options) => new GoEmitter(options);
}

public sealed class GoEmitter : IEmitter
{
    public IReadOnlyList<EmittedFile> Emit(KoineModel model) => /* … */;
}
```

The CLI loads external emitters from the `emitters` key in `koine.config` (same discovery rules as
analyzers), so `koine build Models/ --target go` resolves your provider through the same
`EmitterRegistry` the built-in targets use.

```ini
# koine.config
emitters = ./build/Acme.GoEmitter.dll
```

The neutral `EmitterOptions` (namespace remap and forward keys) is the host-agnostic configuration
handed to every provider; map it to your emitter's own options inside `Create`.
