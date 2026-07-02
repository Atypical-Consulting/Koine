using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Glossary;

/// <summary>
/// Builds the structured <see cref="GlossaryModel"/> (#67) by walking the target-agnostic
/// <see cref="KoineModel"/> in declaration order. The same <see cref="Walk"/> is the single source
/// of truth for an entry's qualified id, so the glossary view and the doc-comment editor
/// (<c>SetDocEditor</c>) address the very same node by the very same id. Kind names match the
/// glossary markdown emitter (<c>GlossaryEmitter</c>, now in the Koine.Emit.Glossary assembly).
/// </summary>
public static class GlossaryModelBuilder
{
    public static GlossaryModel Build(KoineModel model) =>
        new(Walk(model)
            .Select(w => new GlossaryEntry(
                w.QualifiedName, w.Name, w.Kind, w.Context, w.QualifiedName, w.Node.Doc, w.Node.NameSpan))
            .ToList());

    /// <summary>
    /// Enumerates every glossary-addressable declaration (each context, then its types — recursing into
    /// aggregate-nested types) with the qualified id used to address it. Shared by <see cref="Build"/>
    /// and the doc-comment editor so ids never drift between read and write.
    /// </summary>
    internal static IEnumerable<(string QualifiedName, string Name, string Kind, string Context, KoineNode Node)> Walk(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            yield return (ctx.Name, ctx.Name, "context", ctx.Name, ctx);
            foreach (var entry in WalkTypes(ctx.Types, ctx.Name, ctx.Name))
            {
                yield return entry;
            }
        }
    }

    private static IEnumerable<(string QualifiedName, string Name, string Kind, string Context, KoineNode Node)> WalkTypes(
        IReadOnlyList<TypeDecl> types, string context, string prefix)
    {
        foreach (TypeDecl type in types)
        {
            var qualified = prefix + "." + type.Name;
            yield return (qualified, type.Name, KindOf(type), context, type);

            if (type is AggregateDecl agg)
            {
                foreach (var nested in WalkTypes(agg.Types, context, qualified))
                {
                    yield return nested;
                }
            }
        }
    }

    private static string KindOf(TypeDecl type) => type switch
    {
        AggregateDecl => "aggregate",
        EnumDecl => "enum",
        ValueObjectDecl { IsQuantity: true } => "quantity",
        ValueObjectDecl => "value",
        EventDecl => "event",
        IntegrationEventDecl => "integration event",
        EntityDecl => "entity",
        _ => "type",
    };
}
