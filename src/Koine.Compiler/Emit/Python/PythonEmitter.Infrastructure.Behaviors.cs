using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// The command-pipeline-behavior + provider slice of the Python Infrastructure layer (issue #241): a
/// <c>validation_behavior</c> (runs the supplied validators before the handler) and a
/// <c>transaction_behavior</c> (commits the unit of work after a successful handler), the idiomatic
/// Python analogue of the MediatR <c>IPipelineBehavior</c> decorators the C# emitter renders; plus a
/// per-context provider — a frozen dataclass holding the assembled components and a
/// <c>create_&lt;context&gt;_infrastructure</c> factory (the Python analogue of C#'s
/// <c>Add&lt;Context&gt;Infrastructure</c>). The validation behavior degrades to a pass-through when no
/// validators are supplied (Python has no emitted validator surface yet — Assumption 4).
/// </summary>
public sealed partial class PythonEmitter
{
    /// <summary>
    /// Emits the context's <c>behaviors.py</c>: the <c>validation_behavior</c> and
    /// <c>transaction_behavior</c> pipeline-behavior factories, generic over the request/response types
    /// and composing through the shared <c>PipelineBehavior</c> callable alias.
    /// </summary>
    private EmittedFile EmitBehaviors(string contextName)
    {
        var i2 = Indent + Indent;
        var i3 = i2 + Indent;

        var sb = new StringBuilder();
        sb.Append("TRequest = TypeVar(\"TRequest\")\n");
        sb.Append("TResponse = TypeVar(\"TResponse\")\n\n\n");

        sb.Append("def validation_behavior(\n");
        sb.Append(Indent).Append("validators: Sequence[Validator[TRequest]] = (),\n");
        sb.Append(") -> PipelineBehavior[TRequest, TResponse]:\n");
        WriteDoc(sb, "Validation behavior: runs every supplied validator before the handler, raising "
            + "ValidationError on failure. With no validators it is a pass-through (Assumption 4).", Indent);
        sb.Append('\n');
        sb.Append(Indent).Append("async def behavior(request: TRequest, next: Callable[[], Awaitable[TResponse]]) -> TResponse:\n");
        sb.Append(i2).Append("errors = [error for validator in validators for error in validator.validate(request)]\n");
        sb.Append(i2).Append("if errors:\n");
        sb.Append(i3).Append("raise ValidationError(errors)\n");
        sb.Append(i2).Append("return await next()\n");
        sb.Append('\n');
        sb.Append(Indent).Append("return behavior\n");
        sb.Append("\n\n");

        sb.Append("def transaction_behavior(\n");
        sb.Append(Indent).Append("unit_of_work: UnitOfWork,\n");
        sb.Append(") -> PipelineBehavior[TRequest, TResponse]:\n");
        WriteDoc(sb, "Transaction behavior: commits the unit of work after a successful handler.", Indent);
        sb.Append('\n');
        sb.Append(Indent).Append("async def behavior(request: TRequest, next: Callable[[], Awaitable[TResponse]]) -> TResponse:\n");
        sb.Append(i2).Append("response = await next()\n");
        sb.Append(i2).Append("await unit_of_work.save_changes()\n");
        sb.Append(i2).Append("return response\n");
        sb.Append('\n');
        sb.Append(Indent).Append("return behavior\n");

        var stdlib = new[]
        {
            "from collections.abc import Awaitable, Callable, Sequence",
            "from typing import TypeVar",
        };
        var imports = new List<(string, string)>
        {
            (InfraModule, "PipelineBehavior"),
            (InfraModule, "ValidationError"),
            (InfraModule, "Validator"),
            (InfraModuleDotted(contextName, "UnitOfWork"), "UnitOfWork"),
        };

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, "Behaviors"),
            RenderPyInfra(sb.ToString(), stdlib, imports));
    }

    /// <summary>
    /// Emits the context's provider: a frozen <c>&lt;Context&gt;Infrastructure</c> dataclass holding the
    /// assembled repositories, unit of work, command-pipeline behaviors and — for a publishing context —
    /// the outbox dispatcher, plus a <c>create_&lt;context&gt;_infrastructure</c> factory that wires the
    /// in-memory defaults. The Python analogue of C#'s <c>Add&lt;Context&gt;Infrastructure</c> DI extension.
    /// </summary>
    private EmittedFile EmitProvider(string contextName, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var ctxPascal = PythonNaming.ToPascalCase(contextName);
        var ctxSnake = PythonNaming.ToSnakeCase(contextName);
        var className = ctxPascal + "Infrastructure";
        var fnName = "create_" + ctxSnake + "_infrastructure";

        var props = aggregates
            .Select(a => PythonNaming.ToPascalCase(a.RootEntity()!.Name))
            .Select(root => (Root: root, Attr: PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(Pluralize(root)))))
            .ToList();

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(className).Append(":\n");
        WriteDoc(sb, $"The assembled {contextName} infrastructure: repositories, the unit of work, the "
            + "command-pipeline behaviors" + (publishesEvents ? ", and the outbox dispatcher." : "."), Indent);
        sb.Append('\n');
        foreach (var (root, attr) in props)
        {
            sb.Append(Indent).Append(attr).Append(": ").Append(root).Append("Repository\n");
        }

        sb.Append(Indent).Append("unit_of_work: UnitOfWork\n");
        sb.Append(Indent).Append("behaviors: Sequence[PipelineBehavior[object, object]]\n");
        if (publishesEvents)
        {
            sb.Append(Indent).Append("dispatcher: IntegrationEventDispatcher\n");
        }

        sb.Append("\n\n");

        sb.Append("def ").Append(fnName).Append('(');
        if (publishesEvents)
        {
            sb.Append("handler: IntegrationEventHandler");
        }

        sb.Append(") -> ").Append(className).Append(":\n");
        WriteDoc(sb, $"Composition root for the {contextName} context's infrastructure — the analogue of C#'s "
            + $"Add{ctxPascal}Infrastructure. Wires the in-memory defaults; inject persistent stores to productionize.", Indent);
        foreach (var (root, attr) in props)
        {
            sb.Append(Indent).Append(attr).Append(" = ").Append(root).Append("RepositoryImpl()\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append("outbox: OutboxStore = InMemoryOutboxStore()\n");
        }

        sb.Append(Indent).Append("unit_of_work = UnitOfWork(")
          .Append(string.Join(", ", props.Select(p => p.Attr).Concat(publishesEvents ? new[] { "outbox" } : Array.Empty<string>())))
          .Append(")\n");
        if (publishesEvents)
        {
            sb.Append(Indent).Append("dispatcher = IntegrationEventDispatcher(outbox, handler)\n");
        }

        sb.Append(Indent).Append("behaviors: Sequence[PipelineBehavior[object, object]] = (\n");
        sb.Append(Indent).Append(Indent).Append("validation_behavior(),\n");
        sb.Append(Indent).Append(Indent).Append("transaction_behavior(unit_of_work),\n");
        sb.Append(Indent).Append(")\n");

        var ctorArgs = props.Select(p => p.Attr).Append("unit_of_work").Append("behaviors");
        if (publishesEvents)
        {
            ctorArgs = ctorArgs.Append("dispatcher");
        }

        sb.Append(Indent).Append("return ").Append(className).Append('(').Append(string.Join(", ", ctorArgs)).Append(")\n");

        var stdlib = new List<string>
        {
            "from collections.abc import Sequence",
            "from dataclasses import dataclass",
        };
        var imports = new List<(string, string)>
        {
            (InfraModule, "PipelineBehavior"),
            (InfraModuleDotted(contextName, "Behaviors"), "transaction_behavior"),
            (InfraModuleDotted(contextName, "Behaviors"), "validation_behavior"),
            (InfraModuleDotted(contextName, "UnitOfWork"), "UnitOfWork"),
        };
        foreach (AggregateDecl agg in aggregates)
        {
            var root = PythonNaming.ToPascalCase(agg.RootEntity()!.Name);
            var aggNs = ModelIndex.NamespaceOf(contextName, agg.ModulePath);
            imports.Add((ModuleDottedFor(aggNs, KindFolder.Repositories, $"{root}Repository"), $"{root}Repository"));
            imports.Add((InfraModuleDotted(contextName, $"{root}RepositoryImpl"), $"{root}RepositoryImpl"));
        }

        if (publishesEvents)
        {
            imports.Add((InfraModule, "IntegrationEventHandler"));
            imports.Add((InfraModule, "InMemoryOutboxStore"));
            imports.Add((InfraModule, "OutboxStore"));
            imports.Add((InfraModuleDotted(contextName, "IntegrationEventDispatcher"), "IntegrationEventDispatcher"));
        }

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, className),
            RenderPyInfra(sb.ToString(), stdlib, imports));
    }
}
