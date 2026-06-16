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
        var enumMembers = CollectEnumMembers(model);
        var diagnostics = new List<Diagnostic>();

        ValidateUniqueTypeNames(model, diagnostics);

        // The context map is model-scoped (R14.1/R14.2): validate it once before the per-context loop.
        if (model.ContextMap is { } map)
            ContextMapValidator.Validate(map, index, diagnostics);

        foreach (var ctx in model.Contexts)
        {
            // A per-context resolver so a type name shared across contexts (R13.2) resolves
            // to THIS context's declaration when checking member access.
            var resolver = new TypeResolver(index, ctx.Name);

            ValidateContextScoping(ctx, index, diagnostics);
            ValidateAnnotationVersions(ctx, diagnostics);

            foreach (var type in ctx.Types)
                ValidateType(type, index, resolver, enumMembers, diagnostics);

            ValidateSpecs(ctx, index, resolver, enumMembers, diagnostics);
            ValidateServices(ctx, index, resolver, enumMembers, diagnostics);
            ValidatePolicies(ctx, index, resolver, enumMembers, diagnostics);
            IntegrationEventValidator.Validate(ctx, index, model.ContextMap is not null, diagnostics);
        }

        return diagnostics;
    }

    /// <summary>
    /// R15.1: warns (KOI1501) when a <c>@since(n)</c> annotation on a type or field names a
    /// generation newer than the context's own declared <c>version</c> — an evolution mistake.
    /// No-op for an unversioned context (no ceiling to exceed).
    /// </summary>
    private static void ValidateAnnotationVersions(ContextNode ctx, List<Diagnostic> diagnostics)
    {
        if (ctx.Version is not { } ceiling)
            return;

        foreach (var type in ctx.Types)
            ValidateAnnotationVersionsOfType(type, ctx.Name, ceiling, diagnostics);
    }

    private static void ValidateAnnotationVersionsOfType(
        TypeDecl type, string contextName, int ceiling, List<Diagnostic> diagnostics)
    {
        if (type.Since is { } typeSince && typeSince > ceiling)
            diagnostics.Add(Diagnostic.Warning(
                DiagnosticCodes.AnnotationVersionAboveContext,
                $"'{type.Name}' is annotated @since({typeSince}) but context '{contextName}' is only version {ceiling}.",
                type.Span));

        foreach (var m in AnnotatableMembers(type))
            if (m.Since is { } memberSince && memberSince > ceiling)
                diagnostics.Add(Diagnostic.Warning(
                    DiagnosticCodes.AnnotationVersionAboveContext,
                    $"Field '{m.Name}' is annotated @since({memberSince}) but context '{contextName}' is only version {ceiling}.",
                    m.Span));

        if (type is AggregateDecl agg)
            foreach (var nested in agg.Types)
                ValidateAnnotationVersionsOfType(nested, contextName, ceiling, diagnostics);
    }

    /// <summary>The member-bearing fields of a type (value/entity/event/integration event); empty otherwise.</summary>
    private static IReadOnlyList<Member> AnnotatableMembers(TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => Array.Empty<Member>()
    };

    /// <summary>
    /// Validates a context's imports, module names, and cross-context references (R13.2/R13.3):
    /// imports must name a declared context and an exported type; module names must not collide
    /// with a type; and every type reference must resolve in this context's scope (local, the
    /// <c>*Id</c> convention, an import, or a qualifier) — an un-imported or ambiguous foreign
    /// reference is a coded error.
    /// </summary>
    private static void ValidateContextScoping(ContextNode ctx, ModelIndex index, List<Diagnostic> diagnostics)
    {
        // 1. Imports resolve to a declared context and (for named imports) exported types.
        foreach (var imp in ctx.Imports)
        {
            if (!index.IsContext(imp.Context))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownContext,
                    $"import of unknown context '{imp.Context}'", imp.Span));
                continue;
            }
            foreach (var name in imp.Names)
                if (!index.DeclaresType(imp.Context, name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NotExported,
                        $"context '{imp.Context}' does not declare '{name}'", imp.Span));
        }

        // 2. A module name must not collide with a type name in the same context.
        if (ctx.ModuleNames.Count > 0)
        {
            var typeNames = new HashSet<string>(ctx.AllTypeDecls().Select(t => t.Name), StringComparer.Ordinal);
            foreach (var module in ctx.ModuleNames)
                if (typeNames.Contains(module))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ModuleNameCollision,
                        $"module '{module}' collides with a type of the same name in context '{ctx.Name}'",
                        ctx.Span));
        }

        // 3. Every referenced type resolves in this context's scope.
        foreach (var tr in ModelIndex.AllTypeRefsIn(ctx))
            ValidateReference(ctx.Name, tr, index, diagnostics);
    }

    /// <summary>Resolves a type reference (and its generic arguments) against a context's scope.</summary>
    private static void ValidateReference(string fromContext, TypeRef tr, ModelIndex index, List<Diagnostic> diagnostics)
    {
        var r = index.ResolveReference(fromContext, tr);
        switch (r.Kind)
        {
            case ModelIndex.RefKind.UnimportedCrossContext:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnimportedReference,
                    $"'{tr.Name}' is owned by context '{string.Join("', '", r.Candidates)}'; import it ('import {r.Candidates[0]}.{{ {tr.Name} }}') or qualify it ('{r.Candidates[0]}.{tr.Name}')",
                    tr.Span));
                break;
            case ModelIndex.RefKind.Ambiguous:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.AmbiguousReference,
                    $"'{tr.Name}' is ambiguous between contexts '{string.Join("', '", r.Candidates)}'; qualify it (e.g. '{r.Candidates[0]}.{tr.Name}')",
                    tr.Span));
                break;
            case ModelIndex.RefKind.UnknownContext:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownContext,
                    $"qualified reference to unknown context '{r.Candidates[0]}'", tr.Span));
                break;
            case ModelIndex.RefKind.NotExported:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NotExported,
                    $"context '{r.Candidates[0]}' does not declare '{tr.Name}'", tr.Span));
                break;
        }

        // An anti-corruption-layer downstream should translate upstream types, not reference them
        // directly. A direct, unqualified reference that actually binds to an ACL upstream type is a
        // code-smell warning (R14.1). It only fires when the reference truly resolves to the ACL
        // upstream — not when a same-named type is imported from, or shared with, a different context.
        if (tr.Qualifier is null
            && !index.DeclaresType(fromContext, tr.Name)
            && !index.IsKernelVisibleFrom(fromContext, tr.Name))
        {
            var importOwners = index.ImportOwnersOf(fromContext, tr.Name);
            var owners = index.DeclaringContextsOf(tr.Name).Where(c => c != fromContext).ToList();
            // If a NON-ACL permit relation (open-host/conformist/…) makes a same-named type visible,
            // the reference binds there, not to the ACL upstream — no direct-reference warning.
            var permittedElsewhere = owners.Any(o => !index.HasAclRelation(o, fromContext) && index.MapPermitsReference(fromContext, o));
            foreach (var up in owners)
            {
                // If the name is imported from a single owner that is not this upstream, it binds there.
                if (importOwners.Count == 1 && importOwners[0] != up)
                    continue;
                if (permittedElsewhere)
                    continue;
                if (index.HasAclRelation(up, fromContext))
                {
                    diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.AclDirectUpstreamReference,
                        $"'{tr.Name}' is an upstream type of anti-corruption-layer '{up}' -> '{fromContext}'; translate it via the generated I{up}To{fromContext}Translator instead of referencing it directly",
                        tr.Span));
                    break;
                }
            }
        }

        if (tr.Element is not null)
            ValidateReference(fromContext, tr.Element, index, diagnostics);
        if (tr.Value is not null)
            ValidateReference(fromContext, tr.Value, index, diagnostics);
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

        // Uniqueness is now PER CONTEXT (R13.2): two bounded contexts may each declare a
        // `Money`; only a name duplicated within one context is a collision.
        foreach (var ctx in model.Contexts)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var type in ctx.AllTypeDecls())
            {
                if (reserved.Contains(type.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedTypeName,
                        $"'{type.Name}' is a reserved built-in generic name and cannot name a type", type.Span));
                if (type is not AggregateDecl && !seen.Add(type.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateType, $"duplicate type '{type.Name}'", type.Span));
            }

            // A service emits a class into the context namespace, so its name shares the
            // type namespace — a collision with a type (or another service) is a duplicate.
            foreach (var svc in ctx.Services)
                if (!seen.Add(svc.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateType,
                        $"service '{svc.Name}' collides with a type or service of the same name", svc.Span));
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
                EntityBehaviorValidator.ValidateIdentityStrategy(e, diagnostics);
                ReportGeneratedMemberCollisions(e.Members, EntityGeneratedMembers, "entity", diagnostics);
                var entitySpecs = SpecNames(index, e.Name);
                ValidateMembersAndInvariants(e.Members, e.Invariants, index, resolver, enumMembers, diagnostics, entitySpecs);
                EntityBehaviorValidator.ValidateStates(e, index, resolver, enumMembers, diagnostics);
                // Events may be emitted only from a standalone entity or the aggregate root.
                var emitAllowed = aggregateRoot is null || aggregateRoot == e.Name;
                EntityBehaviorValidator.ValidateCommands(e, index, resolver, enumMembers, diagnostics, emitAllowed, entitySpecs);
                EntityBehaviorValidator.ValidateFactories(e, index, resolver, enumMembers, diagnostics, emitAllowed);
                break;
            case AggregateDecl agg:
                // The root must name an ENTITY declared inside the aggregate: a non-entity
                // root has no identity/repository, and would leave the Unit of Work
                // referencing an I<Root>Repository that is never emitted.
                var rootDecl = agg.Types.FirstOrDefault(t => t.Name == agg.RootName);
                if (rootDecl is null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownAggregateRoot,
                        $"unknown aggregate root '{agg.RootName}'", agg.Span));
                else if (rootDecl is not EntityDecl)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownAggregateRoot,
                        $"aggregate root '{agg.RootName}' must be an entity", agg.Span));
                foreach (var nested in agg.Types)
                    ValidateType(nested, index, resolver, enumMembers, diagnostics, agg.RootName);
                EntityBehaviorValidator.ValidateVersioning(agg, diagnostics);
                EntityBehaviorValidator.ValidateRepository(agg, index, diagnostics);
                break;
            case EnumDecl en:
                // Duplicate enum members produce uncompilable C#.
                var seenMembers = new HashSet<string>(StringComparer.Ordinal);
                // Each member also becomes a camelCase delegate parameter on the generated
                // Match/Switch; two members differing only by leading-char case (Foo/foo)
                // collapse to one parameter, so guard that collision here too.
                var seenCamel = new HashSet<string>(StringComparer.Ordinal);
                foreach (var member in en.MemberNames)
                {
                    if (!seenMembers.Add(member))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateEnumMember,
                            $"duplicate enum member '{member}'", en.Span));
                    else if (GeneratedEnumMembers.Contains(member))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedEnumMember,
                            $"enum member '{member}' collides with a generated smart-enum member", en.Span));
                    if (member.Length > 0 && !seenCamel.Add(char.ToLowerInvariant(member[0]) + member[1..]))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberCamelCaseCollision,
                            $"enum member '{member}' differs from another only by leading-character case and would collapse to one Match/Switch parameter", en.Span));
                }
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
                            m.Span));
                    else if (IsReservedRecordMember(m.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                            $"event field '{m.Name}' collides with a record-synthesized member",
                            m.Span));
                }
                break;
            case ReadModelDecl rm:
                CqrsValidator.ValidateReadModel(rm, index, resolver, enumMembers, diagnostics);
                break;
            case QueryDecl q:
                CqrsValidator.ValidateQuery(q, index, diagnostics);
                break;
        }
    }

    /// <summary>The C# property identifier a member name maps to (first char upper-cased), for collision checks.</summary>
    internal static string PropertyKey(string name) =>
        name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];

    /// <summary>
    /// Identifiers generated on every smart-enum class. A member named exactly one of these
    /// would clash with the generated property/method of the same name (C# is case-sensitive,
    /// so the collision is on the exact identifier).
    /// </summary>
    private static readonly IReadOnlySet<string> GeneratedEnumMembers =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "Name", "Value", "All", "FromName", "FromValue", "TryFromName", "TryFromValue",
            "Match", "Switch", "ToString", "Equals", "GetHashCode"
        };

    /// <summary>Members a positional <c>record</c> synthesizes; a field/criterion mapping to one fails to compile.</summary>
    private static readonly IReadOnlySet<string> RecordReservedMembers =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "Equals", "GetHashCode", "ToString", "GetType", "EqualityContract", "PrintMembers", "Deconstruct"
        };

    internal static bool IsReservedRecordMember(string name) => RecordReservedMembers.Contains(PropertyKey(name));

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
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateMember, $"duplicate member '{m.Name}'", m.Span));

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
                            enumDefault.Span));
                }
                else
                {
                    checker.Check(m.Initializer, scope, m.Type);

                    // A nullary builtin like `now` is non-deterministic, so it cannot be a
                    // STORED default (a derived/computed field re-evaluating it is fine).
                    if (!MemberAnalysis.IsDerived(m, memberNames))
                    {
                        var referenced = new HashSet<string>(
                            MemberAnalysis.ReferencedIdentifiers(m.Initializer), StringComparer.Ordinal);
                        var nondeterministic = BuiltinOps.NullaryValueOps.Keys.FirstOrDefault(referenced.Contains);
                        if (nondeterministic is not null)
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NowAsStoredDefault,
                                $"'{nondeterministic}' cannot be used as a stored default for '{m.Name}'",
                                m.Span));
                    }

                    // An optional value can't initialize a non-optional field without a fallback.
                    var initType = resolver.Infer(m.Initializer, scope);
                    if (initType is { IsOptional: true } && !m.Type.IsOptional)
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.OptionalAssignedToNonOptional,
                            $"optional value assigned to non-optional field '{m.Name}'; provide a fallback with '??'",
                            m.Span));
                }
            }
        }

        foreach (var inv in invariants)
            checker.Check(inv.Condition, scope);
    }

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
                    m.Span));
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

            // Resolve the spec's target in its own context first (R13.2).
            TypeDecl? decl = index.TryGetDeclIn(ctx.Name, target, out var localDecl) ? localDecl
                : index.TryGetDecl(target, out var globalDecl) ? globalDecl : null;
            IReadOnlyList<Member>? members =
                decl switch { ValueObjectDecl v => v.Members, EntityDecl e => e.Members, _ => null };

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var memberNames = members is null
                ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                : new HashSet<string>(members.Select(m => m.Name), StringComparer.OrdinalIgnoreCase);

            foreach (var spec in specList)
            {
                if (members is null)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecUnknownTarget,
                        $"spec '{spec.Name}' targets '{target}', which is not a declared value or entity type", spec.Span));
                    continue;
                }

                if (!seen.Add(spec.Name) || memberNames.Contains(spec.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateSpec,
                        $"spec '{spec.Name}' duplicates another spec or a member of '{target}'", spec.Span));

                var scope = TypeScope.FromMembers(members);
                var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics, specNames);
                checker.Check(spec.Condition, scope);

                var inferred = resolver.Infer(spec.Condition, scope);
                if (inferred is not null && inferred.Name != "Bool")
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecNotBoolean,
                        $"spec '{spec.Name}' condition must be boolean, but is '{inferred.Name}'", spec.Span));
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
                    $"spec '{s.Name}' is part of a reference cycle", s.Span));
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
                    $"service '{svc.Name}' is declared more than once", svc.Span));

            var seenOps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var op in svc.Operations)
            {
                if (!seenOps.Add(op.Name))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateOperation,
                        $"operation '{op.Name}' is declared more than once in service '{svc.Name}'", op.Span));
                // A method cannot share its enclosing class's name (CS0542).
                else if (string.Equals(op.Name, svc.Name, StringComparison.OrdinalIgnoreCase))
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateOperation,
                        $"operation '{op.Name}' collides with its service's name '{svc.Name}'", op.Span));

                ValidateTypeRef(op.ReturnType, index, diagnostics);

                var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var p in op.Parameters)
                {
                    ValidateTypeRef(p.Type, index, diagnostics);
                    if (!seenParams.Add(p.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                            $"duplicate parameter '{p.Name}' in operation '{op.Name}'", p.Span));
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
                        $"use case '{uc.Name}' is declared more than once in service '{svc.Name}'", uc.Span));

                if (uc.ReturnType is not null)
                    ValidateTypeRef(uc.ReturnType, index, diagnostics);

                var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var p in uc.Parameters)
                {
                    ValidateTypeRef(p.Type, index, diagnostics);
                    if (!seenParams.Add(p.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                            $"duplicate parameter '{p.Name}' in use case '{uc.Name}'", p.Span));
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
                    $"policy '{policy.Name}' is declared more than once", policy.Span));

            var ev = index.TryGetDecl(policy.EventName, out var ed) && ed is EventDecl e ? e : null;
            if (ev is null)
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownEvent,
                    $"policy '{policy.Name}' reacts to '{policy.EventName}', which is not a declared event", policy.Span));

            var reaction = policy.Reaction;
            var targetRoot = ResolveTargetRoot(reaction.TargetType, index);
            if (targetRoot is null)
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownTarget,
                    $"policy '{policy.Name}' targets '{reaction.TargetType}', which is not a declared aggregate or entity", reaction.Span));

            var cmd = targetRoot?.Commands.FirstOrDefault(c => string.Equals(c.Name, reaction.CommandName, StringComparison.OrdinalIgnoreCase));
            if (targetRoot is not null && cmd is null)
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownCommand,
                    $"'{reaction.TargetType}' has no command '{reaction.CommandName}'", reaction.Span));

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
                        $"duplicate argument '{arg.Parameter}' in policy '{policy.Name}'", arg.Span));

                if (!cmdParams.TryGetValue(arg.Parameter, out var paramType))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                        $"command '{reaction.CommandName}' has no parameter '{arg.Parameter}'", arg.Span));
                }
                else if (ev is not null)
                {
                    var valueType = resolver.Infer(arg.Value, eventScope);
                    if (valueType is not null && !MemberAnalysis.IsAssignable(valueType, paramType))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgType,
                            $"argument '{arg.Parameter}' expects '{paramType.Name}', but the value is '{valueType.Name}'", arg.Span));
                }
            }

            if (cmdParams is not null)
                foreach (var p in cmd!.Parameters)
                    if (!provided.Contains(p.Name))
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                            $"policy '{policy.Name}' is missing argument '{p.Name}'", reaction.Span));
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
            AggregateDecl agg => agg.RootEntity(),
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
                $"quantity '{q.Name}' must declare exactly one enum-typed unit member, found {unitCount}", q.Span));
        if (amountCount != 1)
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityAmountCardinality,
                $"quantity '{q.Name}' must declare exactly one Decimal amount member, found {amountCount}", q.Span));

        // Only the amount and unit are restricted; derived/computed projections are fine.
        foreach (var m in q.Members)
            if (!MemberAnalysis.IsDerived(m, memberNames) && !IsAmount(m) && !IsUnit(m))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityMemberNotAllowed,
                    $"quantity '{q.Name}' may declare only its amount and unit members (plus derived projections); '{m.Name}' is not allowed",
                    m.Span));
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
            "Name", "Value", "All", "FromName", "FromValue", "TryFromName", "TryFromValue",
            "Match", "Switch", "ToString", "Equals", "GetHashCode"
        };
        // A field generates a PascalCase property; a member is emitted as a static field of
        // its (verbatim) name. If the two identifiers coincide the class declares one name
        // twice, so an associated field whose property name equals a member name also clashes.
        var memberNames = new HashSet<string>(en.MemberNames, StringComparer.Ordinal);
        foreach (var p in sig)
        {
            ValidateTypeRef(p.Type, index, diagnostics);
            if (!seenFields.Add(p.Name))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                    $"duplicate associated-data field '{p.Name}' in enum '{en.Name}'", p.Span));
            if (reserved.Contains(p.Name) || memberNames.Contains(PropertyKey(p.Name)))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumReservedAssociatedField,
                    $"associated-data field '{p.Name}' collides with a generated smart-enum member", p.Span));
            // Associated values are literals, so the field must be a literal-expressible
            // primitive (v0: String/Int/Decimal/Bool) — not a collection, value, or enum.
            if (!IsLiteralFieldType(p.Type))
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumAssociatedFieldType,
                    $"enum '{en.Name}' associated-data field '{p.Name}' must be String, Int, Decimal, or Bool", p.Span));
        }

        foreach (var member in en.Members)
        {
            if (member.Args.Count != sig.Count)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberArity,
                    sig.Count == 0
                        ? $"enum '{en.Name}' has no associated-data signature but member '{member.Name}' supplies {member.Args.Count} value(s)"
                        : $"enum member '{member.Name}' supplies {member.Args.Count} value(s) but '{en.Name}' declares {sig.Count} field(s)",
                    member.Span));
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
                $"enum '{enumName}' associated value for '{field}' must be a literal", arg.Span));
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
                arg.Span));
    }

    internal static void ValidateTypeRef(TypeRef type, ModelIndex index, List<Diagnostic> diagnostics)
    {
        // A qualified `Context.T` is validated by the context-scoping pass (UnknownContext /
        // NotExported); skip the global unknown-type check here to avoid a double report.
        if (type.Qualifier is null && !index.IsKnownType(type.Name))
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownType,
                $"unknown type '{type.Name}'{Suggestions.For(type.Name, index.CandidateTypeNames)}",
                type.Span));

        // Generic arity: List/Set/Range take one type argument; Map takes two.
        switch (index.Classify(type.Name))
        {
            case TypeKind.List or TypeKind.Set or TypeKind.Range:
                if (type.Element is null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.GenericArity, $"'{type.Name}' requires a type argument", type.Span));
                if (type.Value is not null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.GenericArity, $"'{type.Name}' takes a single type argument", type.Span));
                break;
            case TypeKind.Map:
                if (type.Element is null || type.Value is null)
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.GenericArity, "'Map' requires two type arguments <Key, Value>", type.Span));
                break;
        }

        // A Range is ordered, so its element must be an orderable type (Int/Decimal/Instant).
        // Only flag a KNOWN non-orderable element; an unknown element is already KOI0101.
        if (index.Classify(type.Name) == TypeKind.Range && type.Element is not null
            && index.IsKnownType(type.Element.Name) && !BuiltinOps.IsOrderable(type.Element.Name))
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.RangeNotOrderable,
                $"range element type '{type.Element.Name}' is not orderable; ranges require Int, Decimal, or Instant",
                type.Element.Span));

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
