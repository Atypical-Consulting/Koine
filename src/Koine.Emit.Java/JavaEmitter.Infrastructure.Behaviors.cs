using System.Text;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The pipeline-behaviors slice of the Java Infrastructure layer (issue #1726, Task 2) — the Java
/// analogue of <c>PythonEmitter.EmitBehaviors</c> and the C# emitter's MediatR-style
/// <c>IPipelineBehavior</c> decorators, expressed Java's way: a small functional interface
/// (<c>koine.runtime.PipelineBehavior</c>) plus composable static factories on a per-context
/// <c>Behaviors</c> class, rather than a decorator/attribute stack. Emitted alongside the unit of work
/// for every context with an entity-rooted aggregate, regardless of whether it publishes.
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>
    /// Emits the context's <c>Behaviors</c>: a <c>validationBehavior</c> (runs every supplied
    /// <c>koine.runtime.Validator</c> before delegating, short-circuiting with a
    /// <c>koine.runtime.ValidationError</c> on failure — a no-arg overload degrades to a pass-through)
    /// and a <c>transactionBehavior</c> (calls the context's <c>UnitOfWork.saveChanges()</c> after a
    /// successful handler, before handing back its response).
    /// </summary>
    private EmittedFile EmitBehaviors(string context)
    {
        var sb = new StringBuilder();
        WriteJavadoc(sb, $"Command-pipeline behaviors for the {context} context.", string.Empty);
        sb.Append("public final class Behaviors {\n");
        sb.Append(Indent).Append("private Behaviors() {\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        WriteJavadoc(sb, "Validation behavior with no validators: a pass-through.", Indent);
        sb.Append(Indent).Append("public static <TRequest, TResponse> koine.runtime.PipelineBehavior<TRequest, TResponse> ")
          .Append("validationBehavior() {\n");
        sb.Append(Indent).Append(Indent).Append("return validationBehavior(java.util.List.of());\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        WriteJavadoc(
            sb,
            "Validation behavior: runs every supplied validator before the handler, short-circuiting "
            + "with a koine.runtime.ValidationError on failure.",
            Indent);
        sb.Append(Indent).Append("public static <TRequest, TResponse> koine.runtime.PipelineBehavior<TRequest, TResponse> ")
          .Append("validationBehavior(java.util.List<koine.runtime.Validator<TRequest>> validators) {\n");
        sb.Append(Indent).Append(Indent).Append("return (request, next) -> {\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("java.util.List<String> errors = validators.stream()\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append(".flatMap(validator -> validator.validate(request).stream())\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append(".toList();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (!errors.isEmpty()) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("java.util.concurrent.CompletableFuture<TResponse> failed = new java.util.concurrent.CompletableFuture<>();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("failed.completeExceptionally(new koine.runtime.ValidationError(errors));\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return failed;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return next.get();\n");
        sb.Append(Indent).Append(Indent).Append("};\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        WriteJavadoc(
            sb, "Transaction behavior: calls the unit of work's saveChanges after a successful handler.", Indent);
        sb.Append(Indent).Append("public static <TRequest, TResponse> koine.runtime.PipelineBehavior<TRequest, TResponse> ")
          .Append("transactionBehavior(UnitOfWork unitOfWork) {\n");
        sb.Append(Indent).Append(Indent).Append("return (request, next) -> next.get()\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append(".thenCompose(response -> unitOfWork.saveChanges().thenApply(ignored -> response));\n");
        sb.Append(Indent).Append("}\n");

        sb.Append("}\n");
        return TypeFile(context, "Behaviors", sb.ToString());
    }
}
