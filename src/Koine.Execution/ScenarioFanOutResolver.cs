using Koine.Compiler.Ast;

namespace Koine.Execution;

/// <summary>
/// One DECLARED, executable downstream reaction to an emitted event: the policy reaction
/// <c>policy P when E then Target.member(args)</c>, resolved to the entity that really owns
/// <see cref="MemberName"/>.
/// </summary>
/// <param name="EntityName">The downstream entity — the aggregate root that owns the member.</param>
/// <param name="AggregateName">The owning aggregate, or <see cref="EntityName"/> when the entity is in none.</param>
/// <param name="Context">The bounded context declaring the entity.</param>
/// <param name="MemberName">The command or factory the reaction invokes, as DECLARED (canonical casing).</param>
/// <param name="IsFactory">True when the member is a <see cref="FactoryDecl"/> (static, no prior instance);
/// false when it is a <see cref="CommandDecl"/>.
/// <para>NOT REACHABLE from a model that VALIDATES, as the language stands: <c>ValidatePolicies</c>
/// resolves a reaction's member against the target root's <b>commands only</b>, so
/// <c>then Replenishment.raise</c> naming a <c>create</c> is the hard error KOI1032 ("has no command").
/// Every path keyed off this flag is therefore dead for any model the runner is actually asked to run,
/// and its one test builds the shape deliberately unvalidated. It is kept, not speculative: the
/// resolver answers the question either way, so the day a policy may name a factory the runner already
/// runs it from no prior state instead of reporting an aggregate whose state it could not
/// establish.</para></param>
/// <param name="Args">The reaction's named arguments, in source order — values drawn from the event's fields.</param>
/// <param name="PolicyName">The policy that declares the reaction, so a timeline can name it.</param>
internal sealed record FanOutTarget(
    string EntityName,
    string AggregateName,
    string Context,
    string MemberName,
    bool IsFactory,
    IReadOnlyList<PolicyArg> Args,
    string PolicyName);

/// <summary>
/// A context that DECLARES a subscription to the emitted integration event
/// (<c>subscribes Publisher.Event</c>) but has nothing executable behind it: every emitter
/// produces only a handler seam (C#: <c>IHandle&lt;Event&gt;</c>) with no body.
/// </summary>
internal sealed record FanOutSubscriber(string Context, string EventName);

/// <summary>
/// What the model declares downstream of one emitted event: the reactions that can really be RUN
/// (<see cref="Executable"/>) and the ones it only DECLARES (<see cref="DeclaredOnly"/>). Both lists
/// are deterministically ordered.
/// </summary>
internal sealed record FanOutResolution(
    IReadOnlyList<FanOutTarget> Executable,
    IReadOnlyList<FanOutSubscriber> DeclaredOnly)
{
    /// <summary>Nothing downstream — the answer for an unknown or un-reacted-to event.</summary>
    public static readonly FanOutResolution Empty = new([], []);

    /// <summary>True when the event has no declared downstream of either kind.</summary>
    public bool IsEmpty => Executable.Count == 0 && DeclaredOnly.Count == 0;
}

/// <summary>
/// Maps an emitted event onto the downstream targets the MODEL declares (issue #1758). Pure model
/// reading: it emits nothing, compiles nothing, reflects over nothing and never throws — dispatching
/// the resolved targets is the executor's job, not this type's.
///
/// <para>Koine has exactly two downstream surfaces, and they differ in kind:</para>
/// <list type="number">
/// <item><description><c>policy P when E then Target.member(args)</c> — in-context, cross-aggregate.
/// The member is a real emitted method, so this IS executable (<see cref="FanOutResolution.Executable"/>).
/// The reaction's <c>Target</c> may name the AGGREGATE rather than the entity, so it is resolved to the
/// aggregate's root exactly the way <see cref="ScenarioExecutor"/> resolves a scenario target.</description></item>
/// <item><description><c>publishes E</c> / <c>subscribes Publisher.E</c> — cross-context. Every emitter
/// produces only a bodiless handler seam, so there is nothing to run: the subscribing contexts are
/// reported as declared-only (<see cref="FanOutResolution.DeclaredOnly"/>) and never as a fabricated
/// step.</description></item>
/// </list>
///
/// <para>Policies are matched model-wide by event name, the way
/// <see cref="ModelIndex.PoliciesTriggeredByEvent"/> builds the same graph; each one is resolved inside
/// the context that DECLARES it, so a policy always reaches its own context's types first. The
/// <c>emittingContext</c> argument therefore only scopes the integration-event branch, whose
/// <c>subscribes</c> lines name the publisher explicitly.</para>
/// </summary>
internal sealed class ScenarioFanOutResolver(SemanticModel sema)
{
    private readonly SemanticModel _sema = sema;
    private readonly ModelIndex _index = sema.Index;

