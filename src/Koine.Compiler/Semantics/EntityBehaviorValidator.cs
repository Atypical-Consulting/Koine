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
    public static void ValidateCommands(
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
        {
            memberByName[m.Name] = m;
        }

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
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateCommand,
                    $"command '{cmd.Name}' is declared more than once on '{entity.Name}'", cmd.Span));
            }
            else if (propertyNames.Contains(cmd.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.CommandNameCollision,
                    $"command '{cmd.Name}' collides with a property of '{entity.Name}'", cmd.Span));
            }

            // Scope: the entity's members, the synthetic `id` (its identity), and the
            // command's parameters.
            var scopePairs = entity.Members.Select(m => new KeyValuePair<string, TypeRef>(m.Name, m.Type))
                .Append(new KeyValuePair<string, TypeRef>("id", new TypeRef(entity.IdentityName)))
                .Concat(cmd.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
            var scope = TypeScope.FromRefPairs(scopePairs, index);

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in cmd.Parameters)
            {
                SemanticValidator.ValidateTypeRef(p.Type, index, diagnostics);
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
                            CheckTransitionReachable(entity, tr, target, index, diagnostics);
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
                SemanticValidator.ValidateTypeRef(returnType, index, diagnostics);
                var resultCount = cmd.Body.OfType<ResultClause>().Count();
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

        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var memberByName = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach (var m in entity.Members)
        {
            memberByName[m.Name] = m;
        }

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

            // Scope: the factory's parameters plus the synthetic `id` (its identity).
            var scopePairs = IdScopePair(entity)
                .Concat(factory.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
            var scope = TypeScope.FromRefPairs(scopePairs, index);

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in factory.Parameters)
            {
                SemanticValidator.ValidateTypeRef(p.Type, index, diagnostics);
                if (!seenParams.Add(p.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                        $"duplicate parameter '{p.Name}' in factory '{factory.Name}'", p.Span));
                }

                // `id` is reserved for the auto-generated identity local; a parameter of
                // that name would collide with it in the emitted method (CS0136).
                if (string.Equals(p.Name, "id", StringComparison.OrdinalIgnoreCase))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedFactoryParameter,
                        $"factory parameter '{p.Name}' is reserved; the identity is generated automatically", p.Span));
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
                    && !factory.Parameters.Any(p => MemberAnalysis.AutoBinds(p, m)))
                {
                    diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.UninitializedFactoryField,
                        $"factory '{factory.Name}' leaves required field '{m.Name}' uninitialized and it has no default",
                        factory.Span));
                }
            }
        }
    }

    /// <summary>The synthetic <c>id</c> binding (an entity's identity) for factory scope.</summary>
    private static IEnumerable<KeyValuePair<string, TypeRef>> IdScopePair(EntityDecl entity) =>
        new[] { new KeyValuePair<string, TypeRef>("id", new TypeRef(entity.IdentityName)) };

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

    /// <summary>
    /// Validates an aggregate's repository declaration (R11.3): every listed
    /// operation keyword is known; finder names are unique; finder parameters are
    /// well-typed with distinct names; and each finder's result type is the
    /// aggregate root or a <c>List</c> of it.
    /// </summary>
    public static void ValidateRepository(AggregateDecl agg, ModelIndex index, List<Diagnostic> diagnostics)
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
            else if (ValidRepositoryOps.Any(op => string.Equals(op, finder.Name, StringComparison.OrdinalIgnoreCase)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.FinderNameCollision,
                    $"finder '{finder.Name}' collides with the built-in repository operation of the same name",
                    finder.Span));
            }

            var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in finder.Parameters)
            {
                SemanticValidator.ValidateTypeRef(p.Type, index, diagnostics);
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
            SemanticValidator.ValidateTypeRef(finder.ResultType, index, diagnostics);
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
    private static void CheckTransitionReachable(
        EntityDecl entity, Transition tr, Member target, ModelIndex index, List<Diagnostic> diagnostics)
    {
        var states = entity.States.FirstOrDefault(s => s.Field == tr.Field);
        if (states is null || states.Rules.Count == 0)
        {
            return;
        }

        if (tr.Value is not IdentifierExpr stateRef)
        {
            return; // dynamic target: only a runtime guard applies
        }

        if (index.Classify(target.Type.Name) != TypeKind.Enum
            || !index.EnumsDeclaring(stateRef.Name).Contains(target.Type.Name))
        {
            return; // not a literal state of the bound enum (other errors cover it)
        }

        if (!states.Rules.Any(r => r.To.Contains(stateRef.Name)))
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
        var memberByName = entity.Members.ToDictionary(m => m.Name, m => m, StringComparer.Ordinal);
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
            if (index.Classify(field.Type.Name) != TypeKind.Enum)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidStatesBinding,
                    $"states field '{states.Field}' must be an enum, but is '{field.Type.Name}'", states.Span));
                continue;
            }

            var enumName = field.Type.Name;
            var validStates = index.TryGetDecl(enumName, out var decl) && decl is EnumDecl en
                ? new HashSet<string>(en.MemberNames, StringComparer.Ordinal)
                : new HashSet<string>(StringComparer.Ordinal);

            foreach (var rule in states.Rules)
            {
                foreach (var state in new[] { rule.From }.Concat(rule.To))
                {
                    if (!validStates.Contains(state))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownState,
                            $"'{state}' is not a member of enum '{enumName}'", rule.Span));
                    }
                }

                if (rule.Guard is not null)
                {
                    checker.Check(rule.Guard, scope);
                }
            }
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

        var eventFields = ev.Members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
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
}
