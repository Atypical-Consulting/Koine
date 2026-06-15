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
        {
            foreach (var type in ctx.Types)
                ValidateType(type, index, resolver, enumMembers, diagnostics);

            ValidateSpecs(ctx, index, resolver, enumMembers, diagnostics);
            ValidateServices(ctx, index, resolver, enumMembers, diagnostics);
            ValidatePolicies(ctx, index, resolver, enumMembers, diagnostics);
        }

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
        // Names reserved for built-in generics; a user type with one of these would be
        // shadowed by the built-in at resolution and silently mis-emit.
        var reserved = new HashSet<string>(StringComparer.Ordinal)
        {
            ModelIndex.ListTypeName, ModelIndex.SetTypeName, ModelIndex.MapTypeName, ModelIndex.RangeTypeName
        };

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ctx in model.Contexts)
            foreach (var type in Flatten(ctx))
            {
                if (reserved.Contains(type.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedTypeName,
                        $"'{type.Name}' is a reserved built-in generic name and cannot name a type", type.Span.Line, type.Span.Column));
                if (type is not AggregateDecl && !seen.Add(type.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateType, $"duplicate type '{type.Name}'", type.Span.Line, type.Span.Column));
            }

        // A service emits a class into the context namespace, so its name shares the
        // type namespace — a collision with a type (or another service) is a duplicate.
        foreach (var ctx in model.Contexts)
            foreach (var svc in ctx.Services)
                if (!seen.Add(svc.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateType,
                        $"service '{svc.Name}' collides with a type or service of the same name", svc.Span.Line, svc.Span.Column));
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
                ReportGeneratedMemberCollisions(v.Members, ValueObjectGeneratedMembers, "value object", diagnostics);
                ValidateMembersAndInvariants(v.Members, v.Invariants, index, resolver, enumMembers, diagnostics, SpecNames(index, v.Name));
                if (v.IsQuantity)
                    ValidateQuantity(v, index, diagnostics);
                break;
            case EntityDecl e:
                ValidateIdentityStrategy(e, diagnostics);
                ReportGeneratedMemberCollisions(e.Members, EntityGeneratedMembers, "entity", diagnostics);
                var entitySpecs = SpecNames(index, e.Name);
                ValidateMembersAndInvariants(e.Members, e.Invariants, index, resolver, enumMembers, diagnostics, entitySpecs);
                ValidateStates(e, index, resolver, enumMembers, diagnostics);
                // Events may be emitted only from a standalone entity or the aggregate root.
                var emitAllowed = aggregateRoot is null || aggregateRoot == e.Name;
                ValidateCommands(e, index, resolver, enumMembers, diagnostics, emitAllowed, entitySpecs);
                ValidateFactories(e, index, resolver, enumMembers, diagnostics, emitAllowed);
                break;
            case AggregateDecl agg:
                // The root must name an ENTITY declared inside the aggregate: a non-entity
                // root has no identity/repository, and would leave the Unit of Work
                // referencing an I<Root>Repository that is never emitted.
                var rootDecl = agg.Types.FirstOrDefault(t => t.Name == agg.RootName);
                if (rootDecl is null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownAggregateRoot,
                        $"unknown aggregate root '{agg.RootName}'", agg.Span.Line, agg.Span.Column));
                else if (rootDecl is not EntityDecl)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownAggregateRoot,
                        $"aggregate root '{agg.RootName}' must be an entity", agg.Span.Line, agg.Span.Column));
                foreach (var nested in agg.Types)
                    ValidateType(nested, index, resolver, enumMembers, diagnostics, agg.RootName);
                ValidateVersioning(agg, diagnostics);
                ValidateRepository(agg, index, diagnostics);
                break;
            case EnumDecl en:
                // Duplicate enum members produce uncompilable C#.
                var seenMembers = new HashSet<string>(StringComparer.Ordinal);
                foreach (var member in en.MemberNames)
                    if (!seenMembers.Add(member))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateEnumMember,
                            $"duplicate enum member '{member}'", en.Span.Line, en.Span.Column));
                ValidateEnumAssociatedData(en, index, diagnostics);
                break;
            case EventDecl ev:
                // Events are validated like value objects but carry no invariants.
                ValidateMembersAndInvariants(ev.Members, Array.Empty<Invariant>(), index, resolver, enumMembers, diagnostics);
                // An event is a record: the always-present `OccurredOn` metadata and the
                // record-synthesized members (Equals/GetHashCode/ToString/…) are reserved.
                foreach (var m in ev.Members)
                {
                    if (string.Equals(m.Name, "OccurredOn", StringComparison.OrdinalIgnoreCase))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedEventField,
                            $"event field '{m.Name}' collides with the reserved 'OccurredOn' metadata property",
                            m.Span.Line, m.Span.Column));
                    else if (IsReservedRecordMember(m.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                            $"event field '{m.Name}' collides with a record-synthesized member",
                            m.Span.Line, m.Span.Column));
                }
                break;
            case ReadModelDecl rm:
                ValidateReadModel(rm, index, resolver, enumMembers, diagnostics);
                break;
            case QueryDecl q:
                ValidateQuery(q, index, diagnostics);
                break;
        }
    }

    /// <summary>
    /// Validates a read model (R12.3): the source must be a declared value/entity;
    /// field names are unique; a direct field must name a source member; a derived
    /// field's projection must resolve over the source and produce a value assignable
    /// to its declared type.
    /// </summary>
    private static void ValidateReadModel(
        ReadModelDecl rm, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var sourceMembers = ReadModelSourceMembers(rm.SourceType, index);
        if (sourceMembers is null)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelUnknownSource,
                $"read model '{rm.Name}' projects from '{rm.SourceType}', which is not a declared value or entity type",
                rm.Span.Line, rm.Span.Column));
            return;
        }

        // Build defensively (last-wins): a source value object with duplicate members
        // (reported elsewhere as KOI0103) must not crash this loop.
        var memberByName = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach (var m in sourceMembers)
            memberByName[m.Name] = m;
        var sourceMemberNames = memberByName.Keys.ToArray();
        var scope = TypeScope.FromMembers(sourceMembers);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);
        // The record property a field emits to (R12.3): a positional record property is
        // PascalCased, so two fields differing only by their first-letter case collide.
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var field in rm.Fields)
        {
            if (!seen.Add(PropertyKey(field.Name)))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateReadModelField,
                    $"duplicate field '{field.Name}' in read model '{rm.Name}'", field.Span.Line, field.Span.Column));
            if (IsReservedRecordMember(field.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                    $"read-model field '{field.Name}' collides with a record-synthesized member", field.Span.Line, field.Span.Column));

            if (field.Projection is null)
            {
                // A direct field must name a member (or the synthetic `id`) of the source.
                if (!memberByName.ContainsKey(field.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelUnknownField,
                        $"read model '{rm.Name}' field '{field.Name}' is not a member of '{rm.SourceType}'{Suggestions.For(field.Name, sourceMemberNames)}",
                        field.Span.Line, field.Span.Column));
            }
            else
            {
                // A derived field: the projection resolves over the source; its declared
                // type must be known and accept the projected value.
                ValidateTypeRef(field.Type!, index, diagnostics);
                checker.Check(field.Projection, scope, field.Type);
                var inferred = resolver.Infer(field.Projection, scope);
                if (inferred is not null && index.IsKnownType(field.Type!.Name)
                    && !MemberAnalysis.IsAssignable(inferred, field.Type!))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelFieldTypeMismatch,
                        $"read model '{rm.Name}' field '{field.Name}' is declared '{field.Type!.Name}' but projects a '{inferred.Name}'",
                        field.Span.Line, field.Span.Column));
            }
        }
    }

    /// <summary>
    /// Validates a query (R12.4): criteria parameter types and names, and that the
    /// result is a declared read model or a <c>List</c> of one.
    /// </summary>
    private static void ValidateQuery(QueryDecl q, ModelIndex index, List<Diagnostic> diagnostics)
    {
        // Criteria become positional record properties (PascalCased), so dedup on the
        // emitted property key and reject names that collide with record members.
        var seenParams = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in q.Criteria)
        {
            ValidateTypeRef(p.Type, index, diagnostics);
            if (!seenParams.Add(PropertyKey(p.Name)))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                    $"duplicate criterion '{p.Name}' in query '{q.Name}'", p.Span.Line, p.Span.Column));
            if (IsReservedRecordMember(p.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                    $"query criterion '{p.Name}' collides with a record-synthesized member", p.Span.Line, p.Span.Column));
        }

        ValidateTypeRef(q.ResultType, index, diagnostics);
        var resultName = q.ResultType.Name == ModelIndex.ListTypeName
            ? q.ResultType.Element?.Name
            : q.ResultType.Name;
        if (resultName is not null && index.Classify(resultName) != TypeKind.ReadModel)
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QueryResultNotReadModel,
                $"query '{q.Name}' must return a read model or 'List<readmodel>', not '{q.ResultType.Name}'",
                q.Span.Line, q.Span.Column));
    }

    /// <summary>
    /// The members a read model can project from its source (entities add the synthetic
    /// <c>id</c>); <c>null</c> when the source is not a value/entity type.
    /// </summary>
    private static IReadOnlyList<Member>? ReadModelSourceMembers(string sourceType, ModelIndex index)
    {
        if (!index.TryGetDecl(sourceType, out var decl))
            return null;
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

    /// <summary>The C# property identifier a member name maps to (first char upper-cased), for collision checks.</summary>
    private static string PropertyKey(string name) =>
        name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];

    /// <summary>Members a positional <c>record</c> synthesizes; a field/criterion mapping to one fails to compile.</summary>
    private static readonly IReadOnlySet<string> RecordReservedMembers =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "Equals", "GetHashCode", "ToString", "GetType", "EqualityContract", "PrintMembers", "Deconstruct"
        };

    private static bool IsReservedRecordMember(string name) => RecordReservedMembers.Contains(PropertyKey(name));

    /// <summary>The spec names declared over <paramref name="typeName"/> (R10.1), or empty.</summary>
    private static IReadOnlySet<string> SpecNames(ModelIndex index, string typeName)
    {
        var specs = index.SpecsFor(typeName);
        return specs.Count == 0 ? EmptyNames : new HashSet<string>(specs.Keys, StringComparer.Ordinal);
    }

    private static readonly IReadOnlySet<string> EmptyNames = new HashSet<string>();

    private static void ValidateMembersAndInvariants(
        IReadOnlyList<Member> members,
        IReadOnlyList<Invariant> invariants,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        IReadOnlySet<string>? specNames = null)
    {
        var memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var scope = TypeScope.FromMembers(members);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics, specNames);

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
                    if (!en.MemberNames.Contains(enumDefault.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownEnumMemberForType,
                            $"unknown enum member '{enumDefault.Name}' for type '{m.Type.Name}'{Suggestions.For(enumDefault.Name, en.MemberNames)}",
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
        bool emitAllowed,
        IReadOnlySet<string>? specNames = null)
    {
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var memberByName = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach (var m in entity.Members)
            memberByName[m.Name] = m;

        // A command `requires` may reference a spec on the entity (R10.1).
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics, specNames);

        // Names are compared case-insensitively because both commands (methods) and
        // members (properties) emit Pascal/camel-cased C# identifiers; a clash there
        // produces uncompilable output (CS0102/CS0111).
        var seenCommands = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var propertyNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.OrdinalIgnoreCase)
        {
            "Id", "Equals", "GetHashCode"
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
    /// Validates an entity's factories: parameter type refs, <c>requires</c>
    /// preconditions, <c>field &lt;- value</c> initializations (target must be a
    /// settable, non-derived member; value must be type-compatible), and creation
    /// <c>emit</c>s. The expression scope is the factory's parameters plus the
    /// synthetic <c>id</c> (the auto-generated identity); entity members are NOT in
    /// scope because the aggregate does not exist until construction. A required
    /// member left uninitialized with no default is reported (R8.2).
    /// </summary>
    private static void ValidateFactories(
        EntityDecl entity,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        bool emitAllowed)
    {
        if (entity.Factories.Count == 0)
            return;

        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var memberByName = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach (var m in entity.Members)
            memberByName[m.Name] = m;

        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        // A factory emits a `public static` method; its name must not collide (case-
        // insensitively) with a property, a command (instance method), another factory,
        // or an always-generated member (Id, the domain-event API, the value-equality
        // members) — any of which would yield uncompilable C# (CS0102/CS0111).
        var reserved = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.OrdinalIgnoreCase)
        {
            "Id", "DomainEvents", "ClearDomainEvents", "Equals", "GetHashCode"
        };
        foreach (var cmd in entity.Commands)
            reserved.Add(cmd.Name);

        var seenFactories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var factory in entity.Factories)
        {
            if (!seenFactories.Add(factory.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateFactory,
                    $"factory '{factory.Name}' is declared more than once on '{entity.Name}'", factory.Span.Line, factory.Span.Column));
            else if (reserved.Contains(factory.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FactoryNameCollision,
                    $"factory '{factory.Name}' collides with a property or command of '{entity.Name}'", factory.Span.Line, factory.Span.Column));

            // Scope: the factory's parameters plus the synthetic `id` (its identity).
            var scopePairs = IdScopePair(entity)
                .Concat(factory.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
            var scope = new TypeScope(scopePairs);

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in factory.Parameters)
            {
                ValidateTypeRef(p.Type, index, diagnostics);
                if (!seenParams.Add(p.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                        $"duplicate parameter '{p.Name}' in factory '{factory.Name}'", p.Span.Line, p.Span.Column));
                // `id` is reserved for the auto-generated identity local; a parameter of
                // that name would collide with it in the emitted method (CS0136).
                if (string.Equals(p.Name, "id", StringComparison.OrdinalIgnoreCase))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedFactoryParameter,
                        $"factory parameter '{p.Name}' is reserved; the identity is generated automatically", p.Span.Line, p.Span.Column));
            }

            var initialized = new HashSet<string>(StringComparer.Ordinal);
            foreach (var stmt in factory.Body)
            {
                switch (stmt)
                {
                    case RequiresClause req:
                        checker.Check(req.Condition, scope);
                        break;

                    case Initialization init:
                        if (!memberByName.TryGetValue(init.Field, out var target))
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidInitializationTarget,
                                $"cannot initialize '{init.Field}': not a field of '{entity.Name}'", init.Span.Line, init.Span.Column));
                        else if (MemberAnalysis.IsDerived(target, memberNames))
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidInitializationTarget,
                                $"cannot initialize derived field '{init.Field}'", init.Span.Line, init.Span.Column));
                        else
                        {
                            if (!initialized.Add(init.Field))
                                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateInitialization,
                                    $"field '{init.Field}' is initialized more than once in factory '{factory.Name}'", init.Span.Line, init.Span.Column));
                            checker.CheckInitializationValue(init.Value, target.Type, init.Field, scope);
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

            // R8.2: a required member (no default, not optional, not derived) that the
            // factory neither explicitly initializes (`field <- expr`) nor supplies via
            // a same-named parameter (auto-bind) is constructed as `default!` — a latent
            // bug, so warn.
            foreach (var m in entity.Members)
                if (!MemberAnalysis.IsDerived(m, memberNames)
                    && m.Initializer is null && !m.Type.IsOptional
                    && !initialized.Contains(m.Name)
                    && !factory.Parameters.Any(p => MemberAnalysis.AutoBinds(p, m)))
                    diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.UninitializedFactoryField,
                        $"factory '{factory.Name}' leaves required field '{m.Name}' uninitialized and it has no default",
                        factory.Span.Line, factory.Span.Column));
        }
    }

    /// <summary>The synthetic <c>id</c> binding (an entity's identity) for factory scope.</summary>
    private static IEnumerable<KeyValuePair<string, TypeRef>> IdScopePair(EntityDecl entity) =>
        new[] { new KeyValuePair<string, TypeRef>("id", new TypeRef(entity.IdentityName)) };

    /// <summary>Members every generated entity carries; a member mapping to one fails to compile (CS0102).</summary>
    private static readonly IReadOnlySet<string> EntityGeneratedMembers =
        new HashSet<string>(StringComparer.Ordinal) { "Id", "Equals", "GetHashCode" };

    /// <summary>
    /// Members every generated value object carries: the identity-equality
    /// <c>Equals</c>/<c>GetHashCode</c> (from the <c>ValueObject</c> base) and the
    /// overridden <c>GetEqualityComponents</c>.
    /// </summary>
    private static readonly IReadOnlySet<string> ValueObjectGeneratedMembers =
        new HashSet<string>(StringComparer.Ordinal) { "Equals", "GetHashCode", "GetEqualityComponents" };

    /// <summary>
    /// Rejects a member whose emitted property name collides with a member the emitted
    /// class always generates (e.g. an entity's <c>id</c> field becoming a second
    /// <c>Id</c> property, CS0102; a value object's <c>equals</c> field shadowing
    /// <c>ValueObject.Equals</c>). The conditional <c>Version</c> token is covered by
    /// <see cref="ValidateVersioning"/>.
    /// </summary>
    private static void ReportGeneratedMemberCollisions(
        IReadOnlyList<Member> members, IReadOnlySet<string> generated, string kind, List<Diagnostic> diagnostics)
    {
        foreach (var m in members)
            if (generated.Contains(PropertyKey(m.Name)))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedGeneratedMember,
                    $"{kind} member '{m.Name}' collides with the generated '{PropertyKey(m.Name)}' member",
                    m.Span.Line, m.Span.Column));
    }

    /// <summary>
    /// Validates an entity's identity strategy (R11.1): a <c>natural(T)</c> key must
    /// wrap a supported primitive (<c>String</c> or <c>Int</c>). Guid and sequence
    /// strategies carry no backing type and need no check.
    /// </summary>
    private static void ValidateIdentityStrategy(EntityDecl entity, List<Diagnostic> diagnostics)
    {
        if (entity.IdStrategy != IdentityStrategy.Natural)
            return;
        if (entity.IdBackingType is not ("String" or "Int"))
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NaturalIdBackingType,
                $"natural identity '{entity.IdentityName}' must wrap String or Int, not '{entity.IdBackingType}'",
                entity.Span.Line, entity.Span.Column));
    }

    /// <summary>
    /// Validates a versioned aggregate (R11.4): the generated root carries a synthetic
    /// <c>Version</c> token, so the root entity must not declare a member that collides
    /// with it (which would emit a duplicate property, CS0102).
    /// </summary>
    private static void ValidateVersioning(AggregateDecl agg, List<Diagnostic> diagnostics)
    {
        if (!agg.IsVersioned)
            return;
        var root = agg.Types.OfType<EntityDecl>().FirstOrDefault(e => e.Name == agg.RootName);
        if (root is null)
            return;
        foreach (var m in root.Members)
            if (string.Equals(m.Name, "Version", StringComparison.OrdinalIgnoreCase))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedVersionMember,
                    $"member '{m.Name}' collides with the generated 'Version' token of versioned aggregate '{agg.Name}'",
                    m.Span.Line, m.Span.Column));
    }

    /// <summary>The operation keywords a <c>repository</c> block may list (R11.3).</summary>
    private static readonly IReadOnlySet<string> ValidRepositoryOps =
        new HashSet<string>(StringComparer.Ordinal) { "getById", "add", "update", "remove" };

    /// <summary>
    /// Validates an aggregate's repository declaration (R11.3): every listed
    /// operation keyword is known; finder names are unique; finder parameters are
    /// well-typed with distinct names; and each finder's result type is the
    /// aggregate root or a <c>List</c> of it.
    /// </summary>
    private static void ValidateRepository(AggregateDecl agg, ModelIndex index, List<Diagnostic> diagnostics)
    {
        if (agg.Repository is not { } repo)
            return;

        if (repo.Operations is not null)
            foreach (var op in repo.Operations)
                if (!ValidRepositoryOps.Contains(op))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownRepositoryOperation,
                        $"unknown repository operation '{op}' (expected: getById, add, update, remove)",
                        agg.Span.Line, agg.Span.Column));

        var seenFinders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var finder in repo.Finders)
        {
            if (!seenFinders.Add(finder.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateFinder,
                    $"finder '{finder.Name}' is declared more than once in the repository of '{agg.Name}'",
                    finder.Span.Line, finder.Span.Column));
            // A finder emits `<Name>Async`; a name that resolves to a built-in operation
            // method would declare a duplicate (or confusingly-overloaded) member.
            else if (ValidRepositoryOps.Any(op => string.Equals(op, finder.Name, StringComparison.OrdinalIgnoreCase)))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FinderNameCollision,
                    $"finder '{finder.Name}' collides with the built-in repository operation of the same name",
                    finder.Span.Line, finder.Span.Column));

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in finder.Parameters)
            {
                ValidateTypeRef(p.Type, index, diagnostics);
                if (!seenParams.Add(p.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                        $"duplicate parameter '{p.Name}' in finder '{finder.Name}'", p.Span.Line, p.Span.Column));
                // `ct` is reserved for the generated CancellationToken on every finder method.
                if (string.Equals(p.Name, "ct", StringComparison.OrdinalIgnoreCase))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedFinderParameter,
                        $"finder parameter '{p.Name}' is reserved; it collides with the generated cancellation token",
                        p.Span.Line, p.Span.Column));
            }

            // The result is a single root or a List<root>; anything else can't be a
            // well-typed lookup over this aggregate.
            ValidateTypeRef(finder.ResultType, index, diagnostics);
            var elementName = CSharpListElement(finder.ResultType);
            if (elementName != agg.RootName)
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FinderResultType,
                    $"finder '{finder.Name}' must return '{agg.RootName}' or 'List<{agg.RootName}>', not '{finder.ResultType.Name}'",
                    finder.Span.Line, finder.Span.Column));
        }
    }

    /// <summary>
    /// The root-type name a finder result denotes: the element of a <c>List&lt;T&gt;</c>,
    /// or the type itself when it is a bare single result.
    /// </summary>
    private static string CSharpListElement(TypeRef result) =>
        result.Name == ModelIndex.ListTypeName ? result.Element?.Name ?? "" : result.Name;

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
                ? new HashSet<string>(en.MemberNames, StringComparer.Ordinal)
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

    // ------------------------------------------------------------------------
    // R10 — specifications, services, policies
    // ------------------------------------------------------------------------

    /// <summary>
    /// Validates specifications (R10.1): each target must be a value/entity; the
    /// condition must be boolean and reference only the target's members + sibling
    /// specs; names are unique and don't collide with a member; and specs must not
    /// form a reference cycle.
    /// </summary>
    private static void ValidateSpecs(
        ContextNode ctx, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var specs = ctx.Specs.Concat(ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs)).ToList();
        if (specs.Count == 0)
            return;

        foreach (var group in specs.GroupBy(s => s.TargetType, StringComparer.Ordinal))
        {
            var target = group.Key;
            var specList = group.ToList();
            var specNames = new HashSet<string>(specList.Select(s => s.Name), StringComparer.Ordinal);

            IReadOnlyList<Member>? members = index.TryGetDecl(target, out var decl)
                ? decl switch { ValueObjectDecl v => v.Members, EntityDecl e => e.Members, _ => null }
                : null;

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var memberNames = members is null
                ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                : new HashSet<string>(members.Select(m => m.Name), StringComparer.OrdinalIgnoreCase);

            foreach (var spec in specList)
            {
                if (members is null)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecUnknownTarget,
                        $"spec '{spec.Name}' targets '{target}', which is not a declared value or entity type", spec.Span.Line, spec.Span.Column));
                    continue;
                }

                if (!seen.Add(spec.Name) || memberNames.Contains(spec.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateSpec,
                        $"spec '{spec.Name}' duplicates another spec or a member of '{target}'", spec.Span.Line, spec.Span.Column));

                var scope = TypeScope.FromMembers(members);
                var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics, specNames);
                checker.Check(spec.Condition, scope);

                var inferred = resolver.Infer(spec.Condition, scope);
                if (inferred is not null && inferred.Name != "Bool")
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecNotBoolean,
                        $"spec '{spec.Name}' condition must be boolean, but is '{inferred.Name}'", spec.Span.Line, spec.Span.Column));
            }

            if (members is not null)
                DetectSpecCycles(specList, specNames, diagnostics);
        }
    }

    /// <summary>Reports every spec that participates in a reference cycle (incl. self-reference).</summary>
    private static void DetectSpecCycles(IReadOnlyList<SpecDecl> specs, IReadOnlySet<string> specNames, List<Diagnostic> diagnostics)
    {
        var deps = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var s in specs)
            deps[s.Name] = MemberAnalysis.ReferencedIdentifiers(s.Condition)
                .Where(specNames.Contains).Distinct(StringComparer.Ordinal).ToList();

        var state = new Dictionary<string, int>(StringComparer.Ordinal); // 0 unvisited, 1 visiting, 2 done
        var stack = new List<string>();
        var onCycle = new HashSet<string>(StringComparer.Ordinal);

        void Dfs(string node)
        {
            state[node] = 1;
            stack.Add(node);
            foreach (var dep in deps.GetValueOrDefault(node, new List<string>()))
            {
                var st = state.GetValueOrDefault(dep, 0);
                if (st == 0)
                    Dfs(dep);
                else if (st == 1)
                    for (var i = stack.IndexOf(dep); i >= 0 && i < stack.Count; i++)
                        onCycle.Add(stack[i]);
            }
            stack.RemoveAt(stack.Count - 1);
            state[node] = 2;
        }

        foreach (var s in specs)
            if (!state.ContainsKey(s.Name))
                Dfs(s.Name);

        foreach (var s in specs)
            if (onCycle.Contains(s.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecCycle,
                    $"spec '{s.Name}' is part of a reference cycle", s.Span.Line, s.Span.Column));
    }

    /// <summary>
    /// Validates domain services (R10.2): unique service/operation names, valid
    /// parameter and return type refs, and that a pure operation body is assignable
    /// to its declared return type. A bodyless operation is a seam (no body check).
    /// </summary>
    private static void ValidateServices(
        ContextNode ctx, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var seenServices = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        foreach (var svc in ctx.Services)
        {
            if (!seenServices.Add(svc.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateService,
                    $"service '{svc.Name}' is declared more than once", svc.Span.Line, svc.Span.Column));

            var seenOps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var op in svc.Operations)
            {
                if (!seenOps.Add(op.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateOperation,
                        $"operation '{op.Name}' is declared more than once in service '{svc.Name}'", op.Span.Line, op.Span.Column));
                // A method cannot share its enclosing class's name (CS0542).
                else if (string.Equals(op.Name, svc.Name, StringComparison.OrdinalIgnoreCase))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateOperation,
                        $"operation '{op.Name}' collides with its service's name '{svc.Name}'", op.Span.Line, op.Span.Column));

                ValidateTypeRef(op.ReturnType, index, diagnostics);

                var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var p in op.Parameters)
                {
                    ValidateTypeRef(p.Type, index, diagnostics);
                    if (!seenParams.Add(p.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                            $"duplicate parameter '{p.Name}' in operation '{op.Name}'", p.Span.Line, p.Span.Column));
                }

                if (op.Body is not null)
                {
                    var scope = new TypeScope(op.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
                    checker.CheckOperationReturn(op.Body, op.ReturnType, scope);
                }
            }

            // Application use cases (R12.2): unique names (they emit interface methods),
            // valid parameter and return type refs.
            var seenUseCases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var uc in svc.UseCases)
            {
                if (!seenUseCases.Add(uc.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateUseCase,
                        $"use case '{uc.Name}' is declared more than once in service '{svc.Name}'", uc.Span.Line, uc.Span.Column));

                if (uc.ReturnType is not null)
                    ValidateTypeRef(uc.ReturnType, index, diagnostics);

                var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var p in uc.Parameters)
                {
                    ValidateTypeRef(p.Type, index, diagnostics);
                    if (!seenParams.Add(p.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                            $"duplicate parameter '{p.Name}' in use case '{uc.Name}'", p.Span.Line, p.Span.Column));
                }
            }
        }
    }

    /// <summary>
    /// Validates policies (R10.3): the <c>when</c> event and the <c>then</c> target
    /// command must resolve, and the reaction arguments must match the command's
    /// parameters with values drawn from the event's fields.
    /// </summary>
    private static void ValidatePolicies(
        ContextNode ctx, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var seenPolicies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var policy in ctx.Policies)
        {
            if (!seenPolicies.Add(policy.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicatePolicy,
                    $"policy '{policy.Name}' is declared more than once", policy.Span.Line, policy.Span.Column));

            var ev = index.TryGetDecl(policy.EventName, out var ed) && ed is EventDecl e ? e : null;
            if (ev is null)
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownEvent,
                    $"policy '{policy.Name}' reacts to '{policy.EventName}', which is not a declared event", policy.Span.Line, policy.Span.Column));

            var reaction = policy.Reaction;
            var targetRoot = ResolveTargetRoot(reaction.TargetType, index);
            if (targetRoot is null)
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownTarget,
                    $"policy '{policy.Name}' targets '{reaction.TargetType}', which is not a declared aggregate or entity", reaction.Span.Line, reaction.Span.Column));

            var cmd = targetRoot?.Commands.FirstOrDefault(c => string.Equals(c.Name, reaction.CommandName, StringComparison.OrdinalIgnoreCase));
            if (targetRoot is not null && cmd is null)
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownCommand,
                    $"'{reaction.TargetType}' has no command '{reaction.CommandName}'", reaction.Span.Line, reaction.Span.Column));

            // Reaction argument values resolve against the event's fields.
            var eventScope = ev is not null ? TypeScope.FromMembers(ev.Members) : new TypeScope(Array.Empty<KeyValuePair<string, TypeRef>>());
            var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);
            var cmdParams = cmd?.Parameters.ToDictionary(p => p.Name, p => p.Type, StringComparer.Ordinal);
            var provided = new HashSet<string>(StringComparer.Ordinal);

            foreach (var arg in reaction.Args)
            {
                if (ev is not null)
                    checker.Check(arg.Value, eventScope);

                if (cmdParams is null)
                    continue;

                if (!provided.Add(arg.Parameter))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                        $"duplicate argument '{arg.Parameter}' in policy '{policy.Name}'", arg.Span.Line, arg.Span.Column));

                if (!cmdParams.TryGetValue(arg.Parameter, out var paramType))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                        $"command '{reaction.CommandName}' has no parameter '{arg.Parameter}'", arg.Span.Line, arg.Span.Column));
                }
                else if (ev is not null)
                {
                    var valueType = resolver.Infer(arg.Value, eventScope);
                    if (valueType is not null && !MemberAnalysis.IsAssignable(valueType, paramType))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgType,
                            $"argument '{arg.Parameter}' expects '{paramType.Name}', but the value is '{valueType.Name}'", arg.Span.Line, arg.Span.Column));
                }
            }

            if (cmdParams is not null)
                foreach (var p in cmd!.Parameters)
                    if (!provided.Contains(p.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                            $"policy '{policy.Name}' is missing argument '{p.Name}'", reaction.Span.Line, reaction.Span.Column));
        }
    }

    /// <summary>The root entity of a policy target (an aggregate's root, or the entity itself).</summary>
    private static EntityDecl? ResolveTargetRoot(string targetType, ModelIndex index)
    {
        if (!index.TryGetDecl(targetType, out var decl))
            return null;
        return decl switch
        {
            EntityDecl e => e,
            AggregateDecl agg => agg.Types.OfType<EntityDecl>().FirstOrDefault(en => en.Name == agg.RootName),
            _ => null
        };
    }

    /// <summary>
    /// Validates a quantity (R9.2): it must declare exactly one non-derived numeric
    /// amount member and exactly one enum-typed unit member, and nothing else, so the
    /// generated unit-checked arithmetic is well-defined.
    /// </summary>
    private static void ValidateQuantity(ValueObjectDecl q, ModelIndex index, List<Diagnostic> diagnostics)
    {
        var memberNames = new HashSet<string>(q.Members.Select(m => m.Name), StringComparer.Ordinal);

        // The amount is a non-optional Decimal: this keeps scalar */÷ exact (an Int amount
        // would silently integer-divide / truncate when scaled by a fraction).
        bool IsAmount(Member m) => m.Type.Name == "Decimal" && !m.Type.IsOptional
            && !MemberAnalysis.IsDerived(m, memberNames);
        bool IsUnit(Member m) => index.Classify(m.Type.Name) == TypeKind.Enum && !m.Type.IsOptional
            && !MemberAnalysis.IsDerived(m, memberNames);

        var amountCount = q.Members.Count(IsAmount);
        var unitCount = q.Members.Count(IsUnit);

        if (unitCount != 1)
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityUnitCardinality,
                $"quantity '{q.Name}' must declare exactly one enum-typed unit member, found {unitCount}", q.Span.Line, q.Span.Column));
        if (amountCount != 1)
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityAmountCardinality,
                $"quantity '{q.Name}' must declare exactly one Decimal amount member, found {amountCount}", q.Span.Line, q.Span.Column));

        // Only the amount and unit are restricted; derived/computed projections are fine.
        foreach (var m in q.Members)
            if (!MemberAnalysis.IsDerived(m, memberNames) && !IsAmount(m) && !IsUnit(m))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityMemberNotAllowed,
                    $"quantity '{q.Name}' may declare only its amount and unit members (plus derived projections); '{m.Name}' is not allowed",
                    m.Span.Line, m.Span.Column));
    }

    /// <summary>
    /// Validates an enum's associated-data signature (R9.1): signature field types
    /// and uniqueness, reserved-name collisions with generated smart-enum members,
    /// per-member arity against the signature, and that each member value is a literal
    /// of a compatible type.
    /// </summary>
    private static void ValidateEnumAssociatedData(EnumDecl en, ModelIndex index, List<Diagnostic> diagnostics)
    {
        var sig = en.Signature;

        var seenFields = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Names generated on every smart enum; an associated field of these would clash.
        var reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Name", "Value", "All", "FromName", "FromValue", "ToString", "Equals", "GetHashCode"
        };
        foreach (var p in sig)
        {
            ValidateTypeRef(p.Type, index, diagnostics);
            if (!seenFields.Add(p.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                    $"duplicate associated-data field '{p.Name}' in enum '{en.Name}'", p.Span.Line, p.Span.Column));
            if (reserved.Contains(p.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumReservedAssociatedField,
                    $"associated-data field '{p.Name}' collides with a generated smart-enum member", p.Span.Line, p.Span.Column));
            // Associated values are literals, so the field must be a literal-expressible
            // primitive (v0: String/Int/Decimal/Bool) — not a collection, value, or enum.
            if (!IsLiteralFieldType(p.Type))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumAssociatedFieldType,
                    $"enum '{en.Name}' associated-data field '{p.Name}' must be String, Int, Decimal, or Bool", p.Span.Line, p.Span.Column));
        }

        foreach (var member in en.Members)
        {
            if (member.Args.Count != sig.Count)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberArity,
                    sig.Count == 0
                        ? $"enum '{en.Name}' has no associated-data signature but member '{member.Name}' supplies {member.Args.Count} value(s)"
                        : $"enum member '{member.Name}' supplies {member.Args.Count} value(s) but '{en.Name}' declares {sig.Count} field(s)",
                    member.Span.Line, member.Span.Column));
                continue; // arity mismatch: per-arg type checks would be noise
            }

            // Only check values for fields with a valid literal type (an invalid field
            // type is already reported above; per-member checks would just be noise).
            for (var i = 0; i < sig.Count; i++)
                if (IsLiteralFieldType(sig[i].Type))
                    CheckEnumArg(member.Args[i], sig[i].Type, en.Name, sig[i].Name, diagnostics);
        }
    }

    /// <summary>The primitive types that can carry a literal associated value (R9.1).</summary>
    private static bool IsLiteralFieldType(TypeRef t) =>
        !t.IsOptional && t.Element is null && t.Name is "String" or "Bool" or "Int" or "Decimal";

    /// <summary>Checks a single enum associated value is a (possibly negated) literal of a compatible type.</summary>
    private static void CheckEnumArg(Expr arg, TypeRef expected, string enumName, string field, List<Diagnostic> diagnostics)
    {
        // A negative number parses as `-` applied to a numeric literal; accept it.
        var (lit, negated) = arg switch
        {
            LiteralExpr l => (l, false),
            UnaryExpr { Op: UnaryOp.Negate, Operand: LiteralExpr l } => (l, true),
            _ => (null, false)
        };

        if (lit is null || (negated && lit.Kind is not (LiteralKind.Int or LiteralKind.Decimal)))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberArgType,
                $"enum '{enumName}' associated value for '{field}' must be a literal", arg.Span.Line, arg.Span.Column));
            return;
        }

        var ok = expected.Name switch
        {
            "String" => lit.Kind == LiteralKind.String,
            "Bool" => lit.Kind == LiteralKind.Bool,
            "Int" => lit.Kind == LiteralKind.Int,
            "Decimal" => lit.Kind is LiteralKind.Int or LiteralKind.Decimal, // Int widens to Decimal
            _ => false
        };
        if (!ok)
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberArgType,
                $"enum '{enumName}' field '{field}' expects '{expected.Name}', but got a {lit.Kind.ToString().ToLowerInvariant()} literal",
                arg.Span.Line, arg.Span.Column));
    }

    private static void ValidateTypeRef(TypeRef type, ModelIndex index, List<Diagnostic> diagnostics)
    {
        if (!index.IsKnownType(type.Name))
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownType,
                $"unknown type '{type.Name}'{Suggestions.For(type.Name, index.CandidateTypeNames)}",
                type.Span.Line, type.Span.Column));

        // Generic arity: List/Set/Range take one type argument; Map takes two.
        switch (index.Classify(type.Name))
        {
            case TypeKind.List or TypeKind.Set or TypeKind.Range:
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

        // A Range is ordered, so its element must be an orderable type (Int/Decimal/Instant).
        // Only flag a KNOWN non-orderable element; an unknown element is already KOI0101.
        if (index.Classify(type.Name) == TypeKind.Range && type.Element is not null
            && index.IsKnownType(type.Element.Name) && !BuiltinOps.IsOrderable(type.Element.Name))
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.RangeNotOrderable,
                $"range element type '{type.Element.Name}' is not orderable; ranges require Int, Decimal, or Instant",
                type.Element.Span.Line, type.Element.Span.Column));

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
                foreach (var member in e.MemberNames)
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
