using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// R12.3/R12.4 — read models and queries. Split out of
/// <see cref="SemanticValidator"/>; <see cref="ValidateReadModel"/> and
/// <see cref="ValidateQuery"/> are dispatched from the type-validation switch in
/// the same order as before, preserving diagnostic codes, messages, and emission
/// order. (Use cases, which co-emit with services, stay in the services pass.)
/// </summary>
internal static class CqrsValidator
{
    /// <summary>
    /// Validates a read model (R12.3): the source must be a declared value/entity;
    /// field names are unique; a direct field must name a source member; a derived
    /// field's projection must resolve over the source and produce a value assignable
    /// to its declared type.
    /// </summary>
    public static void ValidateReadModel(
        ReadModelDecl rm, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var sourceMembers = ReadModelSourceMembers(resolver.Context, rm.SourceType, index);
        if (sourceMembers is null)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelUnknownSource,
                $"read model '{rm.Name}' projects from '{rm.SourceType}', which is not a declared value or entity type",
                rm.Span));
            return;
        }

        // Build defensively (last-wins): a source value object with duplicate members
        // (reported elsewhere as KOI0103) must not crash this loop.
        var memberByName = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach (var m in sourceMembers)
        {
            memberByName[m.Name] = m;
        }

        var sourceMemberNames = memberByName.Keys.ToArray();
        var scope = TypeScope.FromMembers(sourceMembers, index);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);
        // The record property a field emits to (R12.3): a positional record property is
        // PascalCased, so two fields differing only by their first-letter case collide.
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var field in rm.Fields)
        {
            if (!seen.Add(SemanticValidator.PropertyKey(field.Name)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateReadModelField,
                    $"duplicate field '{field.Name}' in read model '{rm.Name}'", field.Span));
            }

            if (SemanticValidator.IsReservedRecordMember(field.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                    $"read-model field '{field.Name}' collides with a record-synthesized member", field.Span));
            }

            if (field.Projection is null)
            {
                // A direct field must name a member (or the synthetic `id`) of the source.
                if (!memberByName.ContainsKey(field.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelUnknownField,
                        $"read model '{rm.Name}' field '{field.Name}' is not a member of '{rm.SourceType}'{Suggestions.For(field.Name, sourceMemberNames)}",
                        field.Span) with
                    { Suggestion = Suggestions.Best(field.Name, sourceMemberNames) });
                }
            }
            else
            {
                // A derived field: the projection resolves over the source; its declared
                // type must be known and accept the projected value.
                SemanticValidator.ValidateTypeRef(field.Type!, index, diagnostics);
                checker.Check(field.Projection, scope, field.Type);
                var inferred = resolver.Infer(field.Projection, scope);
                if (inferred is not null && index.IsKnownType(field.Type!.Name)
                    && !MemberAnalysis.IsAssignable(inferred, field.Type!))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelFieldTypeMismatch,
                        $"read model '{rm.Name}' field '{field.Name}' is declared '{field.Type!.Name}' but projects a '{inferred.Name}'",
                        field.Span));
                }
            }
        }
    }

    /// <summary>
    /// Validates a query (R12.4): criteria parameter types and names, and that the
    /// result is a declared read model or a <c>List</c> of one.
    /// </summary>
    public static void ValidateQuery(QueryDecl q, ModelIndex index, List<Diagnostic> diagnostics)
    {
        // Criteria become positional record properties (PascalCased), so dedup on the
        // emitted property key and reject names that collide with record members.
        var seenParams = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in q.Criteria)
        {
            SemanticValidator.ValidateTypeRef(p.Type, index, diagnostics);
            if (!seenParams.Add(SemanticValidator.PropertyKey(p.Name)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                    $"duplicate criterion '{p.Name}' in query '{q.Name}'", p.Span));
            }

            if (SemanticValidator.IsReservedRecordMember(p.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                    $"query criterion '{p.Name}' collides with a record-synthesized member", p.Span));
            }
        }

        SemanticValidator.ValidateTypeRef(q.ResultType, index, diagnostics);
        var resultName = q.ResultType.Name == ModelIndex.ListTypeName
            ? q.ResultType.Element?.Name
            : q.ResultType.Name;
        if (resultName is not null && index.Classify(resultName) != TypeKind.ReadModel)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QueryResultNotReadModel,
                $"query '{q.Name}' must return a read model or 'List<readmodel>', not '{q.ResultType.Name}'",
                q.Span));
        }
    }

    /// <summary>
    /// The members a read model can project from its source (entities add the synthetic
    /// <c>id</c>); <c>null</c> when the source is not a value/entity type.
    /// </summary>
    private static IReadOnlyList<Member>? ReadModelSourceMembers(string? context, string sourceType, ModelIndex index)
    {
        // Resolve the source in the read model's own context first (R13.2), so a name
        // shared across contexts binds to the right declaration.
        TypeDecl? decl = null;
        if (context is not null && index.TryGetDeclIn(context, sourceType, out var local))
        {
            decl = local;
        }
        else if (index.TryGetDecl(sourceType, out var global))
        {
            decl = global;
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => EntityProjectionMembers(e),
            _ => null
        };
    }

    /// <summary>
    /// An entity's members plus the synthetic <c>id</c> — added only when the entity does
    /// not already declare its own <c>id</c> member (which would otherwise duplicate it).
    /// </summary>
    private static IReadOnlyList<Member> EntityProjectionMembers(EntityDecl e) =>
        e.Members.Any(m => string.Equals(m.Name, "id", StringComparison.OrdinalIgnoreCase))
            ? e.Members
            : e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList();
}
