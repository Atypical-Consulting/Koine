using System.Text;
using System.Text.RegularExpressions;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The opt-in Infrastructure layer of <see cref="TypeScriptEmitter"/> (issue #241), the TS analogue of
/// the C# emitter's <c>--layers infrastructure</c> output. Emitted only when
/// <see cref="TsEmitterOptions.EmitsInfrastructure"/> is set, it realizes — dependency-light and
/// <c>tsc --strict</c>-clean — the persistence-ignorant contracts the domain layer already produces:
/// concrete repositories over an injectable <c>AggregateStore</c> (in-memory by default), a concrete
/// unit of work, a transactional outbox + dispatcher (publishing contexts only), validation/transaction
/// pipeline behaviors, and a composition-root factory.
///
/// <para>All infrastructure decisions live in this folder — <c>Ast/</c> stays target-agnostic. Every
/// file is deterministic (declaration order) and ends in a single trailing newline, like the rest of the
/// emitter. The layer is off by default, so the domain output is byte-identical to today.</para>
/// </summary>
public sealed partial class TypeScriptEmitter
{
    /// <summary>
    /// Emits the Infrastructure layer for every bounded context that has at least one aggregate whose
    /// root is an entity (the same gate as the emitted <c>IUnitOfWork</c>). A context with no such
    /// aggregate produces no infrastructure — and a model with none produces nothing extra, no error.
    /// The shared <c>infrastructure-runtime</c> module is emitted once, only when something used it.
    /// </summary>
    private void EmitInfrastructure(TsEmitContext emit, KoineModel model, List<EmittedFile> files, TypeScriptTypeMapper typeMapper)
    {
        var anyEmitted = false;
        foreach (ContextNode ctx in model.Contexts)
        {
            var aggregates = ctx.Types.OfType<AggregateDecl>()
                .Where(a => a.RootEntity() is not null)
                .ToList();
            if (aggregates.Count == 0)
            {
                continue;
            }

            anyEmitted = true;

            // A context that publishes integration events gets a transactional outbox + dispatcher;
            // a subscribe-only (or event-free) context does not.
            var publishesEvents = ctx.Publishes.Count > 0;

            foreach (AggregateDecl agg in aggregates)
            {
                files.Add(EmitRepositoryImpl(emit, ctx.Name, agg, typeMapper));
            }

            files.Add(EmitUnitOfWorkImpl(ctx.Name, aggregates, publishesEvents));

            if (publishesEvents)
            {
                files.Add(EmitIntegrationEventDispatcher(ctx.Name));
            }

            files.Add(EmitBehaviors(ctx.Name));
            files.Add(EmitCompositionRoot(ctx.Name, aggregates, publishesEvents));
        }

        if (anyEmitted)
        {
            files.Add(new EmittedFile(TsRuntime.InfrastructureFileName, TsRuntime.InfrastructureSource + "\n"));
        }
    }

    /// <summary>
    /// Emits the context's composition root: a <c>&lt;Context&gt;Infrastructure</c> shape and a
    /// <c>create&lt;Context&gt;Infrastructure</c> factory that assembles the concrete repositories, the
    /// unit of work, the command-pipeline behaviors and — for a publishing context — the outbox
    /// dispatcher, wiring the in-memory defaults. The idiomatic TS analogue of the C# emitter's
    /// <c>Add&lt;Context&gt;Infrastructure(this IServiceCollection, …)</c> DI extension.
    /// </summary>
    private EmittedFile EmitCompositionRoot(string contextName, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var folder = InfraFolder(contextName);
        var ctxPascal = TypeScriptNaming.ToPascalCase(contextName);
        var ifaceName = ctxPascal + "Infrastructure";
        var fnName = "create" + ctxPascal + "Infrastructure";

        var props = aggregates
            .Select(a => TypeScriptNaming.ToPascalCase(a.RootEntity()!.Name))
            .Select(root => (Root: root, Prop: TypeScriptNaming.ToCamelCase(Pluralize(root))))
            .ToList();

        var sb = new StringBuilder();
        WriteDoc(sb, $"The assembled {contextName} infrastructure: repositories, the unit of work, the "
            + "command-pipeline behaviors" + (publishesEvents ? ", and the outbox dispatcher." : "."), "");
        sb.Append("export interface ").Append(ifaceName).Append(" {\n");
        foreach (var (root, prop) in props)
        {
            sb.Append(Indent).Append("readonly ").Append(prop).Append(": I").Append(root).Append("Repository;\n");
        }

        sb.Append(Indent).Append("readonly unitOfWork: IUnitOfWork;\n");
        sb.Append(Indent).Append("readonly behaviors: readonly PipelineBehavior<unknown, unknown>[];\n");
        if (publishesEvents)
        {
            sb.Append(Indent).Append("readonly dispatcher: IntegrationEventDispatcher;\n");
        }

        sb.Append("}\n\n");

        WriteDoc(sb, $"Composition root for the {contextName} context's infrastructure — the idiomatic analogue of "
            + $"C#'s Add{ctxPascal}Infrastructure. Wires the in-memory defaults; inject persistent stores to productionize.", "");
        sb.Append("export function ").Append(fnName).Append('(');
        if (publishesEvents)
        {
            sb.Append("handler: IntegrationEventHandler");
        }

        sb.Append("): ").Append(ifaceName).Append(" {\n");
        foreach (var (root, prop) in props)
        {
            sb.Append(Indent).Append("const ").Append(prop).Append(" = new ").Append(root).Append("Repository();\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append("const outbox: OutboxStore = new InMemoryOutboxStore();\n");
        }

        sb.Append(Indent).Append("const unitOfWork = new UnitOfWork(");
        sb.Append(string.Join(", ", props.Select(p => p.Prop).Concat(publishesEvents ? new[] { "outbox" } : Array.Empty<string>())));
        sb.Append(");\n");
        if (publishesEvents)
        {
            sb.Append(Indent).Append("const dispatcher = new IntegrationEventDispatcher(outbox, handler);\n");
        }

        sb.Append(Indent).Append("const behaviors: readonly PipelineBehavior<unknown, unknown>[] = [\n");
        sb.Append(Indent).Append(Indent).Append("validationBehavior(),\n");
        sb.Append(Indent).Append(Indent).Append("transactionBehavior(unitOfWork),\n");
        sb.Append(Indent).Append("];\n");

        var returnFields = props.Select(p => p.Prop).Append("unitOfWork").Append("behaviors");
        if (publishesEvents)
        {
            returnFields = returnFields.Append("dispatcher");
        }

        sb.Append(Indent).Append("return { ").Append(string.Join(", ", returnFields)).Append(" };\n");
        sb.Append("}\n");

        var imports = new List<(string, string)>
        {
            ("IUnitOfWork", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Abstractions, "IUnitOfWork"))),
            ("UnitOfWork", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Infrastructure, "UnitOfWork"))),
            ("validationBehavior", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Infrastructure, "Behaviors"))),
            ("transactionBehavior", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Infrastructure, "Behaviors"))),
        };
        imports.AddRange(InfraRuntimeImports(contextName, "PipelineBehavior"));
        foreach (AggregateDecl agg in aggregates)
        {
            var root = TypeScriptNaming.ToPascalCase(agg.RootEntity()!.Name);
            var aggNs = ModelIndex.NamespaceOf(contextName, agg.ModulePath);
            imports.Add(($"I{root}Repository", ImportSpecifier(folder, ModulePathFor(aggNs, KindFolder.Repositories, $"I{root}Repository"))));
            imports.Add(($"{root}Repository", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Infrastructure, $"{root}Repository"))));
        }

        if (publishesEvents)
        {
            imports.AddRange(InfraRuntimeImports(contextName, "IntegrationEventHandler", "InMemoryOutboxStore", "OutboxStore"));
            imports.Add(("IntegrationEventDispatcher", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Infrastructure, "IntegrationEventDispatcher"))));
        }

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, ifaceName),
            RenderInfraFile(folder, sb.ToString(), imports));
    }

    /// <summary>The output folder (namespace path + <c>infrastructure/</c> subfolder) every infra file lives in.</summary>
    private static string InfraFolder(string contextName) => FolderFor(contextName) + "/" + KindFolder.Infrastructure;

    /// <summary>The import specifier from an infra file to the shared <c>infrastructure-runtime</c> module.</summary>
    private string InfraRuntimeImport(string contextName) =>
        ImportSpecifier(InfraFolder(contextName), TsRuntime.InfrastructureModuleName);

    /// <summary>
    /// Wraps a rendered infrastructure body with its <c>// &lt;auto-generated/&gt;</c> banner and import
    /// block: the runtime symbols it references (auto-detected, imported from <c>runtime</c>) plus the
    /// explicit <paramref name="imports"/> the caller resolved (the domain types, the contract interfaces,
    /// and the <c>infrastructure-runtime</c> symbols). Only imports whose symbol actually appears in the
    /// body are emitted; groups are ordered by specifier and symbols sorted, so output is deterministic.
    /// </summary>
    private string RenderInfraFile(string folder, string body, IReadOnlyList<(string Symbol, string Module)> imports)
    {
        var present = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in IdentifierRegex.Matches(body))
        {
            present.Add(m.Value);
        }

        var sb = new StringBuilder();
        sb.Append("// <auto-generated/>\n");

        var runtime = RuntimeSymbols.Where(present.Contains).ToList();
        if (runtime.Count > 0)
        {
            sb.Append("import { ").Append(string.Join(", ", runtime)).Append(" } from '")
              .Append(RelativeImport(folder, TsRuntime.ModuleName)).Append("';\n");
        }

        var groups = imports
            .Where(i => present.Contains(i.Symbol))
            .GroupBy(i => i.Module)
            .OrderBy(g => g.Key, StringComparer.Ordinal)
            .ToList();
        foreach (var group in groups)
        {
            var symbols = group.Select(i => i.Symbol).Distinct(StringComparer.Ordinal).OrderBy(s => s, StringComparer.Ordinal);
            sb.Append("import { ").Append(string.Join(", ", symbols)).Append(" } from '").Append(group.Key).Append("';\n");
        }

        if (runtime.Count > 0 || groups.Count > 0)
        {
            sb.Append('\n');
        }

        sb.Append(body);
        if (!body.EndsWith('\n'))
        {
            sb.Append('\n');
        }

        return sb.ToString();
    }

    /// <summary>
    /// Resolves the <c>infrastructure-runtime</c> import pairs for the given symbols (e.g.
    /// <c>AggregateStore</c>, <c>InMemoryStore</c>) from <paramref name="contextName"/>'s infra folder.
    /// </summary>
    private IReadOnlyList<(string Symbol, string Module)> InfraRuntimeImports(string contextName, params string[] symbols)
    {
        var module = InfraRuntimeImport(contextName);
        return symbols.Select(s => (s, module)).ToList();
    }

    /// <summary>
    /// Resolves the imports for a finder parameter's type: each user-declared symbol the mapped TypeScript
    /// type mentions (value object, smart enum, or strongly-typed ID) is imported from the module it is
    /// emitted at — resolved through the shared <see cref="TsTypeLocation"/> table, preferring this
    /// context. Primitive/runtime types (<c>number</c>, <c>string</c>, <c>Decimal</c>, …) need no import.
    /// </summary>
    private IEnumerable<(string Symbol, string Module)> FinderParamImports(TsEmitContext emit, string contextName, string folder, TypeRef paramType, TypeScriptTypeMapper typeMapper)
    {
        var mapped = typeMapper.Map(paramType);
        foreach (Match m in IdentifierRegex.Matches(mapped))
        {
            var symbol = m.Value;
            if (ResolveTypeModule(emit, contextName, symbol) is { } modulePath)
            {
                yield return (symbol, ImportSpecifier(folder, modulePath));
            }
        }
    }

    /// <summary>
    /// The module a user type symbol is emitted at, via the <see cref="TsTypeLocation"/> table, preferring
    /// a location in <paramref name="thisContext"/> (a per-context shared type resolves to the local copy).
    /// <c>null</c> when the symbol is not a known user type (a primitive/runtime name).
    /// </summary>
    private static string? ResolveTypeModule(TsEmitContext emit, string thisContext, string symbol)
    {
        string? fallback = null;
        foreach (TsTypeLocation loc in emit.TypeLocations)
        {
            if (loc.ExportName != symbol)
            {
                continue;
            }

            if (loc.Context == thisContext)
            {
                return loc.ModulePath;
            }

            fallback ??= loc.ModulePath;
        }

        return fallback;
    }
}
