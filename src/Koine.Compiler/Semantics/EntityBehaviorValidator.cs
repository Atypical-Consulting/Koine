using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Entity behaviour: identity strategy, commands, factories, states/transitions,
/// event emission, aggregate versioning and repositories (R8/R11). Split out of
/// <see cref="SemanticValidator"/>; every method is invoked from the
/// type-validation switch in the same order as before, preserving diagnostic
/// codes, messages, and emission order.
/// </summary>
internal static class EntityBehaviorValidator
{
    /// <summary>
    /// Validates an entity's commands: parameter type refs, <c>requires</c>
    /// preconditions, and <c>field -&gt; value</c> transitions (target must be a
    /// mutable, non-derived member; value must be type-compatible). Scope for
    /// expressions is the entity's members plus the command's parameters.
    /// </summary>
    /// <param name="emitAllowed">
    /// Whether <c>emit</c> is legal here: true for a standalone entity or the aggregate root.
    /// </param>
    /// <param name="aggregateRoot">
    /// The root name of the enclosing aggregate, or <see langword="null"/> when the entity stands
    /// alone. Distinct from <paramref name="emitAllowed"/> because <c>publish</c> (R19) is stricter:
    /// it needs a REAL aggregate root, so the standalone case must be told apart from the root case.
    /// </param>
    public static void ValidateCommands(
        EntityDecl entity,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        bool emitAllowed,
        string? aggregateRoot = null,
        IReadOnlySet<string>? specNames = null)
    {
        // R19 — `publish` is confined to the aggregate ROOT, and unlike `emit` a standalone entity is
        // NOT an acceptable stand-in. An emitted domain event is still observable on the entity that
        // recorded it, so a standalone `emit` is meaningful; a published integration event only ever
        // leaves the context when the aggregate's Unit of Work drains `_integrationEvents` into the
        // outbox at commit. With no aggregate there is no Unit of Work, no application handler, and
        // therefore no drain — the contract would silently never reach a subscriber.
        var publishAllowed = aggregateRoot is not null && aggregateRoot == entity.Name;

        var memberNames = SemanticValidator.MemberNameSet(entity.Members);
        var memberByName = new Dictionary<string, Member>(entity.Members.Count, StringComparer.Ordinal);
        foreach (var m in entity.Members)
        {
            memberByName[m.Name] = m;
        }

        // A command `requires` may reference a spec on the entity (R10.1).
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics, specNames);

        // Names are compared case-insensitively because both commands (methods) and
        // members (properties) emit Pascal/camel-cased C# identifiers; a clash there
        // produces uncompilable output (CS0102/CS0111).
        var seenCommands = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var propertyNames = new HashSet<string>(entity.Members.Count + 3, StringComparer.OrdinalIgnoreCase)
        {
            "Id", "Equals", "GetHashCode"
        };
        foreach (var m in entity.Members)
        {
            propertyNames.Add(m.Name);
        }

