using System.Text;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The command-pipeline-behavior slice of the TypeScript Infrastructure layer (issue #241): a
/// <c>validationBehavior</c> (runs the supplied validators before the handler) and a
/// <c>transactionBehavior</c> (commits the unit of work after a successful handler), the idiomatic TS
/// analogue of the MediatR <c>IPipelineBehavior</c> decorators the C# emitter renders. The behaviors are
/// plain functions over the shared <see cref="TsRuntime.InfrastructureModuleName"/> <c>PipelineBehavior</c>
/// type. The validation behavior degrades to a pass-through when no validators are supplied (TS has no
/// emitted validator surface yet — Assumption 4), so it is never silently surprising.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    /// <summary>
    /// Emits the context's <c>Behaviors.ts</c>: the <c>validationBehavior</c> and
    /// <c>transactionBehavior</c> pipeline-behavior factories. Both are generic over the request/response
    /// types and compose through the shared <c>PipelineBehavior</c> function type.
    /// </summary>
    private EmittedFile EmitBehaviors(string contextName)
    {
        var folder = InfraFolder(contextName);

        // The behaviors are written with `.then` rather than `async`/`await` on purpose: an async arrow
        // returning a generic `Promise<TResponse>` would be typed `Promise<Awaited<TResponse>>`, which is
        // NOT assignable to `Promise<TResponse>` under --strict. `.then` keeps the resolved value typed
        // `TResponse`, so the factories stay generic and tsc-clean.
        var sb = new StringBuilder();
        WriteDoc(sb, "Validation behavior: runs every supplied validator before the handler, rejecting with "
            + "ValidationError on failure. With no validators it is a pass-through (Assumption 4).", "");
        sb.Append("export function validationBehavior<TRequest, TResponse>(\n");
        sb.Append(Indent).Append("validators: readonly Validator<TRequest>[] = [],\n");
        sb.Append("): PipelineBehavior<TRequest, TResponse> {\n");
        sb.Append(Indent).Append("return (request, next) => {\n");
        sb.Append(Indent).Append(Indent).Append("const errors = validators.flatMap((validator) => validator.validate(request));\n");
        sb.Append(Indent).Append(Indent).Append("if (errors.length > 0) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return Promise.reject(new ValidationError(errors));\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("return next();\n");
        sb.Append(Indent).Append("};\n");
        sb.Append("}\n\n");

        WriteDoc(sb, "Transaction behavior: commits the unit of work after a successful handler.", "");
        sb.Append("export function transactionBehavior<TRequest, TResponse>(\n");
        sb.Append(Indent).Append("unitOfWork: IUnitOfWork,\n");
        sb.Append("): PipelineBehavior<TRequest, TResponse> {\n");
        sb.Append(Indent).Append("return (request, next) =>\n");
        sb.Append(Indent).Append(Indent).Append("next().then((response) => unitOfWork.saveChangesAsync().then(() => response));\n");
        sb.Append("}\n");

        var imports = new List<(string, string)>
        {
            ("IUnitOfWork", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Abstractions, "IUnitOfWork"))),
        };
        imports.AddRange(InfraRuntimeImports(contextName, "PipelineBehavior", "ValidationError", "Validator"));

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, "Behaviors"),
            RenderInfraFile(folder, sb.ToString(), imports));
    }
}
