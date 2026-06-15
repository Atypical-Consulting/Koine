using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Target-agnostic semantic validation over a <see cref="KoineModel"/>. Produces
/// <see cref="Diagnostic"/>s for unknown type references, duplicate members, and
/// unknown field/identifier references in invariant conditions and member
/// initializers.
/// </summary>
public sealed class SemanticValidator
{
    /// <summary>Validates the model and returns all semantic diagnostics.</summary>
    public IReadOnlyList<Diagnostic> Validate(KoineModel model)
    {
        var index = new ModelIndex(model);
        var resolver = new TypeResolver(index);
        var enumMembers = CollectEnumMembers(model);
        var diagnostics = new List<Diagnostic>();

        ValidateUniqueTypeNames(model, diagnostics);

        foreach (var ctx in model.Contexts)
            foreach (var type in ctx.Types)
                ValidateType(type, index, resolver, enumMembers, diagnostics);

        return diagnostics;
    }

    /// <summary>
    /// Reports duplicate emittable type names across the whole model (a duplicate
    /// silently shadows the first). Aggregate declarations are excluded: an
    /// aggregate is a namespace/boundary, not an emitted type, and idiomatically
    /// shares its name with its root entity (<c>aggregate Order root Order</c>).
    /// </summary>
    private static void ValidateUniqueTypeNames(KoineModel model, List<Diagnostic> diagnostics)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ctx in model.Contexts)
            foreach (var type in Flatten(ctx))
                if (type is not AggregateDecl && !seen.Add(type.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateType, $"duplicate type '{type.Name}'", type.Span.Line, type.Span.Column));
    }

    private static IEnumerable<TypeDecl> Flatten(ContextNode ctx)
    {
        foreach (var t in ctx.Types)
        {
            yield return t;
            if (t is AggregateDecl agg)
                foreach (var nested in agg.Types)
                    yield return nested;
        }
    }

    private static void ValidateType(
        TypeDecl type,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        string? aggregateRoot = null)
    {
        switch (type)
        {
            case ValueObjectDecl v:
                ValidateMembersAndInvariants(v.Members, v.Invariants, index, resolver, enumMembers, diagnostics);
                break;
            case EntityDecl e:
                ValidateMembersAndInvariants(e.Members, e.Invariants, index, resolver, enumMembers, diagnostics);
                ValidateStates(e, index, resolver, enumMembers, diagnostics);
                // Events may be emitted only from a standalone entity or the aggregate root.
                var emitAllowed = aggregateRoot is null || aggregateRoot == e.Name;
                ValidateCommands(e, index, resolver, enumMembers, diagnostics, emitAllowed);
                break;
            case AggregateDecl agg:
                // The root must name a type declared inside the aggregate.
                if (!agg.Types.Any(t => t.Name == agg.RootName))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownAggregateRoot,
                        $"unknown aggregate root '{agg.RootName}'", agg.Span.Line, agg.Span.Column));
                foreach (var nested in agg.Types)
                    ValidateType(nested, index, resolver, enumMembers, diagnostics, agg.RootName);
                break;
            case EnumDecl en:
                // Duplicate enum members produce uncompilable C#.
                var seenMembers = new HashSet<string>(StringComparer.Ordinal);
                foreach (var member in en.Members)
                    if (!seenMembers.Add(member))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateEnumMember,
                            $"duplicate enum member '{member}'", en.Span.Line, en.Span.Column));
                break;
            case EventDecl ev:
                // Events are validated like value objects but carry no invariants.
                ValidateMembersAndInvariants(ev.Members, Array.Empty<Invariant>(), index, resolver, enumMembers, diagnostics);
                // The generated record always carries an `OccurredOn` property; a
                // field that maps to it would produce a duplicate-member.
                foreach (var m in ev.Members)
                    if (string.Equals(m.Name, "OccurredOn", StringComparison.OrdinalIgnoreCase))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedEventField,
                            $"event field '{m.Name}' collides with the reserved 'OccurredOn' metadata property",
                            m.Span.Line, m.Span.Column));
                break;
        }
    }

    private static void ValidateMembersAndInvariants(
        IReadOnlyList<Member> members,
        IReadOnlyList<Invariant> invariants,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics)
    {
        var memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var scope = TypeScope.FromMembers(members);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        foreach (var m in members)
        {
            // 1. Unknown type reference (and its element for List<T>).
            ValidateTypeRef(m.Type, index, diagnostics);

            // 2. Duplicate member, reported at the second occurrence's span.
            if (!seen.Add(m.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateMember, $"duplicate member '{m.Name}'", m.Span.Line, m.Span.Column));

            // 3. The member initializer.
            if (m.Initializer is not null)
            {
                // A constant default for an enum-typed field must name a member of
                // THAT enum (not just any enum in the model).
                if (m.Initializer is IdentifierExpr enumDefault
                    && index.Classify(m.Type.Name) == TypeKind.Enum
                    && index.TryGetDecl(m.Type.Name, out var decl)
                    && decl is EnumDecl en)
                {
                    if (!en.Members.Contains(enumDefault.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownEnumMemberForType,
                            $"unknown enum member '{enumDefault.Name}' for type '{m.Type.Name}'{Suggestions.For(enumDefault.Name, en.Members)}",
                            enumDefault.Span.Line, enumDefault.Span.Column));
                }
                else
                {
                    checker.Check(m.Initializer, scope, m.Type);

                    // `now` is non-deterministic, so it cannot be a STORED default
                    // (a derived/computed field re-evaluating `now` is fine).
                    if (!MemberAnalysis.IsDerived(m, memberNames)
                        && MemberAnalysis.ReferencedIdentifiers(m.Initializer).Contains("now"))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NowAsStoredDefault,
                            $"'now' cannot be used as a stored default for '{m.Name}'",
                            m.Span.Line, m.Span.Column));

                    // An optional value can't initialize a non-optional field without a fallback.
                    var initType = resolver.Infer(m.Initializer, scope);
                    if (initType is { IsOptional: true } && !m.Type.IsOptional)
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.OptionalAssignedToNonOptional,
                            $"optional value assigned to non-optional field '{m.Name}'; provide a fallback with '??'",
                            m.Span.Line, m.Span.Column));
                }
            }
        }

        foreach (var inv in invariants)
            checker.Check(inv.Condition, scope);
    }

    /// <summary>
    /// Validates an entity's commands: parameter type refs, <c>requires</c>
    /// preconditions, and <c>field -&gt; value</c> transitions (target must be a
    /// mutable, non-derived member; value must be type-compatible). Scope for
    /// expressions is the entity's members plus the command's parameters.
    /// </summary>
    private static void ValidateCommands(
        EntityDecl entity,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        bool emitAllowed)
    {
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var memberByName = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach (var m in entity.Members)
            memberByName[m.Name] = m;

        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        // Names are compared case-insensitively because both commands (methods) and
        // members (properties) emit Pascal/camel-cased C# identifiers; a clash there
        // produces uncompilable output (CS0102/CS0111).
        var seenCommands = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var propertyNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.OrdinalIgnoreCase)
        {
            "Id"
        };

        foreach (var cmd in entity.Commands)
        {
            if (!seenCommands.Add(cmd.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateCommand,
                    $"command '{cmd.Name}' is declared more than once on '{entity.Name}'", cmd.Span.Line, cmd.Span.Column));
            else if (propertyNames.Contains(cmd.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.CommandNameCollision,
                    $"command '{cmd.Name}' collides with a property of '{entity.Name}'", cmd.Span.Line, cmd.Span.Column));

            // Scope: the entity's members, the synthetic `id` (its identity), and the
            // command's parameters.
            var scopePairs = entity.Members.Select(m => new KeyValuePair<string, TypeRef>(m.Name, m.Type))
                .Append(new KeyValuePair<string, TypeRef>("id", new TypeRef(entity.IdentityName)))
                .Concat(cmd.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
            var scope = new TypeScope(scopePairs);

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in cmd.Parameters)
            {
                ValidateTypeRef(p.Type, index, diagnostics);
                if (!seenParams.Add(p.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                        $"duplicate parameter '{p.Name}' in command '{cmd.Name}'", p.Span.Line, p.Span.Column));
            }

            foreach (var stmt in cmd.Body)
            {
                switch (stmt)
                {
                    case RequiresClause req:
                        checker.Check(req.Condition, scope);
                        break;

                    case Transition tr:
                        if (!memberByName.TryGetValue(tr.Field, out var target))
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidTransitionTarget,
                                $"cannot transition '{tr.Field}': not a field of '{entity.Name}'", tr.Span.Line, tr.Span.Column));
                        else if (MemberAnalysis.IsDerived(target, memberNames))
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidTransitionTarget,
                                $"cannot transition derived field '{tr.Field}'", tr.Span.Line, tr.Span.Column));
                        else
                        {
                            checker.CheckTransitionValue(tr.Value, target.Type, tr.Field, scope);
                            CheckTransitionReachable(entity, tr, target, index, diagnostics);
                        }
                        break;

                    case EmitClause emit:
                        if (!emitAllowed)
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitOutsideRoot,
                                $"events may only be emitted from the aggregate root, not from '{entity.Name}'",
                                emit.Span.Line, emit.Span.Column));
                        ValidateEmit(emit, index, checker, scope, diagnostics);
                        break;
                }
            }
        }
    }

    /// <summary>
    /// When the transitioned field has a state machine and the value is a literal
    /// state of that enum, flags a target that NO rule can reach (always-illegal).
    /// </summary>
    private static void CheckTransitionReachable(
        EntityDecl entity, Transition tr, Member target, ModelIndex index, List<Diagnostic> diagnostics)
    {
        var states = entity.States.FirstOrDefault(s => s.Field == tr.Field);
        if (states is null || states.Rules.Count == 0)
            return;
        if (tr.Value is not IdentifierExpr stateRef)
            return; // dynamic target: only a runtime guard applies
        if (index.Classify(target.Type.Name) != TypeKind.Enum
            || !index.EnumsDeclaring(stateRef.Name).Contains(target.Type.Name))
            return; // not a literal state of the bound enum (other errors cover it)

        if (!states.Rules.Any(r => r.To.Contains(stateRef.Name)))
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnreachableTransition,
                $"no state rule allows transitioning '{tr.Field}' to '{stateRef.Name}'", tr.Span.Line, tr.Span.Column));
    }

    /// <summary>
    /// Validates an entity's <c>states</c> blocks: each binds to an enum-typed
    /// member; every state names a member of that enum; per-rule guards resolve
    /// against the entity's members.
    /// </summary>
    private static void ValidateStates(
        EntityDecl entity,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics)
    {
        var memberByName = entity.Members.ToDictionary(m => m.Name, m => m, StringComparer.Ordinal);
        var scope = TypeScope.FromMembers(entity.Members);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        // A field may have at most one states block: the reachability check and the
        // emitted guard each consult a single block, so a second would silently drop rules.
        var seenFields = new HashSet<string>(StringComparer.Ordinal);

        foreach (var states in entity.States)
        {
            if (!seenFields.Add(states.Field))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateStatesBlock,
                    $"field '{states.Field}' already has a states block", states.Span.Line, states.Span.Column));
                continue;
            }

            if (!memberByName.TryGetValue(states.Field, out var field))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidStatesBinding,
                    $"states binds to '{states.Field}', which is not a field of '{entity.Name}'", states.Span.Line, states.Span.Column));
                continue;
            }
            if (index.Classify(field.Type.Name) != TypeKind.Enum)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidStatesBinding,
                    $"states field '{states.Field}' must be an enum, but is '{field.Type.Name}'", states.Span.Line, states.Span.Column));
                continue;
            }

            var enumName = field.Type.Name;
            var validStates = index.TryGetDecl(enumName, out var decl) && decl is EnumDecl en
                ? new HashSet<string>(en.Members, StringComparer.Ordinal)
                : new HashSet<string>(StringComparer.Ordinal);

            foreach (var rule in states.Rules)
            {
                foreach (var state in new[] { rule.From }.Concat(rule.To))
                    if (!validStates.Contains(state))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownState,
                            $"'{state}' is not a member of enum '{enumName}'", rule.Span.Line, rule.Span.Column));

                if (rule.Guard is not null)
                    checker.Check(rule.Guard, scope);
            }
        }
    }

    /// <summary>
    /// Validates an <c>emit EventName(field: value, …)</c>: the name must be a
    /// declared event, every argument must name a distinct event field with a
    /// type-compatible value, and every event field must be supplied.
    /// </summary>
    private static void ValidateEmit(
        EmitClause emit,
        ModelIndex index,
        ExpressionChecker checker,
        TypeScope scope,
        List<Diagnostic> diagnostics)
    {
        if (!index.TryGetDecl(emit.EventName, out var decl) || decl is not EventDecl ev)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownEvent,
                $"unknown event '{emit.EventName}'", emit.Span.Line, emit.Span.Column));
            foreach (var arg in emit.Args)
                checker.Check(arg.Value, scope);
            return;
        }

        var eventFields = ev.Members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
        var provided = new HashSet<string>(StringComparer.Ordinal);

        foreach (var arg in emit.Args)
        {
            if (!provided.Add(arg.Field))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"duplicate field '{arg.Field}' in emit of '{ev.Name}'", arg.Span.Line, arg.Span.Column));

            if (eventFields.TryGetValue(arg.Field, out var fieldType))
                checker.CheckEmitArg(arg.Value, fieldType, ev.Name, arg.Field, scope);
            else
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"event '{ev.Name}' has no field '{arg.Field}'", arg.Span.Line, arg.Span.Column));
        }

        foreach (var field in ev.Members)
            if (!provided.Contains(field.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"emit of '{ev.Name}' is missing field '{field.Name}'", emit.Span.Line, emit.Span.Column));
    }

    private static void ValidateTypeRef(TypeRef type, ModelIndex index, List<Diagnostic> diagnostics)
    {
        if (!index.IsKnownType(type.Name))
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownType,
                $"unknown type '{type.Name}'{Suggestions.For(type.Name, index.CandidateTypeNames)}",
                type.Span.Line, type.Span.Column));

        // Generic arity: List/Set take one type argument; Map takes two.
        switch (index.Classify(type.Name))
        {
            case TypeKind.List or TypeKind.Set:
                if (type.Element is null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.GenericArity, $"'{type.Name}' requires a type argument", type.Span.Line, type.Span.Column));
                if (type.Value is not null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.GenericArity, $"'{type.Name}' takes a single type argument", type.Span.Line, type.Span.Column));
                break;
            case TypeKind.Map:
                if (type.Element is null || type.Value is null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.GenericArity, "'Map' requires two type arguments <Key, Value>", type.Span.Line, type.Span.Column));
                break;
        }

        if (type.Element is not null)
            ValidateTypeRef(type.Element, index, diagnostics);
        if (type.Value is not null)
            ValidateTypeRef(type.Value, index, diagnostics);
    }

    /// <summary>Collects every enum member name declared anywhere in the model.</summary>
    private static IReadOnlySet<string> CollectEnumMembers(KoineModel model)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ctx in model.Contexts)
            foreach (var type in ctx.Types)
                CollectEnumMembers(type, names);
        return names;
    }

    private static void CollectEnumMembers(TypeDecl type, HashSet<string> names)
    {
        switch (type)
        {
            case EnumDecl e:
                foreach (var member in e.Members)
                    names.Add(member);
                break;
            case AggregateDecl agg:
                foreach (var nested in agg.Types)
                    CollectEnumMembers(nested, names);
                break;
        }
    }

    /// <summary>
    /// Finds the root identifier of an expression by following
    /// <see cref="MemberAccessExpr.Target"/> chains down to an
    /// <see cref="IdentifierExpr"/>. Returns <c>null</c> when the chain does not
    /// bottom out in a bare identifier.
    /// </summary>
    public static IdentifierExpr? RootIdentifier(Expr expr) => expr switch
    {
        IdentifierExpr id => id,
        MemberAccessExpr ma => RootIdentifier(ma.Target),
        _ => null
    };
}