        foreach (var cmd in entity.Commands)
        {
            if (!seenCommands.Add(cmd.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateCommand,
                    $"command '{cmd.Name}' is declared more than once on '{entity.Name}'", cmd.Span));
            }
            else if (propertyNames.Contains(cmd.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.CommandNameCollision,
                    $"command '{cmd.Name}' collides with a property of '{entity.Name}'", cmd.Span));
            }

            // R19 — the `@route`/verb/`@auth` annotations preceding the command. Shared with queries,
            // so the rules live next to the other CQRS checks.
            CqrsValidator.ValidateApiAnnotations(
                cmd.ApiAnnotations, cmd.RouteOverride, cmd.AuthRole, $"command '{cmd.Name}'", cmd.Span, diagnostics,
                cmd.Parameters, entity.IdentityName);

            // Scope: the entity's members, the synthetic `id` (its identity), and the
            // command's parameters.
            var scopePairs = entity.Members.Select(m => new KeyValuePair<string, TypeRef>(m.Name, m.Type))
                .Append(new KeyValuePair<string, TypeRef>("id", new TypeRef(entity.IdentityName)))
                .Concat(cmd.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
            var scope = TypeScope.FromRefPairs(scopePairs, index);

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in cmd.Parameters)
            {
                SemanticValidator.ValidateTypeRef(p.Type, index, resolver, diagnostics);
                if (!seenParams.Add(p.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                        $"duplicate parameter '{p.Name}' in command '{cmd.Name}'", p.Span));
                }
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
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidTransitionTarget,
                                $"cannot transition '{tr.Field}': not a field of '{entity.Name}'", tr.Span));
                        }
                        else if (MemberAnalysis.IsDerived(target, memberNames))
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidTransitionTarget,
                                $"cannot transition derived field '{tr.Field}'", tr.Span));
                        }
                        else
                        {
                            checker.CheckTransitionValue(tr.Value, target.Type, tr.Field, scope);
                            CheckTransitionReachable(entity, tr, target, index, resolver, diagnostics);
                        }
                        break;

                    case EmitClause emit:
                        if (!emitAllowed)
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitOutsideRoot,
                                $"events may only be emitted from the aggregate root, not from '{entity.Name}'",
                                emit.Span));
                        }

                        ValidateEmit(emit, index, checker, scope, diagnostics);
                        break;

                    // R19 — `publish` leaves the context, so it is the aggregate ROOT's prerogative:
                    // an inner entity has no business speaking for the whole aggregate, and an entity
                    // with no aggregate at all has no outbox seam to speak through.
                    case PublishClause published:
                        if (!publishAllowed)
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PublishOutsideRoot,
                                aggregateRoot is null
                                    ? $"integration events may only be published from an aggregate root; entity '{entity.Name}' does not belong to an aggregate"
                                    : $"integration events may only be published from the aggregate root, not from '{entity.Name}'",
                                published.Span));
                        }

                        ValidatePublish(published, resolver.Context, index, checker, scope, diagnostics);
                        break;

                    case ResultClause res:
                        // A `result` clause only makes sense when the command declares a
                        // return type; its value must be assignable to that type.
                        if (cmd.ReturnType is { } rt)
                        {
                            checker.CheckCommandResult(res.Value, rt, cmd.Name, scope);
                        }
                        else
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ResultWithoutReturnType,
                                $"command '{cmd.Name}' has a 'result' clause but no declared return type", res.Span));
                        }

                        break;
                }
            }

            // A command that declares a return type must hand a value back: exactly one
            // `result` clause is required (zero is a missing return, validated here; >1 is
            // also reported so only a single terminal value is emitted).
            if (cmd.ReturnType is { } returnType)
            {
                SemanticValidator.ValidateTypeRef(returnType, index, resolver, diagnostics);
                var resultCount = 0;
                foreach (var stmt in cmd.Body)
                {
                    if (stmt is ResultClause)
                    {
                        resultCount++;
                    }
                }

                if (resultCount != 1)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.MissingCommandResult,
                        $"command '{cmd.Name}' declares return type '{returnType.Name}' and must have exactly one 'result' clause",
                        cmd.Span));
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
    public static void ValidateFactories(
        EntityDecl entity,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        bool emitAllowed)
    {
        if (entity.Factories.Count == 0)
        {
            return;
        }

        var memberNames = SemanticValidator.MemberNameSet(entity.Members);
        var memberByName = new Dictionary<string, Member>(entity.Members.Count, StringComparer.Ordinal);
        foreach (var m in entity.Members)
        {
            memberByName[m.Name] = m;
        }

        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        // A factory emits a `public static` method; its name must not collide (case-
        // insensitively) with a property, a command (instance method), another factory,
        // or an always-generated member (Id, the domain-event API, the integration-event
        // API a publishing root carries (R19), the value-equality members) — any of which
        // would yield uncompilable C# (CS0102/CS0111).
        var reserved = new HashSet<string>(entity.Members.Count + 7, StringComparer.OrdinalIgnoreCase)
        {
            "Id", "DomainEvents", "ClearDomainEvents",
            "IntegrationEvents", "ClearIntegrationEvents",
            "Equals", "GetHashCode"
        };
        foreach (var m in entity.Members)
        {
            reserved.Add(m.Name);
        }

        foreach (var cmd in entity.Commands)
        {
            reserved.Add(cmd.Name);
        }

        var seenFactories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var factory in entity.Factories)
        {
            if (!seenFactories.Add(factory.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateFactory,
                    $"factory '{factory.Name}' is declared more than once on '{entity.Name}'", factory.Span));
            }
            else if (reserved.Contains(factory.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FactoryNameCollision,
                    $"factory '{factory.Name}' collides with a property or command of '{entity.Name}'", factory.Span));
            }

            // R19/#1846 — the `@route`/verb/`@auth` annotations preceding the factory, checked by the very
            // rules a command's go through. `identityTypeName: null` is deliberate, NOT an oversight: a
            // command LOADS an existing aggregate, so its emitted request record carries an identity
            // property and an `{id}` token can bind to it — a factory CREATES one, and the emitted request
            // record is built from `factory.Parameters` alone (the C# api layer passes an empty identity
            // property), so there is nothing for `{id}` to bind to. On a factory `{id}` therefore binds only
            // when the factory DECLARES a parameter named `id` (an ordinary name match; see
            // `MemberAnalysis.IdentityParameters` for the explicit-id opt-in that makes one declarable on a
            // non-Guid identity), and is otherwise correctly an unbound token — KOI1215. Note that on the
            // DEFAULT Guid identity that parameter cannot be declared at all — KOI0807
            // (`ReservedFactoryParameter`, above) rejects it, since the factory mints `var id = <Id>.New();`
            // — so `{id}` on a Guid-identity factory is a permanent KOI1215: the author must name the token
            // after a real parameter, or move to a `natural`/`sequence` identity and take the explicit-id
            // opt-in. This is the same story `RouteDerivation.ForFactory` tells emit-side.
            CqrsValidator.ValidateApiAnnotations(
                factory.ApiAnnotations, factory.RouteOverride, factory.AuthRole,
                $"factory '{factory.Name}' on '{entity.Name}'", factory.Span, diagnostics,
                factory.Parameters, identityTypeName: null);

            // A `create` factory on a Guid identity auto-generates the new aggregate's id (`<Id>.New()` /
            // `<Id>::generate()`), the only key with a meaningful client-side generator. A `natural` key is
            // caller-supplied and a `sequence` key is store-assigned, so neither can be minted — the opt-in
            // (#324) is to take the identity as an explicit identity-typed parameter, and the emitters then
            // bind `id` to it instead of dangling an undefined generator. So for a NON-Guid identity exactly
            // one such parameter is required: zero leaves nothing to mint (KOI0808), more than one is
            // ambiguous (KOI0809). A Guid identity always mints, so an identity-typed parameter there is an
            // ordinary reference (e.g. `reply(parent: CommentId, …)`) and neither rule applies. One per
            // factory, before any emitter runs (issue #317).
            if (entity.IdStrategy != IdentityStrategy.Guid)
            {
                var idParamCount = MemberAnalysis.IdentityParameters(entity, factory).Count;
                if (idParamCount == 0)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FactoryNeedsGeneratableIdentity,
                        $"factory '{factory.Name}' on '{entity.Name}' auto-generates the identity, but '{entity.IdentityName}' is a {DescribeIdentity(entity)} key with no meaningful client-side generator; pass the identity explicitly (a parameter of type '{entity.IdentityName}') or use a Guid identity",
                        factory.Span));
                }
                else if (idParamCount > 1)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.AmbiguousFactoryIdentity,
                        $"factory '{factory.Name}' on '{entity.Name}' declares more than one parameter of the identity type '{entity.IdentityName}'; at most one may serve as the explicit identity",
                        factory.Span));
                }
            }

            // Scope: the factory's parameters plus the synthetic `id` (its identity).
            var scopePairs = IdScopePair(entity)
                .Concat(factory.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
            var scope = TypeScope.FromRefPairs(scopePairs, index);

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in factory.Parameters)
            {
                SemanticValidator.ValidateTypeRef(p.Type, index, resolver, diagnostics);
                if (!seenParams.Add(p.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                        $"duplicate parameter '{p.Name}' in factory '{factory.Name}'", p.Span));
                }

                // `id` is reserved for the synthetic identity local; a parameter of that name
                // would collide with it in the emitted method (CS0136). The one exception (#324):
                // on a NON-Guid identity an identity-typed `id` parameter IS the explicit identity and
                // binds to that synthetic local (no generator is emitted, so no collision) — allow it.
                // On a Guid identity the factory still mints `var id = <Id>.New();`, so an `id`
                // parameter would collide; and a param named `id` whose type is not the identity type
                // stays rejected everywhere.
                var isExplicitIdParameter = entity.IdStrategy != IdentityStrategy.Guid
                    && MemberAnalysis.IsIdentityTypeRef(p.Type, entity.IdentityName);
                if (string.Equals(p.Name, "id", StringComparison.OrdinalIgnoreCase) && !isExplicitIdParameter)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedFactoryParameter,
                        $"factory parameter '{p.Name}' is reserved; the identity is generated automatically unless declared as an explicit parameter of type '{entity.IdentityName}' on a non-Guid identity", p.Span));
                }
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
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidInitializationTarget,
                                $"cannot initialize '{init.Field}': not a field of '{entity.Name}'", init.Span));
                        }
                        else if (MemberAnalysis.IsDerived(target, memberNames))
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidInitializationTarget,
                                $"cannot initialize derived field '{init.Field}'", init.Span));
                        }
                        else
                        {
                            if (!initialized.Add(init.Field))
                            {
                                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateInitialization,
                                    $"field '{init.Field}' is initialized more than once in factory '{factory.Name}'", init.Span));
                            }

                            checker.CheckInitializationValue(init.Value, target.Type, init.Field, scope);
                        }
                        break;

                    case EmitClause emit:
                        if (!emitAllowed)
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitOutsideRoot,
                                $"events may only be emitted from the aggregate root, not from '{entity.Name}'",
                                emit.Span));
                        }

                        ValidateEmit(emit, index, checker, scope, diagnostics);
                        break;
                }
            }

            // R8.2: a required member (no default, not optional, not derived) that the
            // factory neither explicitly initializes (`field <- expr`) nor supplies via
            // a same-named parameter (auto-bind) is constructed as `default!` — a latent
            // bug, so warn.
            foreach (var m in entity.Members)
            {
                if (!MemberAnalysis.IsDerived(m, memberNames)
                    && m.Initializer is null && !m.Type.IsOptional
                    && !initialized.Contains(m.Name)
                    && !AnyParamAutoBinds(factory.Parameters, m))
                {
                    diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.UninitializedFactoryField,
                        $"factory '{factory.Name}' leaves required field '{m.Name}' uninitialized and it has no default",
                        factory.Span));
                }
            }
        }
    }

    /// <summary>True when any parameter auto-binds to <paramref name="m"/> (a per-loop closure-free <c>Any</c>).</summary>
    private static bool AnyParamAutoBinds(IReadOnlyList<Param> parameters, Member m)
    {
        foreach (Param p in parameters)
        {
            if (MemberAnalysis.AutoBinds(p, m))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The synthetic <c>id</c> binding (an entity's identity) for factory scope.</summary>
    private static IEnumerable<KeyValuePair<string, TypeRef>> IdScopePair(EntityDecl entity) =>
        new[] { new KeyValuePair<string, TypeRef>("id", new TypeRef(entity.IdentityName)) };

    /// <summary>The identity strategy rendered as it reads in <c>.koi</c> source — for diagnostics.</summary>
    private static string DescribeIdentity(EntityDecl entity) => entity.IdStrategy switch
    {
        IdentityStrategy.Sequence => "sequence",
        IdentityStrategy.Natural => $"natural({entity.IdBackingType ?? "String"})",
        _ => "guid",
    };

    /// <summary>
    /// Validates an entity's identity strategy (R11.1): a <c>natural(T)</c> key must
    /// wrap a supported primitive (<c>String</c> or <c>Int</c>). Guid and sequence
    /// strategies carry no backing type and need no check.
    /// </summary>
    public static void ValidateIdentityStrategy(EntityDecl entity, List<Diagnostic> diagnostics)
    {
        if (entity.IdStrategy != IdentityStrategy.Natural)
        {
            return;
        }

        if (entity.IdBackingType is not ("String" or "Int"))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NaturalIdBackingType,
                $"natural identity '{entity.IdentityName}' must wrap String or Int, not '{entity.IdBackingType}'",
                entity.Span));
        }
    }

    /// <summary>
    /// Validates a versioned aggregate (R11.4): the generated root carries a synthetic
    /// <c>Version</c> token, so the root entity must not declare a member that collides
    /// with it (which would emit a duplicate property, CS0102).
    /// </summary>
    public static void ValidateVersioning(AggregateDecl agg, List<Diagnostic> diagnostics)
    {
        if (!agg.IsVersioned)
        {
            return;
        }

        var root = agg.RootEntity();
        if (root is null)
        {
            return;
        }

        foreach (var m in root.Members)
        {
            if (string.Equals(m.Name, "Version", StringComparison.OrdinalIgnoreCase))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedVersionMember,
                    $"member '{m.Name}' collides with the generated 'Version' token of versioned aggregate '{agg.Name}'",
                    m.Span));
            }
        }
    }

    /// <summary>The operation keywords a <c>repository</c> block may list (R11.3).</summary>
    private static readonly IReadOnlySet<string> ValidRepositoryOps =
        new HashSet<string>(StringComparer.Ordinal) { "getById", "add", "update", "remove" };

    /// <summary>Case-insensitive membership test against <see cref="ValidRepositoryOps"/> (closure-free).</summary>
    private static bool IsBuiltInRepositoryOp(string name)
    {
        foreach (string op in ValidRepositoryOps)
        {
            if (string.Equals(op, name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Validates an aggregate's repository declaration (R11.3): every listed
    /// operation keyword is known; finder names are unique; finder parameters are
    /// well-typed with distinct names; and each finder's result type is the
    /// aggregate root or a <c>List</c> of it.
    /// </summary>
    public static void ValidateRepository(AggregateDecl agg, ModelIndex index, TypeResolver resolver, List<Diagnostic> diagnostics)
    {
        if (agg.Repository is not { } repo)
        {
            return;
        }

        if (repo.Operations is not null)
        {
            foreach (var op in repo.Operations)
            {
                if (!ValidRepositoryOps.Contains(op))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownRepositoryOperation,
                        $"unknown repository operation '{op}' (expected: getById, add, update, remove)",
                        agg.Span));
                }
            }
        }

        var seenFinders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var finder in repo.Finders)
        {
            if (!seenFinders.Add(finder.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateFinder,
                    $"finder '{finder.Name}' is declared more than once in the repository of '{agg.Name}'",
                    finder.Span));
            }
            // A finder emits `<Name>Async`; a name that resolves to a built-in operation
            // method would declare a duplicate (or confusingly-overloaded) member.
            else if (IsBuiltInRepositoryOp(finder.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FinderNameCollision,
                    $"finder '{finder.Name}' collides with the built-in repository operation of the same name",
                    finder.Span));
            }

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in finder.Parameters)
            {
                SemanticValidator.ValidateTypeRef(p.Type, index, resolver, diagnostics);
                if (!seenParams.Add(p.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                        $"duplicate parameter '{p.Name}' in finder '{finder.Name}'", p.Span));
                }

                // `ct` is reserved for the generated CancellationToken on every finder method.
                if (string.Equals(p.Name, "ct", StringComparison.OrdinalIgnoreCase))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedFinderParameter,
                        $"finder parameter '{p.Name}' is reserved; it collides with the generated cancellation token",
                        p.Span));
                }
            }

            // The result is a single root or a List<root>; anything else can't be a
            // well-typed lookup over this aggregate.
            SemanticValidator.ValidateTypeRef(finder.ResultType, index, resolver, diagnostics);
            var elementName = CSharpListElement(finder.ResultType);
            if (elementName != agg.RootName)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FinderResultType,
                    $"finder '{finder.Name}' must return '{agg.RootName}' or 'List<{agg.RootName}>', not '{finder.ResultType.Name}'",
                    finder.Span));
            }
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
    /// <remarks>
    /// The <c>index.Classify(resolver.Context, ...)</c> call below is context-threaded per #1711. This
    /// site USED to be unpinnable end-to-end, because the guard also calls
    /// <see cref="ModelIndex.EnumsDeclaring(string)"/>, which is populated by walking
    /// <see cref="ModelIndex.AllTypes"/> — then the SAME flat, last-write-wins <c>_byName</c> map
    /// <c>Classify</c>'s single-arg overload read from. Any model colliding the bound field's enum by
    /// name also evicted that enum from <c>AllTypes()</c>, so <c>EnumsDeclaring</c> stayed blind and
    /// this guard returned early EVERY time — silently suppressing the diagnostic below.
    /// <b>#1632 fixed that</b>: <c>AllTypes()</c> now enumerates every per-context declaration, so a
    /// shadowed enum's members are registered and this check runs on a colliding model as it should.
    /// Pinned by <c>ModelIndexAllTypesTests.Unreachable_transition_is_detected_through_a_shadowed_same_name_enum</c>.
    /// (See #1644 for the same former fusion in <c>ConcreteEnumType</c>'s consumers.) <b>#1739</b> then
    /// scoped <c>EnumsDeclaring</c> itself to the referencing context wherever an ambiguous owner list
    /// could pick the WRONG enum — this call site is unaffected: it only asks whether
    /// <c>target.Type.Name</c> (already resolved via the context-aware <c>Classify</c> call above) is
    /// somewhere among <c>stateRef</c>'s owners, a pure membership check a wider, unscoped list can
    /// only ever satisfy MORE readily, never wrongly deny — so it deliberately keeps the flat, 1-arg
    /// overload rather than threading context through it too.
    /// </remarks>
    private static void CheckTransitionReachable(
        EntityDecl entity, Transition tr, Member target, ModelIndex index, TypeResolver resolver, List<Diagnostic> diagnostics)
    {
        StatesDecl? states = null;
        foreach (StatesDecl s in entity.States)
        {
            if (s.Field == tr.Field)
            {
                states = s;
                break;
            }
        }

        if (states is null || states.Rules.Count == 0)
        {
            return;
        }

        if (tr.Value is not IdentifierExpr stateRef)
        {
            return; // dynamic target: only a runtime guard applies
        }

        // Resolved against the entity's own declaring context (#1711) so a same-named,
        // differently-kinded type declared elsewhere can't shadow it via the flat lookup.
        if (index.Classify(resolver.Context, target.Type.Name) != TypeKind.Enum
            || !index.EnumsDeclaring(stateRef.Name).Contains(target.Type.Name))
        {
            return; // not a literal state of the bound enum (other errors cover it)
        }

        var reachable = false;
        foreach (StateRule r in states.Rules)
        {
            if (r.To.Contains(stateRef.Name))
            {
                reachable = true;
                break;
            }
        }

        if (!reachable)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnreachableTransition,
                $"no state rule allows transitioning '{tr.Field}' to '{stateRef.Name}'", tr.Span));
        }
    }

    /// <summary>
    /// Validates an entity's <c>states</c> blocks: each binds to an enum-typed
    /// member; every state names a member of that enum; per-rule guards resolve
    /// against the entity's members.
    /// </summary>
    public static void ValidateStates(
        EntityDecl entity,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics)
    {
        // A duplicate field name is reported as KOI0103 yet kept in entity.Members, so build the lookup
        // defensively (last-wins) rather than ToDictionary — a collision here would otherwise throw and
        // abort the whole validate pass, swallowing that very diagnostic. Mirrors ValidateCommands.
        var memberByName = new Dictionary<string, Member>(entity.Members.Count, StringComparer.Ordinal);
        foreach (var m in entity.Members)
        {
            memberByName[m.Name] = m;
        }

        var scope = TypeScope.FromMembers(entity.Members, index);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        // A field may have at most one states block: the reachability check and the
        // emitted guard each consult a single block, so a second would silently drop rules.
        var seenFields = new HashSet<string>(StringComparer.Ordinal);

        foreach (var states in entity.States)
        {
            if (!seenFields.Add(states.Field))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateStatesBlock,
                    $"field '{states.Field}' already has a states block", states.Span));
                continue;
            }

            if (!memberByName.TryGetValue(states.Field, out var field))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidStatesBinding,
                    $"states binds to '{states.Field}', which is not a field of '{entity.Name}'", states.Span));
                continue;
            }
            // Resolved against the entity's own declaring context (#1711) so a same-named,
            // differently-kinded type declared elsewhere can't shadow it via the flat lookup.
            if (index.Classify(resolver.Context, field.Type.Name) != TypeKind.Enum)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidStatesBinding,
                    $"states field '{states.Field}' must be an enum, but is '{field.Type.Name}'", states.Span));
                continue;
            }

            var enumName = field.Type.Name;
            // Same context-aware resolution as the check above, so the enum whose members seed
            // `validStates` is the field's OWN enum, not a same-named one shadowing it (#1711).
            var validStates = index.TryGetDecl(resolver.Context, enumName, out var decl) && decl is EnumDecl en
                ? new HashSet<string>(en.MemberNames, StringComparer.Ordinal)
                : new HashSet<string>(StringComparer.Ordinal);

            foreach (var rule in states.Rules)
            {
                // The `from` state, then each `to` state — same order the old `{from}.Concat(to)`
                // produced, but without the per-rule array + Concat iterator.
                CheckState(rule.From, rule, validStates, enumName, diagnostics);
                foreach (var to in rule.To)
                {
                    CheckState(to, rule, validStates, enumName, diagnostics);
                }

                if (rule.Guard is not null)
                {
                    checker.Check(rule.Guard, scope);
                }
            }
        }
    }

    /// <summary>Reports a state literal that is not a member of the bound enum (KOI: unknown state).</summary>
    private static void CheckState(
        string state, StateRule rule, HashSet<string> validStates, string enumName, List<Diagnostic> diagnostics)
    {
        if (!validStates.Contains(state))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownState,
                $"'{state}' is not a member of enum '{enumName}'", rule.Span));
        }
    }

    /// <summary>
    /// Validates an <c>emit EventName(field: value, …)</c>: the name must be a
    /// declared event, every argument must name a distinct event field with a
    /// type-compatible value, and every event field must be supplied.
    /// </summary>
    public static void ValidateEmit(
        EmitClause emit,
        ModelIndex index,
        ExpressionChecker checker,
        TypeScope scope,
        List<Diagnostic> diagnostics)
    {
        if (!index.TryGetDecl(emit.EventName, out var decl) || decl is not EventDecl ev)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownEvent,
                $"unknown event '{emit.EventName}'", emit.Span));
            foreach (var arg in emit.Args)
            {
                checker.Check(arg.Value, scope);
            }

            return;
        }

        // A duplicate event field name is reported as KOI0103 yet both members are kept, so build the
        // lookup defensively (last-wins) rather than ToDictionary — a collision here would otherwise throw
        // and abort the whole validate pass, swallowing that very diagnostic. Mirrors ValidateStates.
        var eventFields = new Dictionary<string, TypeRef>(ev.Members.Count, StringComparer.Ordinal);
        foreach (var m in ev.Members)
        {
            eventFields[m.Name] = m.Type;
        }

        var provided = new HashSet<string>(StringComparer.Ordinal);

        foreach (var arg in emit.Args)
        {
            if (!provided.Add(arg.Field))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"duplicate field '{arg.Field}' in emit of '{ev.Name}'", arg.Span));
            }

            if (eventFields.TryGetValue(arg.Field, out var fieldType))
            {
                checker.CheckEmitArg(arg.Value, fieldType, ev.Name, arg.Field, scope);
            }
            else
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"event '{ev.Name}' has no field '{arg.Field}'", arg.Span));
            }
        }

        foreach (var field in ev.Members)
        {
            if (!provided.Contains(field.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"emit of '{ev.Name}' is missing field '{field.Name}'", emit.Span));
            }
        }
    }

    /// <summary>
    /// Validates a <c>publish EventName(field: value, …)</c> — the verb form of the context-level
    /// <c>publishes</c> (R19). Modelled on <see cref="ValidateEmit"/>, but the name must resolve to an
    /// <see cref="IntegrationEventDecl"/> of the ENCLOSING context (KOI1420) that the context actually
    /// puts in its published language with a <c>publishes</c> declaration (KOI1421); the payload rules
    /// are then identical to <c>emit</c>'s and reuse <see cref="DiagnosticCodes.EmitPayloadMismatch"/>.
    /// Only ONE of the two name diagnostics is reported per clause: an unresolvable name cannot have a
    /// meaningful <c>publishes</c> or payload check, so it bails exactly as <c>emit</c> does.
    /// </summary>
    public static void ValidatePublish(
        PublishClause publish,
        string? context,
        ModelIndex index,
        ExpressionChecker checker,
        TypeScope scope,
        List<Diagnostic> diagnostics)
    {
        // The enclosing bounded context. It is always set on the per-context validation path; the
        // empty fallback only guards a context-less (global) resolver, where nothing can be published.
        var contextName = context ?? string.Empty;

        // Context-aware resolution (#1711): a same-named, differently-kinded type in another context
        // must not satisfy `publish` here, which is why IsIntegrationEventIn gates the flat lookup.
        if (!index.TryGetDecl(context, publish.EventName, out var decl)
            || decl is not IntegrationEventDecl ev
            || !index.IsIntegrationEventIn(contextName, publish.EventName))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PublishUnknownIntegrationEvent,
                $"'{publish.EventName}' is not an integration event of context '{contextName}'", publish.Span));
            foreach (var arg in publish.Args)
            {
                checker.Check(arg.Value, scope);
            }

            return;
        }

        // Declaring the event is not enough: `publishes X` is what puts X in the published language,
        // and it is what the subscribers, the context map, and the AsyncAPI emitter read.
        if (!index.PublishesEvent(contextName, ev.Name))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PublishNotDeclared,
                $"context '{contextName}' does not declare 'publishes {ev.Name}'", publish.Span));
            return;
        }

        // A duplicate event field name is reported as KOI0103 yet both members are kept, so build the
        // lookup defensively (last-wins) rather than ToDictionary — a collision here would otherwise throw
        // and abort the whole validate pass, swallowing that very diagnostic. Mirrors ValidateEmit.
        var eventFields = new Dictionary<string, TypeRef>(ev.Members.Count, StringComparer.Ordinal);
        foreach (var m in ev.Members)
        {
            eventFields[m.Name] = m.Type;
        }

        var provided = new HashSet<string>(StringComparer.Ordinal);

        foreach (var arg in publish.Args)
        {
            if (!provided.Add(arg.Field))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"duplicate field '{arg.Field}' in publish of '{ev.Name}'", arg.Span));
            }

            if (eventFields.TryGetValue(arg.Field, out var fieldType))
            {
                checker.CheckEmitArg(arg.Value, fieldType, ev.Name, arg.Field, scope);
            }
            else
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"integration event '{ev.Name}' has no field '{arg.Field}'", arg.Span));
            }
        }

        foreach (var field in ev.Members)
        {
            if (!provided.Contains(field.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmitPayloadMismatch,
                    $"publish of '{ev.Name}' is missing field '{field.Name}'", publish.Span));
            }
        }
    }
}
