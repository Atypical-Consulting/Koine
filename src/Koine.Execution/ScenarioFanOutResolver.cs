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
/// A policy whose trigger event NAME matched the emitted event but whose DECLARATION did not (#1854):
/// resolved from ITS OWN declaring context, <see cref="PolicyName"/>'s trigger names a different event
/// than the one actually emitted — two bounded contexts each legally declaring an <c>event</c> with the
/// same simple name (R13.2), a coincidence rather than a connection. Reported so the drop is visible
/// rather than silent; never dispatched as a <see cref="FanOutTarget"/>.
/// </summary>
internal sealed record FanOutDroppedPolicy(string Context, string PolicyName, string EventName);

/// <summary>
/// What the model declares downstream of one emitted event: the reactions that can really be RUN
/// (<see cref="Executable"/>), the ones it only DECLARES (<see cref="DeclaredOnly"/>), and the
/// name-matched policies that were DROPPED because their trigger resolved to a different declaration
/// (<see cref="Dropped"/>). All three lists are deterministically ordered.
/// </summary>
internal sealed record FanOutResolution(
    IReadOnlyList<FanOutTarget> Executable,
    IReadOnlyList<FanOutSubscriber> DeclaredOnly,
    IReadOnlyList<FanOutDroppedPolicy> Dropped)
{
    /// <summary>Nothing downstream — the answer for an unknown or un-reacted-to event.</summary>
    public static readonly FanOutResolution Empty = new([], [], []);

    /// <summary>True when the event has no declared downstream, and nothing was dropped either.</summary>
    public bool IsEmpty => Executable.Count == 0 && DeclaredOnly.Count == 0 && Dropped.Count == 0;
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
/// <para>A policy's trigger is matched context-first (#1854), the same rule the validator's
/// <c>ValidatePolicies</c> and every code emitter use (#1849): candidates are gathered by bare event
/// NAME, then each is kept only when its trigger — resolved from ITS OWN declaring context via
/// <see cref="ModelIndex.TryGetDecl(string?, string, out TypeDecl)"/>, the same context-first-then-flat
/// ladder the validator calls — names the SAME declaration as the one <c>emittingContext</c> actually
/// emitted. R13.2 lets two bounded contexts each declare an <c>event Shipped</c> with a different
/// payload, and a bare name match alone cannot tell them apart — without this rule a policy in an
/// unrelated context could fire for an event it never really reacts to. A policy naming an event with
/// no local declaration, import, or context-map permit relation — but that is the model's only
/// declaration of that name — still resolves via the same flat fallback the validator falls back to,
/// so it is unaffected. A policy dropped this way is reported, never silently skipped (see
/// <see cref="FanOutResolution.Dropped"/>). The reaction TARGET, a few lines below, is — and always
/// was — resolved declaring-context-first (its own context, then the rest of the model), so both
/// halves of a reaction now agree on which context decides.</para>
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

        (IReadOnlyList<FanOutTarget> executable, IReadOnlyList<FanOutDroppedPolicy> dropped) =
            ResolveExecutable(emittingContext, eventName);
        IReadOnlyList<FanOutSubscriber> declaredOnly = ResolveDeclaredOnly(emittingContext, eventName);
        return executable.Count == 0 && declaredOnly.Count == 0 && dropped.Count == 0
            ? FanOutResolution.Empty
            : new FanOutResolution(executable, declaredOnly, dropped);
    }

    // ------------------------------------------------------------------------
    // Executable: policy reactions.
    // ------------------------------------------------------------------------

    private (IReadOnlyList<FanOutTarget> Targets, IReadOnlyList<FanOutDroppedPolicy> Dropped) ResolveExecutable(
        string emittingContext, string eventName)
    {
        var targets = new List<FanOutTarget>();
        var dropped = new List<FanOutDroppedPolicy>();

        // The event as declared where it was actually emitted — every name-matching policy's own
        // trigger is compared against THIS declaration's identity, not the bare event name. Resolved
        // via ModelIndex.TryGetDecl(context, name, out _) — the SAME context-first-then-flat-fallback
        // ladder SemanticValidator.ValidatePolicies (SemanticValidator.cs:1180) and every code emitter
        // use (#1849), not the narrower TryGetDeclIn alone: a policy naming an event with no local
        // declaration, import, or context-map permit relation to it — but that is the model's ONLY
        // declaration of that name — still validates today via the flat fallback, and must still
        // dispatch here for the same reason.
        _index.TryGetDecl(emittingContext, eventName, out TypeDecl emittedDecl);

        foreach (ContextNode ctx in _sema.Model.Contexts)
        {
            foreach (PolicyDecl policy in ctx.Policies)
            {
                if (!string.Equals(policy.EventName, eventName, StringComparison.Ordinal))
                {
                    continue;
                }

                // Resolved from the POLICY's OWN declaring context, through the identical ladder above.
                // A same-named event declared (or otherwise resolved) in an unrelated context resolves
                // to a DIFFERENT node, so it is dropped rather than dispatched.
                if (!_index.TryGetDecl(ctx.Name, policy.EventName, out TypeDecl triggerDecl)
                    || !ReferenceEquals(triggerDecl, emittedDecl))
                {
                    dropped.Add(new FanOutDroppedPolicy(ctx.Name, policy.Name, policy.EventName));
                    continue;
                }

                if (TryResolveReaction(ctx, policy, out FanOutTarget? target))
                {
                    targets.Add(target!);
                }
            }
        }

        // Deterministic: context, then entity, then member, then the declaring policy.
        IReadOnlyList<FanOutTarget> orderedTargets = targets
            .OrderBy(t => t.Context, StringComparer.Ordinal)
            .ThenBy(t => t.EntityName, StringComparer.Ordinal)
            .ThenBy(t => t.MemberName, StringComparer.Ordinal)
            .ThenBy(t => t.PolicyName, StringComparer.Ordinal)
            .ToList();

        IReadOnlyList<FanOutDroppedPolicy> orderedDropped = dropped
            .OrderBy(d => d.Context, StringComparer.Ordinal)
            .ThenBy(d => d.PolicyName, StringComparer.Ordinal)
            .ToList();

        return (orderedTargets, orderedDropped);
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