    /// <summary>
    /// The declared downstream of <paramref name="eventName"/> emitted from
    /// <paramref name="emittingContext"/>. An unknown event, context, policy target or member yields
    /// empty lists — never an exception, and never an invented target.
    /// </summary>
    public FanOutResolution Resolve(string emittingContext, string eventName)
    {
        if (string.IsNullOrEmpty(eventName))
        {
            return FanOutResolution.Empty;
        }

        IReadOnlyList<FanOutTarget> executable = ResolveExecutable(eventName);
        IReadOnlyList<FanOutSubscriber> declaredOnly = ResolveDeclaredOnly(emittingContext, eventName);
        return executable.Count == 0 && declaredOnly.Count == 0
            ? FanOutResolution.Empty
            : new FanOutResolution(executable, declaredOnly);
    }

    // ------------------------------------------------------------------------
    // Executable: policy reactions.
    // ------------------------------------------------------------------------

    private IReadOnlyList<FanOutTarget> ResolveExecutable(string eventName)
    {
        var targets = new List<FanOutTarget>();

        foreach (ContextNode ctx in _sema.Model.Contexts)
        {
            foreach (PolicyDecl policy in ctx.Policies)
            {
                if (!string.Equals(policy.EventName, eventName, StringComparison.Ordinal))
                {
                    continue;
                }

                if (TryResolveReaction(ctx, policy, out FanOutTarget? target))
                {
                    targets.Add(target!);
                }
            }
        }

        // Deterministic: context, then entity, then member, then the declaring policy.
        return targets
            .OrderBy(t => t.Context, StringComparer.Ordinal)
            .ThenBy(t => t.EntityName, StringComparer.Ordinal)
            .ThenBy(t => t.MemberName, StringComparer.Ordinal)
            .ThenBy(t => t.PolicyName, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// Resolves one policy reaction to the entity that owns the invoked member. Returns <c>false</c>
    /// — rather than a half-resolved target — when the target type or the member does not resolve
    /// (both are already validation errors; the runner reports nothing instead of guessing).
    /// </summary>
    private bool TryResolveReaction(ContextNode declaring, PolicyDecl policy, out FanOutTarget? target)
    {
        target = null;

        PolicyReaction reaction = policy.Reaction;
        var name = Unqualify(reaction.TargetType);

        // The policy's own context first (a reaction is in-context by design), then the rest of the
        // model, so an imported target still resolves.
        if (!TryFindEntity(declaring, name, out EntityDecl? entity, out ContextNode? owner))
        {
            foreach (ContextNode ctx in _sema.Model.Contexts)
            {
                if (!ReferenceEquals(ctx, declaring) && TryFindEntity(ctx, name, out entity, out owner))
                {
                    break;
                }
            }
        }

        if (entity is null || owner is null)
        {
            return false;
        }

        CommandDecl? command = Find(entity.Commands, c => c.Name, reaction.CommandName);
        FactoryDecl? factory = command is null ? Find(entity.Factories, f => f.Name, reaction.CommandName) : null;
        if (command is null && factory is null)
        {
            return false;
        }

        target = new FanOutTarget(
            entity.Name,
            OwningAggregateName(owner, entity) ?? entity.Name,
            owner.Name,
            command?.Name ?? factory!.Name,
            IsFactory: factory is not null,
            reaction.Args,
            policy.Name);
        return true;
    }

    // ------------------------------------------------------------------------
    // Declared-only: integration-event subscriptions.
    // ------------------------------------------------------------------------

    private IReadOnlyList<FanOutSubscriber> ResolveDeclaredOnly(string emittingContext, string eventName)
    {
        // Only a PUBLISHED integration event of the emitting context crosses a boundary: a plain
        // domain event has no subscriber, and an unpublished integration event is not announced.
        if (string.IsNullOrEmpty(emittingContext)
            || !_index.IsIntegrationEventIn(emittingContext, eventName)
            || !_index.PublishesEvent(emittingContext, eventName))
        {
            return [];
        }

        var subscribers = new List<FanOutSubscriber>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (ContextNode ctx in _sema.Model.Contexts)
        {
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                if (string.Equals(sub.Context, emittingContext, StringComparison.Ordinal)
                    && string.Equals(sub.EventName, eventName, StringComparison.Ordinal)
                    && seen.Add(ctx.Name))
                {
                    subscribers.Add(new FanOutSubscriber(ctx.Name, eventName));
                }
            }
        }

        return subscribers
            .OrderBy(s => s.Context, StringComparer.Ordinal)
            .ThenBy(s => s.EventName, StringComparer.Ordinal)
            .ToList();
    }

    // ------------------------------------------------------------------------
    // Resolution helpers.
    // ------------------------------------------------------------------------

    /// <summary>The last segment of a possibly qualified <c>Context.Type</c> name.</summary>
    private static string Unqualify(string name) =>
        name.Contains('.') ? name[(name.LastIndexOf('.') + 1)..] : name;

    /// <summary>
    /// The entity a policy target names inside <paramref name="ctx"/>: an entity directly, or an
    /// aggregate's root — the same resolution <c>SemanticValidator.ResolveTargetRoot</c> and
    /// <c>ScenarioExecutor.ResolveEntity</c> perform.
    /// </summary>
    private static bool TryFindEntity(ContextNode ctx, string name, out EntityDecl? entity, out ContextNode? owner)
    {
        owner = null;
        List<TypeDecl> types = ctx.AllTypeDecls().ToList();

        entity = types.OfType<EntityDecl>().FirstOrDefault(e => e.Name == name)
                 ?? types.OfType<AggregateDecl>().FirstOrDefault(a => a.Name == name)?.RootEntity();
        if (entity is null)
        {
            return false;
        }

        owner = ctx;
        return true;
    }

    /// <summary>
    /// The name of the INNERMOST aggregate owning <paramref name="entity"/>, or <c>null</c> when the
    /// entity is declared outside any aggregate. Modules are already flattened into
    /// <see cref="ContextNode.Types"/>, so recursing the aggregate nesting is enough.
    /// </summary>
    private static string? OwningAggregateName(ContextNode ctx, EntityDecl entity) =>
        OwningAggregateName(ctx.Types, entity);

    private static string? OwningAggregateName(IReadOnlyList<TypeDecl> types, EntityDecl entity)
    {
        foreach (TypeDecl decl in types)
        {
            if (decl is not AggregateDecl aggregate)
            {
                continue;
            }

            if (OwningAggregateName(aggregate.Types, entity) is { } nested)
            {
                return nested;
            }

            if (aggregate.Types.OfType<EntityDecl>().Any(e => ReferenceEquals(e, entity) || e.Name == entity.Name))
            {
                return aggregate.Name;
            }
        }

        return null;
    }

    /// <summary>
    /// The member <paramref name="name"/> selects: an exact match first, then a case-insensitive one —
    /// the policy validator resolves a reaction's member case-insensitively, so the runner must agree.
    /// </summary>
    private static T? Find<T>(IReadOnlyList<T> members, Func<T, string> nameOf, string name) where T : class =>
        members.FirstOrDefault(m => string.Equals(nameOf(m), name, StringComparison.Ordinal))
        ?? members.FirstOrDefault(m => string.Equals(nameOf(m), name, StringComparison.OrdinalIgnoreCase));
}
