using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Runtime.Loader;
using Koine.Compiler;
using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;
using Koine.Compiler.Emit;
using Koine.Compiler.Semantics.Scenarios;

namespace Koine.Execution;

/// <summary>
/// Runs a <see cref="Scenario"/> by EXECUTING the model's emitted C# (issue #236, "Approach A"): emit →
/// Roslyn-compile → drive the real generated types reflectively → map the outcome back onto the very same
/// <see cref="ScenarioResult"/> contract <see cref="ScenarioInterpreter"/> (Approach B) returns, with the
/// same <c>requires</c>/<c>transition</c>/<c>emit</c>/<c>result</c> step kinds, so one timeline renders
/// either mode.
///
/// <para>What executing buys over interpreting is the four gaps the interpreter cannot close from the
/// model alone: derived value-object arithmetic is really COMPUTED, a value object's own invariants really
/// fire while the given state is built, the emitted state machine really rejects an illegal transition,
/// and a guard's failure carries the real <c>DomainInvariantViolationException</c> message. So
/// <see cref="CheckOutcome.Indeterminate"/> disappears by construction here: the generated code either
/// computed a value or threw.</para>
///
/// <para><see cref="Run"/> NEVER throws. Anything the runner cannot drive — emitted code that does not
/// compile, a member it cannot bind, a failure it cannot attribute to a modelled statement — comes back as
/// <c>Ok: false</c> plus a note naming exactly what could not be driven. Never a guess.</para>
/// </summary>
internal sealed class ScenarioExecutor
{
    /// <summary>The emitted runtime exception every invariant/guard violation surfaces as. Matched by
    /// NAME: it lives in the GENERATED assembly, which this project only ever sees reflectively.</summary>
    private const string ViolationExceptionName = "DomainInvariantViolationException";

    /// <summary>The prefix the C# emitter gives a state-machine reachability guard's rule.</summary>
    private const string IllegalTransitionPrefix = "illegal transition of ";

    /// <summary>How many Roslyn errors a failed compile reports before the note is truncated.</summary>
    private const int MaxReportedCompileErrors = 5;

    /// <summary>
    /// How many levels of policy reaction a run explores past the operation under test (issue #1758,
    /// decision D5). Three, because: the shipped templates' deepest declared chain is ONE hop, so three
    /// truncates nothing real; three levels still show a chain's *shape* (the trigger, its reaction, and
    /// that reaction's own reaction) rather than only its first step, which is what makes a cascade legible
    /// at all; and every level multiplies the timeline a human has to read while the visited set — not the
    /// cap — is what actually catches cycles. The cap exists to bound the pathological case a visited set
    /// cannot see (a genuinely deep, non-repeating chain), and it must bite far inside
    /// <c>ScenarioExecutionHost.DefaultTimeout</c> so such a model is diagnosed as truncated rather than
    /// reported as "your model may loop". Hitting it is always a note, never a silent stop.
    /// </summary>
    private const int MaxFanOutDepth = 3;

    private static readonly IReadOnlyDictionary<string, string> NoState =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private readonly SemanticModel _sema;
    private readonly ModelIndex _index;
    private readonly ScenarioValueBinder _binder;
    private readonly ScenarioFanOutResolver _fanOut;
    private readonly List<string> _notes = [];

    private EntityDecl _entity = null!;

    private ScenarioExecutor(SemanticModel sema)
    {
        _sema = sema;
        _index = sema.Index;
        _binder = new ScenarioValueBinder(_index);
        _fanOut = new ScenarioFanOutResolver(sema);
    }

    /// <summary>Runs <paramref name="scenario"/> against the code <paramref name="sema"/> emits, and
    /// returns its timeline. Never throws: every failure is an <c>Ok: false</c> result with a note.</summary>
    public static ScenarioResult Run(SemanticModel sema, Scenario scenario)
    {
        var executor = new ScenarioExecutor(sema);
        try
        {
            return executor.RunCore(scenario);
        }
        catch (Exception ex)
        {
            Exception failure = Unwrap(ex);
            executor._notes.Add(
                ScenarioSandbox.ResourceCeilingNote(failure)
                ?? $"The scenario could not be executed: {Describe(failure)}");
            return executor.Failed(scenario);
        }
    }

    // ------------------------------------------------------------------------
    // Emit -> compile -> run
    // ------------------------------------------------------------------------

    private ScenarioResult RunCore(Scenario s)
    {
        EntityDecl? entity = ResolveEntity(s.Target);
        if (entity is null)
        {
            _notes.Add($"Unknown target '{s.Target}': no aggregate or entity by that name.");
            return Failed(s);
        }

        _entity = entity;

        CommandDecl? command = entity.Commands.FirstOrDefault(c => c.Name == s.Operation);
        FactoryDecl? factory = command is null
            ? entity.Factories.FirstOrDefault(f => f.Name == s.Operation)
            : null;
        if (command is null && factory is null)
        {
            _notes.Add($"Unknown operation '{s.Operation}' on '{entity.Name}': no command or factory by that name.");
            return Failed(s);
        }

        IReadOnlyList<EmittedFile> files;
        try
        {
            files = new CSharpEmitter().Emit(_sema.Model, _sema);
        }
        catch (Exception ex)
        {
            _notes.Add($"The model could not be emitted to C#, so '{s.Operation}' could not be executed: {Describe(ex)}");
            return Failed(s);
        }

        // A COLLECTIBLE context so a long-lived host (the LSP / Studio) reclaims each run's assembly
        // instead of leaking one per scenario.
        var context = new AssemblyLoadContext($"koine-scenario-{Guid.NewGuid():N}", isCollectible: true);
        try
        {
            var (assembly, errors) = GeneratedAssemblyCompiler.Compile(files, runRegexGenerator: true, context);
            if (assembly is null)
            {
                _notes.Add($"The emitted C# did not compile, so '{s.Operation}' could not be executed "
                           + $"({errors.Count} error(s)) — this is an emitter bug, not a scenario failure.");
                foreach (string error in errors.Take(MaxReportedCompileErrors))
                {
                    _notes.Add(error);
                }

                if (errors.Count > MaxReportedCompileErrors)
                {
                    _notes.Add($"… and {errors.Count - MaxReportedCompileErrors} further compile error(s).");
                }

                return Failed(s);
            }

            return Execute(s, assembly, command, factory);
        }
        finally
        {
            context.Unload();
        }
    }

    private ScenarioResult Execute(Scenario s, Assembly assembly, CommandDecl? command, FactoryDecl? factory)
    {
        if (!TryResolveType(assembly, _entity.Name, out Type? entityType))
        {
            return Failed(s);
        }

        IReadOnlyList<CommandStmt> body = command?.Body ?? factory!.Body;
        IReadOnlyList<Param> parameters = command?.Parameters ?? factory!.Parameters;
        bool isFactory = factory is not null;

        MethodInfo? method = entityType!
            .GetMethods(BindingFlags.Public | (isFactory ? BindingFlags.Static : BindingFlags.Instance))
            .FirstOrDefault(m => m.Name == ScenarioValueBinder.Pascal(s.Operation)
                                 && m.GetParameters().Length == parameters.Count);
        if (method is null)
        {
            _notes.Add($"The emitted '{entityType.Name}' has no {(isFactory ? "static factory" : "method")} "
                       + $"'{ScenarioValueBinder.Pascal(s.Operation)}' taking {parameters.Count} argument(s); "
                       + "the operation could not be driven.");
            return Failed(s);
        }

        if (!TryBindArguments(s, method, out object?[] args))
        {
            return Failed(s);
        }

        // A factory builds its own instance, so `given` has nothing to construct from.
        object? instance = null;
        if (!isFactory)
        {
            if (!TryConstructGivenState(_entity, entityType, s.Given, out instance, out Exception? constructionFailure))
            {
                return constructionFailure is null ? Failed(s) : GivenStateViolation(s, constructionFailure);
            }
        }
        else if (s.Given.Count > 0)
        {
            _notes.Add($"'{s.Operation}' is a factory: it builds the instance itself, so the given state was not applied.");
        }

        IReadOnlyDictionary<string, string> before = instance is null ? NoState : Snapshot(_entity, instance, recordNotes: false);

        object? returned;
        try
        {
            returned = method.Invoke(instance, args);
        }
        catch (Exception ex)
        {
            Exception failure = Unwrap(ex);

            // A sandbox resource ceiling is not the operation FAILING — nothing about the domain rejected
            // anything — so it must not be dressed up as an operation failure with a timeline. Report the
            // ceiling by name and stop (issue #1759).
            if (ScenarioSandbox.ResourceCeilingNote(failure) is { } ceiling)
            {
                _notes.Add(ceiling);
                return Failed(s);
            }

            return OperationFailure(s, failure, instance, body, before);
        }

        object? subject = isFactory ? returned : instance;
        if (subject is null)
        {
            _notes.Add($"'{s.Operation}' returned no instance to read the resulting state from.");
            return Failed(s);
        }

        Dictionary<string, string> after = Snapshot(_entity, subject, recordNotes: true);
        string? result = null;
        List<ScenarioStep> steps = SuccessSteps(body, before, after, subject, returned, ref result);

        // The primary operation SUCCEEDED, so what the model says happens next is worth exploring
        // (#1758). Only on the success path: a failed primary emitted nothing to fan out from, and
        // #1738's short-circuit semantics — nothing past the failing statement happened — must hold.
        // Wrapped on its own so a fan-out failure degrades to a note instead of costing the primary
        // result, which Run's catch-all would otherwise discard.
        try
        {
            FanOut(assembly, s, _entity, subject, steps, after, [], depth: 0);
        }
        catch (Exception ex)
        {
            Exception failure = Unwrap(ex);
            _notes.Add(ScenarioSandbox.ResourceCeilingNote(failure)
                       ?? $"The downstream reactions could not be explored: {Describe(failure)}. The primary "
                          + "operation's own result is unaffected.");
        }

        // The emitted operation ran its own CheckInvariants() and did not throw, so every declared
        // invariant holds against the post-command state — proven, not assumed.
        var invariants = _entity.Invariants
            .Select(i => new InvariantCheck(i.Message, i.Condition.ToFullString(), CheckOutcome.Passed))
            .ToList();

        return new ScenarioResult(true, _entity.Name, s.Operation, steps, after, invariants, result, _notes);
    }

    // ------------------------------------------------------------------------
    // Resolution
    // ------------------------------------------------------------------------

    /// <summary>Find the entity for a target name: an entity directly, an aggregate's root, or the last
    /// segment of a qualified <c>Context.Type</c> name — the same resolution Approach B uses.</summary>
    private EntityDecl? ResolveEntity(string target)
    {
        string name = target.Contains('.') ? target[(target.LastIndexOf('.') + 1)..] : target;

        List<EntityDecl> entities = NodeWalker.Descendants(_sema.Model).OfType<EntityDecl>().ToList();

        EntityDecl? direct = entities.FirstOrDefault(e => e.Name == name);
        if (direct is not null)
        {
            return direct;
        }

        AggregateDecl? aggregate = NodeWalker.Descendants(_sema.Model).OfType<AggregateDecl>()
            .FirstOrDefault(a => a.Name == name);
        return aggregate is null ? null : entities.FirstOrDefault(e => e.Name == aggregate.RootName);
    }

    /// <summary>
    /// Locates the emitted CLR type for a Koine type name. The emitter namespaces types by bounded
    /// context, so several CLR types can share a simple name; the candidates are narrowed to the context
    /// that DECLARES <paramref name="koineName"/> — which disambiguates a name the emitter also re-emits
    /// per context (a re-exported shared-kernel type), but NOT a name genuinely declared in more than one
    /// context.
    /// <para>That second case is reported as ambiguous rather than guessed at. Resolving it would need the
    /// scenario's target qualifier (<c>Payment.Order</c>), which <see cref="ResolveEntity"/> deliberately
    /// strips — <see cref="ScenarioInterpreter"/> (Approach B) resolves a target by simple name too, and
    /// the two runners must pick the SAME entity for the same scenario, so qualifier support belongs in
    /// both at once, not here alone.</para>
    /// </summary>
    private bool TryResolveType(Assembly assembly, string koineName, out Type? type)
    {
        type = null;
        List<Type> candidates = assembly.GetTypes().Where(t => t.Name == koineName).ToList();
        if (candidates.Count == 0)
        {
            _notes.Add($"The emitted assembly has no type named '{koineName}'; the scenario could not be driven.");
            return false;
        }

        if (candidates.Count > 1 && ContextOf(koineName) is { } context)
        {
            List<Type> scoped = candidates
                .Where(t => t.Namespace == context || (t.Namespace?.StartsWith(context + ".", StringComparison.Ordinal) ?? false))
                .ToList();
            if (scoped.Count > 0)
            {
                candidates = scoped;
            }
        }

        if (candidates.Count > 1)
        {
            _notes.Add($"'{koineName}' is ambiguous in the emitted assembly "
                       + $"({string.Join(", ", candidates.Select(c => c.FullName))}); the scenario could not be driven.");
            return false;
        }

        type = candidates[0];
        return true;
    }

    /// <summary>The bounded context declaring <paramref name="koineName"/>, or <c>null</c> when it is
    /// declared in none or in several.</summary>
    private string? ContextOf(string koineName)
    {
        IReadOnlyList<string> declaring = _index.DeclaringContextsOf(koineName);
        return declaring.Count == 1 ? declaring[0] : null;
    }

    // ------------------------------------------------------------------------
    // Inputs: given state and arguments
    // ------------------------------------------------------------------------

    /// <summary>
    /// Builds <paramref name="entity"/>'s given state through its own (emitter-generated, often private)
    /// all-args constructor, so the constructor's <c>CheckInvariants()</c> and every value object it builds
    /// really run. Returns <c>false</c> with <paramref name="violation"/> set when the emitted code REJECTED
    /// the state (a domain outcome to report, not an error), or with it <c>null</c> when a value simply
    /// could not be bound.
    ///
    /// <para>The entity and its <c>given</c> map are PARAMETERS rather than the scenario's own, because
    /// fan-out (issue #1758) establishes the very same way for a DOWNSTREAM aggregate, from the slice of
    /// the scenario's given state routed to it — see <see cref="ScenarioDownstreamState"/>.</para>
    /// </summary>
    private bool TryConstructGivenState(
        EntityDecl entity,
        Type entityType,
        IReadOnlyDictionary<string, ScenarioValue> given,
        out object? instance,
        out Exception? violation)
    {
        instance = null;
        violation = null;

        ConstructorInfo? ctor = entityType
            .GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .Where(c => c.GetParameters().Length > 0)
            .MaxBy(c => c.GetParameters().Length);
        if (ctor is null)
        {
            _notes.Add($"The emitted '{entityType.Name}' has no constructor the runner can build a given state with.");
            return false;
        }

        // Binding is inside the try as well as the construction: a nested value object builds through its
        // OWN emitted constructor, so a violated `Money` invariant surfaces here, not from ctor.Invoke.
        try
        {
            ParameterInfo[] parameters = ctor.GetParameters();
            var args = new object?[parameters.Length];
            for (int i = 0; i < parameters.Length; i++)
            {
                if (!TryBindConstructorParameter(entity, entityType, given, parameters[i], out args[i]))
                {
                    return false;
                }
            }

            instance = ctor.Invoke(args);
            return true;
        }
        catch (Exception ex)
        {
            violation = Unwrap(ex);
            return false;
        }
    }

    private bool TryBindConstructorParameter(
        EntityDecl entity,
        Type entityType,
        IReadOnlyDictionary<string, ScenarioValue> given,
        ParameterInfo parameter,
        out object? bound)
    {
        bound = null;
        string name = parameter.Name ?? string.Empty;

        Member? member = entity.Members.FirstOrDefault(m => string.Equals(m.Name, name, StringComparison.OrdinalIgnoreCase));
        if (member is null)
        {
            // The synthetic identity the emitter threads through as `id`.
            if (string.Equals(name, "id", StringComparison.OrdinalIgnoreCase))
            {
                return TryBindIdentity(given, parameter, out bound);
            }

            if (parameter.HasDefaultValue)
            {
                bound = parameter.DefaultValue;
                return true;
            }

            _notes.Add($"Constructor parameter '{name}' of the emitted '{entityType.Name}' matches no declared "
                       + "member; the given state could not be built.");
            return false;
        }

        if (given.TryGetValue(member.Name, out ScenarioValue? supplied))
        {
            if (_binder.TryBind(supplied, parameter.ParameterType, out bound, out string? error))
            {
                return true;
            }

            _notes.Add($"The given value for '{member.Name}' could not be bound: {error}.");
            return false;
        }

        // No given value: a constant default (`status: OrderStatus = Draft`) is emitted as an optional
        // parameter the constructor fills in itself, and an optional member is simply absent.
        if (parameter.HasDefaultValue)
        {
            bound = parameter.DefaultValue;
            return true;
        }

        if (member.Type.IsOptional)
        {
            return true; // null
        }

        _notes.Add($"No 'given' value for required field '{member.Name}'; the runner will not guess one, "
                   + $"so '{entity.Name}' could not be constructed.");
        return false;
    }

    private bool TryBindIdentity(
        IReadOnlyDictionary<string, ScenarioValue> given,
        ParameterInfo parameter,
        out object? bound)
    {
        bound = null;

        if (given.TryGetValue("id", out ScenarioValue? supplied))
        {
            if (_binder.TryBind(supplied, parameter.ParameterType, out bound, out string? error))
            {
                return true;
            }

            _notes.Add($"The given identity could not be bound: {error}.");
            return false;
        }

        MethodInfo? mint = parameter.ParameterType.GetMethod("New", BindingFlags.Public | BindingFlags.Static, Type.EmptyTypes);
        if (mint is not null)
        {
            bound = mint.Invoke(null, null);
            return true;
        }

        _notes.Add($"No 'given' identity, and '{ScenarioValueBinder.Describe(parameter.ParameterType)}' cannot "
                   + "mint one (a non-Guid identity has no generator); the given state could not be built.");
        return false;
    }

    private bool TryBindArguments(Scenario s, MethodInfo method, out object?[] args)
    {
        ParameterInfo[] parameters = method.GetParameters();
        args = new object?[parameters.Length];

        for (int i = 0; i < parameters.Length; i++)
        {
            ParameterInfo parameter = parameters[i];
            string name = parameter.Name ?? string.Empty;
            KeyValuePair<string, ScenarioValue> supplied = s.Args
                .FirstOrDefault(a => string.Equals(a.Key, name, StringComparison.OrdinalIgnoreCase));

            if (supplied.Value is null)
            {
                if (parameter.HasDefaultValue)
                {
                    args[i] = parameter.DefaultValue;
                    continue;
                }

                _notes.Add($"No argument supplied for parameter '{name}' of '{s.Operation}'; the runner will "
                           + "not guess one.");
                return false;
            }

            if (!_binder.TryBind(supplied.Value, parameter.ParameterType, out args[i], out string? error))
            {
                _notes.Add($"The argument for '{name}' could not be bound: {error}.");
                return false;
            }
        }

        return true;
    }

    // ------------------------------------------------------------------------
    // Fan-out: the downstream aggregate's starting state (#1758, decision D2)
    // ------------------------------------------------------------------------

    /// <summary>
    /// Establishes the state one fanned-out <paramref name="target"/> would run from, by wiring D2's rule
    /// (<see cref="ScenarioDownstreamState.Establish"/>) to the REAL emitted constructor: the routed
    /// per-aggregate <c>given</c> slice is built through the downstream entity's own all-args constructor,
    /// so its value objects and invariants fire exactly as the primary aggregate's do.
    ///
    /// <para>Every outcome is honest. A factory needs no prior instance; a rejected given state comes back
    /// as <see cref="DownstreamState.Rejected"/> carrying the real
    /// <c>DomainInvariantViolationException</c> so it can be reported as the failed step it is; anything
    /// else is <see cref="DownstreamState.Unavailable"/> with a reason. No path invents an instance.</para>
    ///
    /// <para>Dispatching the target from that state is deliberately NOT done here — this seam only
    /// establishes it.</para>
    /// </summary>
    internal DownstreamState EstablishDownstreamState(Assembly assembly, Scenario s, FanOutTarget target)
    {
        EntityDecl? entity = ResolveEntity(target.EntityName);
        if (entity is null)
        {
            return new DownstreamState.Unavailable(
                $"No state was established for {target.EntityName}: the model declares no entity by that name.");
        }

        return ScenarioDownstreamState.Establish(target, _entity?.Name ?? s.Target, s.Given, routed =>
        {
            // Resolved inside the construction, so a target that needs no instance never pays for it —
            // and never fails on a type-resolution note it did not need.
            if (!TryResolveType(assembly, entity.Name, out Type? entityType))
            {
                return new DownstreamState.Unavailable(
                    $"No state was established for {entity.Name}: its emitted type could not be located.");
            }

            if (TryConstructGivenState(entity, entityType!, routed, out object? instance, out Exception? violation))
            {
                return new DownstreamState.Instance(instance!);
            }

            return violation is not null
                ? new DownstreamState.Rejected(violation)
                : new DownstreamState.Unavailable(
                    $"No state was established for {entity.Name}: the given state routed to it could not be "
                    + "built (see the notes above for the value that failed to bind).");
        });
    }

    // ------------------------------------------------------------------------
    // Fan-out: dispatching the downstream reactions (#1758, decisions D1/D3–D6)
    // ------------------------------------------------------------------------

    /// <summary>
    /// Explores what the model says happens NEXT, from the events <paramref name="subject"/> really
    /// recorded: each is resolved to its declared downstream (<see cref="ScenarioFanOutResolver"/>), the
    /// executable reactions are dispatched into <paramref name="steps"/> attributed to the aggregate that
    /// produced them, their post-state merges into <paramref name="state"/> under
    /// <c>&lt;Entity&gt;.&lt;member&gt;</c> keys (D4), and each dispatched target is recursed on.
    ///
    /// <para>The cascade is bounded twice over (D5), because one bound cannot do the job alone:
    /// <paramref name="visited"/> — the <c>(aggregate, event)</c> pairs already dispatched — terminates a
    /// CYCLIC model no matter how the cap is set, and <see cref="MaxFanOutDepth"/> truncates a genuinely
    /// deep, non-repeating chain a visited set can never see. Hitting either is a note naming which bound
    /// bit and what was left unexplored; neither ever stops silently.</para>
    /// </summary>
    private void FanOut(
        Assembly assembly,
        Scenario s,
        EntityDecl subjectEntity,
        object subject,
        List<ScenarioStep> steps,
        Dictionary<string, string> state,
        HashSet<(string Aggregate, string Event)> visited,
        int depth)
    {
        List<object> events = DomainEventsOf(subject);
        if (events.Count == 0)
        {
            return;
        }

        string context = ContextOf(subjectEntity.Name) ?? string.Empty;

        foreach (object recorded in events)
        {
            // The RUNTIME event object's type name, not a re-reading of the body's `emit` clauses: an
            // event the emitted code really recorded is higher fidelity than one the model merely says
            // it would record.
            string eventName = recorded.GetType().Name;
            FanOutResolution resolution = _fanOut.Resolve(context, eventName);
            if (resolution.IsEmpty)
            {
                continue;
            }

            // D1: a cross-context subscription is DECLARED and not executable — every emitter gives it
            // only a bodiless handler seam — so it is said out loud and never fabricated into a step.
            //
            // Unreachable from a RECORDED event as the language stands: `emit X` resolves X to an
            // `EventDecl` (EntityBehaviorValidator.ValidateEmit), and `integration event X` builds an
            // `IntegrationEventDecl`, so no command can emit a published event today — which is why the
            // shipped templates publish `OrderPlaced` and emit `OrderPlacedInternally`. Kept because the
            // resolver answers this question either way (and is tested doing so): the day `emit` accepts
            // an integration event, the runner already reports it honestly instead of silently pretending
            // the boundary was crossed.
            if (resolution.DeclaredOnly.Count > 0)
            {
                _notes.Add($"'{eventName}' crosses a context boundary to "
                           + $"{Join(resolution.DeclaredOnly.Select(sub => sub.Context).ToList())}, which the model "
                           + "declares a subscription for and no executable handler (the emitter produces only a "
                           + "handler seam), so no downstream step was run for it.");
            }

            foreach (FanOutTarget target in resolution.Executable)
            {
                if (depth >= MaxFanOutDepth)
                {
                    _notes.Add($"Fan-out stopped at the maximum depth of {MaxFanOutDepth}: the reaction to "
                               + $"'{eventName}' declared by policy '{target.PolicyName}' "
                               + $"({target.EntityName}.{target.MemberName}) was not explored.");
                    continue;
                }

                if (!visited.Add((target.EntityName, eventName)))
                {
                    _notes.Add($"Fan-out stopped on a cycle: '{target.EntityName}' has already reacted to "
                               + $"'{eventName}' in this run, so policy '{target.PolicyName}' "
                               + $"({target.EntityName}.{target.MemberName}) was not dispatched again.");
                    continue;
                }

                Dispatch(assembly, s, eventName, recorded, target, steps, state, visited, depth);
            }
        }
    }

    /// <summary>
    /// Runs ONE resolved reaction: establish the downstream aggregate's state (D2), invoke the reaction's
    /// emitted member on it with arguments read off the upstream event, record the steps it produced —
    /// attributed to that aggregate — and recurse on the events it in turn recorded.
    ///
    /// <para>Every outcome the run cannot drive is honest: an unavailable state, an unbindable argument
    /// and a reaction that no emitted method backs are notes (plus, for the first, the failed
    /// <see cref="ScenarioStep.Precondition"/> D2's clause 3 calls for); a violation is a failed step
    /// carrying the emitted code's real message. Nothing here invents an instance or a value.</para>
    /// </summary>
    private void Dispatch(
        Assembly assembly,
        Scenario s,
        string eventName,
        object eventObject,
        FanOutTarget target,
        List<ScenarioStep> steps,
        Dictionary<string, string> state,
        HashSet<(string Aggregate, string Event)> visited,
        int depth)
    {
        EntityDecl? entity = ResolveEntity(target.EntityName);
        if (entity is null)
        {
            _notes.Add($"Policy '{target.PolicyName}' reacts to '{eventName}' on '{target.EntityName}', for which "
                       + "the model declares no entity; the reaction could not be driven.");
            return;
        }

        CommandDecl? command = entity.Commands.FirstOrDefault(c => c.Name == target.MemberName);
        FactoryDecl? factory = command is null
            ? entity.Factories.FirstOrDefault(f => f.Name == target.MemberName)
            : null;
        if (command is null && factory is null)
        {
            _notes.Add($"Policy '{target.PolicyName}' invokes '{target.EntityName}.{target.MemberName}', which is "
                       + "neither a command nor a factory; the reaction could not be driven.");
            return;
        }

        object? instance;
        switch (EstablishDownstreamState(assembly, s, target))
        {
            case DownstreamState.Instance live:
                instance = live.Value;
                break;

            case DownstreamState.StaticTarget:
                instance = null; // a factory builds its own
                break;

            case DownstreamState.Rejected rejected:
                steps.Add(DownstreamGivenViolation(target, rejected.Violation));
                return;

            case DownstreamState.Unavailable unavailable:
                // D2 clause 3: a failed precondition attributed to the aggregate, plus the reason —
                // which names the exact `<Entity>.<member>` key that would have driven it.
                _notes.Add(unavailable.Reason);
                steps.Add(new ScenarioStep.Precondition(
                    $"no state was established for {target.EntityName}, so '{target.MemberName}' could not be driven",
                    $"policy {target.PolicyName}: when {eventName} then {target.AggregateName}.{target.MemberName}",
                    CheckOutcome.Failed)
                {
                    Aggregate = target.EntityName,
                });
                return;

            default:
                return;
        }

        if (!TryResolveType(assembly, entity.Name, out Type? entityType))
        {
            return;
        }

        IReadOnlyList<CommandStmt> body = command?.Body ?? factory!.Body;
        IReadOnlyList<Param> parameters = command?.Parameters ?? factory!.Parameters;
        bool isFactory = factory is not null;
        string pascal = ScenarioValueBinder.Pascal(target.MemberName);

        MethodInfo? method = entityType!
            .GetMethods(BindingFlags.Public | (isFactory ? BindingFlags.Static : BindingFlags.Instance))
            .FirstOrDefault(m => m.Name == pascal && m.GetParameters().Length == parameters.Count);
        if (method is null)
        {
            _notes.Add($"The emitted '{entityType.Name}' has no {(isFactory ? "static factory" : "method")} "
                       + $"'{pascal}' taking {parameters.Count} argument(s), so policy '{target.PolicyName}' "
                       + "could not be driven.");
            return;
        }

        if (!TryBindPolicyArguments(method, target, eventObject, out object?[] args))
        {
            return;
        }

        IReadOnlyDictionary<string, string> before =
            instance is null ? NoState : Snapshot(entity, instance, recordNotes: false);

        object? returned;
        try
        {
            returned = method.Invoke(instance, args);
        }
        catch (Exception ex)
        {
            Exception failure = Unwrap(ex);

            // A sandbox ceiling is not the reaction failing, so it is reported by name and stops the
            // cascade rather than being dressed up as a domain outcome (#1759).
            if (ScenarioSandbox.ResourceCeilingNote(failure) is { } ceiling)
            {
                _notes.Add(ceiling);
                return;
            }

            steps.AddRange(DownstreamFailureSteps(entity, target, failure, body, before, instance));
            if (instance is not null)
            {
                Merge(state, entity, Snapshot(entity, instance, recordNotes: false));
            }

            return;
        }

        object? downstream = isFactory ? returned : instance;
        if (downstream is null)
        {
            _notes.Add($"Policy '{target.PolicyName}' invoked '{target.EntityName}.{target.MemberName}', which "
                       + "returned no instance to read the resulting state from.");
            return;
        }

        Dictionary<string, string> after = Snapshot(entity, downstream, recordNotes: true);
        string? unusedResult = null;
        foreach (ScenarioStep step in SuccessSteps(body, before, after, downstream, returned, ref unusedResult))
        {
            steps.Add(step with { Aggregate = entity.Name });
        }

        Merge(state, entity, after);

        // The reaction may itself have emitted: keep going, under the same two bounds.
        FanOut(assembly, s, entity, downstream, steps, state, visited, depth + 1);
    }

    /// <summary>D4: a downstream aggregate's state merges under <c>&lt;Entity&gt;.&lt;member&gt;</c> keys, so
    /// the primary aggregate keeps its bare member names and nothing collides.</summary>
    private static void Merge(
        Dictionary<string, string> state,
        EntityDecl entity,
        IReadOnlyDictionary<string, string> downstream)
    {
        foreach ((string member, string value) in downstream)
        {
            state[$"{entity.Name}.{member}"] = value;
        }
    }

    /// <summary>
    /// Binds the reaction's arguments from the UPSTREAM event object. A <see cref="PolicyArg"/>'s value is
    /// an <see cref="Expr"/>, and the shape the language produces here is overwhelmingly a plain identifier
    /// naming one of the event's fields (<c>then Books.record(amount: capturedAmount)</c>), read straight
    /// off the recorded instance. Anything the runner cannot evaluate is refused with a note naming the
    /// policy and the argument — it does not evaluate half an expression and call the result a fact.
    /// </summary>
    private bool TryBindPolicyArguments(MethodInfo method, FanOutTarget target, object eventObject, out object?[] args)
    {
        ParameterInfo[] parameters = method.GetParameters();
        args = new object?[parameters.Length];

        for (int i = 0; i < parameters.Length; i++)
        {
            ParameterInfo parameter = parameters[i];
            string name = parameter.Name ?? string.Empty;
            PolicyArg? supplied = target.Args
                .FirstOrDefault(a => string.Equals(a.Parameter, name, StringComparison.OrdinalIgnoreCase));

            if (supplied is null)
            {
                if (parameter.HasDefaultValue)
                {
                    args[i] = parameter.DefaultValue;
                    continue;
                }

                _notes.Add($"Policy '{target.PolicyName}' supplies no argument for parameter '{name}' of "
                           + $"'{target.EntityName}.{target.MemberName}'; the reaction was not dispatched.");
                return false;
            }

            if (!TryReadEventValue(supplied.Value, eventObject, out object? value))
            {
                _notes.Add($"Policy '{target.PolicyName}' binds '{supplied.Parameter}' from "
                           + $"\"{Lowerer.SourceText(supplied.Value)}\", which the runner cannot evaluate against "
                           + $"'{eventObject.GetType().Name}'; the reaction was not dispatched rather than driven "
                           + "with a guessed value.");
                return false;
            }

            if (!TryCoerce(value, parameter.ParameterType, out args[i]))
            {
                _notes.Add($"Policy '{target.PolicyName}' binds '{supplied.Parameter}' to a value of type "
                           + $"'{value?.GetType().Name ?? "null"}', which does not fit parameter '{name}' of type "
                           + $"'{ScenarioValueBinder.Describe(parameter.ParameterType)}'; the reaction was not "
                           + "dispatched.");
                return false;
            }
        }

        return true;
    }

    /// <summary>Reads a policy argument's expression off the recorded event: an identifier naming one of
    /// its fields, or a member access rooted in one. Returns <c>false</c> — never a null passed off as a
    /// value — for a field the event does not carry or a shape this cannot evaluate.</summary>
    private static bool TryReadEventValue(Expr expr, object eventObject, out object? value)
    {
        value = null;

        switch (expr)
        {
            case IdentifierExpr id:
                {
                    string property = ScenarioValueBinder.Pascal(id.Name);
                    if (eventObject.GetType().GetProperty(property, BindingFlags.Public | BindingFlags.Instance) is null)
                    {
                        return false;
                    }

                    value = ScenarioValueBinder.ReadProperty(eventObject, property);
                    return true;
                }

            case MemberAccessExpr access:
                {
                    if (!TryReadEventValue(access.Target, eventObject, out object? owner) || owner is null)
                    {
                        return false;
                    }

                    string property = ScenarioValueBinder.Pascal(access.MemberName);
                    if (owner.GetType().GetProperty(property, BindingFlags.Public | BindingFlags.Instance) is null)
                    {
                        return false;
                    }

                    value = ScenarioValueBinder.ReadProperty(owner, property);
                    return true;
                }

            default:
                return false;
        }
    }

    /// <summary>Fits an event's field onto the reaction parameter it drives: assignable as-is, or through
    /// the framework's own conversion for the numeric widening a model expresses freely (an <c>Int</c>
    /// field into a <c>Decimal</c> parameter). A value neither route accepts is refused, not forced.</summary>
    private static bool TryCoerce(object? value, Type target, out object? coerced)
    {
        coerced = value;

        if (value is null)
        {
            return !target.IsValueType || Nullable.GetUnderlyingType(target) is not null;
        }

        Type underlying = Nullable.GetUnderlyingType(target) ?? target;
        if (underlying.IsInstanceOfType(value))
        {
            return true;
        }

        try
        {
            coerced = Convert.ChangeType(value, underlying, CultureInfo.InvariantCulture);
            return true;
        }
        catch (Exception ex) when (ex is InvalidCastException or FormatException or OverflowException or ArgumentException)
        {
            coerced = null;
            return false;
        }
    }

    /// <summary>The state routed to a downstream aggregate was REJECTED by the emitted code — a real domain
    /// outcome, reported with its real message exactly the way <see cref="GivenStateViolation"/> reports the
    /// primary aggregate's own.</summary>
    private ScenarioStep DownstreamGivenViolation(FanOutTarget target, Exception violation)
    {
        if (!TryReadViolation(violation, out string typeName, out string rule))
        {
            _notes.Add($"The given state routed to '{target.EntityName}' could not be built: {Describe(violation)}");
            return new ScenarioStep.Precondition(violation.Message, Describe(violation), CheckOutcome.Failed)
            {
                Aggregate = target.EntityName,
            };
        }

        _notes.Add($"The given state routed to '{target.EntityName}' was rejected by '{typeName}': {rule}");
        return new ScenarioStep.Precondition(rule, rule, CheckOutcome.Failed) { Aggregate = target.EntityName };
    }

    /// <summary>
    /// A downstream reaction THREW. Attributed with the very same taxonomy the primary path uses
    /// (<see cref="TryReadViolation"/> + <see cref="WalkToViolation"/>), so a fanned-out guard, illegal
    /// transition or invariant renders identically to the primary aggregate's — only attributed to the
    /// aggregate that raised it. An unattributable throw is reported verbatim, never guessed at.
    /// </summary>
    private List<ScenarioStep> DownstreamFailureSteps(
        EntityDecl entity,
        FanOutTarget target,
        Exception failure,
        IReadOnlyList<CommandStmt> body,
        IReadOnlyDictionary<string, string> before,
        object? instance)
    {
        string where = $"{target.EntityName}.{target.MemberName}";

        if (!TryReadViolation(failure, out string typeName, out string rule))
        {
            _notes.Add($"The downstream '{where}' (policy '{target.PolicyName}') threw {Describe(failure)}; the "
                       + "failure could not be attributed to a modelled precondition, transition or invariant.");
            return
            [
                new ScenarioStep.Precondition(failure.Message, Describe(failure), CheckOutcome.Failed)
                {
                    Aggregate = entity.Name,
                }
            ];
        }

        if (typeName != entity.Name)
        {
            // A value object the reaction rebuilt rejected its new value — the same domain rule, rendered
            // the way the primary path renders the same case.
            _notes.Add($"The downstream '{where}' (policy '{target.PolicyName}') was rejected by '{typeName}': {rule}");
            return [new ScenarioStep.Precondition(rule, rule, CheckOutcome.Failed) { Aggregate = entity.Name }];
        }

        IReadOnlyDictionary<string, string> after =
            instance is null ? NoState : Snapshot(entity, instance, recordNotes: false);
        ViolationWalk walk = WalkToViolation(rule, body, before, after);

        if (walk.Source == ViolationSource.InvariantSweep)
        {
            // Nothing in the body claimed the rule: the emitted post-command sweep rejected the mutated
            // state. Resolve it back to the declared invariant so the step carries the modelled text.
            Invariant? violated = entity.Invariants.FirstOrDefault(i => RuleOf(i) == rule);
            walk.Steps.Add(new ScenarioStep.Precondition(
                violated?.Message ?? rule,
                violated?.Condition.ToFullString() ?? rule,
                CheckOutcome.Failed));
        }

        _notes.Add(walk.Source switch
        {
            ViolationSource.Precondition =>
                $"The downstream '{where}' (policy '{target.PolicyName}') was rejected by a precondition: {rule}",
            ViolationSource.StateMachine =>
                $"The downstream '{where}' (policy '{target.PolicyName}') was rejected by the '{walk.Field}' "
                + $"state machine: {rule}",
            _ => $"The downstream '{where}' (policy '{target.PolicyName}') left '{entity.Name}' violating an "
                 + $"invariant: {rule}"
        });

        return walk.Steps.Select(step => step with { Aggregate = entity.Name }).ToList();
    }

    /// <summary>"A", "A and B", "A, B and C".</summary>
    private static string Join(IReadOnlyList<string> names) => names.Count switch
    {
        0 => "no context",
        1 => names[0],
        2 => $"{names[0]} and {names[1]}",
        _ => $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}"
    };

    // ------------------------------------------------------------------------
    // The timeline
    // ------------------------------------------------------------------------

    private List<ScenarioStep> SuccessSteps(
        IReadOnlyList<CommandStmt> body,
        IReadOnlyDictionary<string, string> before,
        IReadOnlyDictionary<string, string> after,
        object subject,
        object? returned,
        ref string? result)
    {
        var steps = new List<ScenarioStep>();
        List<object> events = DomainEventsOf(subject);
        int cursor = 0;

        foreach (CommandStmt stmt in body)
        {
            switch (stmt)
            {
                case RequiresClause req:
                    // The emitted guard did not throw, so the precondition held. Proven, never a guess.
                    steps.Add(new ScenarioStep.Precondition(req.Message, req.Condition.ToFullString(), CheckOutcome.Passed));
                    break;

                case Transition t:
                    steps.Add(new ScenarioStep.Transition(
                        t.Field,
                        before.GetValueOrDefault(t.Field, "∅"),
                        after.GetValueOrDefault(t.Field, "∅"),
                        IsInitialization: false));
                    break;

                case Initialization init:
                    steps.Add(new ScenarioStep.Transition(
                        init.Field, From: null, after.GetValueOrDefault(init.Field, "∅"), IsInitialization: true));
                    break;

                case EmitClause emit:
                    steps.Add(EmitStep(emit, events, ref cursor));
                    break;

                case ResultClause:
                    result = _binder.Display(returned);
                    steps.Add(new ScenarioStep.Result(result));
                    break;
            }
        }

        return steps;
    }

    /// <summary>Reads the payload of the REAL domain event the emitted operation recorded, matching each
    /// <c>emit</c> statement to the next recorded event of that name.</summary>
    private ScenarioStep.Emit EmitStep(EmitClause emit, List<object> events, ref int cursor)
    {
        string clrName = ScenarioValueBinder.Pascal(emit.EventName);
        var args = new Dictionary<string, string>(StringComparer.Ordinal);

        int index = events.FindIndex(cursor, e => e.GetType().Name == clrName);
        if (index < 0)
        {
            _notes.Add($"'{emit.EventName}' is declared as emitted but no such event was recorded on the "
                       + "aggregate; its payload could not be read.");
            return new ScenarioStep.Emit(emit.EventName, args);
        }

        cursor = index + 1;
        foreach (EmitArg arg in emit.Args)
        {
            try
            {
                args[arg.Field] = _binder.Display(
                    ScenarioValueBinder.ReadProperty(events[index], ScenarioValueBinder.Pascal(arg.Field)));
            }
            catch (Exception ex)
            {
                args[arg.Field] = "⚠";
                _notes.Add($"Reading '{arg.Field}' off '{emit.EventName}' threw: {Describe(Unwrap(ex))}.");
            }
        }

        return new ScenarioStep.Emit(emit.EventName, args);
    }

    private static List<object> DomainEventsOf(object subject)
    {
        object? recorded = ScenarioValueBinder.ReadProperty(subject, "DomainEvents");
        return recorded is IEnumerable sequence
            ? sequence.Cast<object?>().Where(e => e is not null).Select(e => e!).ToList()
            : [];
    }

    /// <summary>Reads every member declared on <paramref name="entity"/> off the live instance — including
    /// the DERIVED ones, whose values the emitted code actually computed (gap #1). The entity is a
    /// parameter so a fanned-out downstream aggregate (issue #1758) is read exactly the same way.</summary>
    private Dictionary<string, string> Snapshot(EntityDecl entity, object instance, bool recordNotes)
    {
        var state = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Member member in entity.Members)
        {
            try
            {
                state[member.Name] = _binder.Display(
                    ScenarioValueBinder.ReadProperty(instance, ScenarioValueBinder.Pascal(member.Name)));
            }
            catch (Exception ex)
            {
                Exception inner = Unwrap(ex);
                state[member.Name] = "⚠ " + inner.Message;
                if (recordNotes)
                {
                    _notes.Add($"Reading '{member.Name}' threw: {Describe(inner)}.");
                }
            }
        }

        return state;
    }

    // ------------------------------------------------------------------------
    // Failure taxonomy
    // ------------------------------------------------------------------------

    /// <summary>The given state itself was rejected by the emitted code (gap #2) — a FEATURE, so it is
    /// reported as a failed invariant check carrying the real message, not as a runner error.</summary>
    private ScenarioResult GivenStateViolation(Scenario s, Exception ex)
    {
        if (!TryReadViolation(ex, out string typeName, out string rule))
        {
            _notes.Add($"The given state for '{_entity.Name}' could not be built: {Describe(ex)}");
            return Failed(s);
        }

        _notes.Add($"The given state was rejected by '{typeName}': {rule}");
        return new ScenarioResult(
            false, _entity.Name, s.Operation, [], NoState, [InvariantFor(typeName, rule)], null, _notes);
    }

    /// <summary>
    /// Attributes a thrown <c>DomainInvariantViolationException</c> to the modelled statement that raised
    /// it: a <c>requires</c> guard (gap #4), a state-machine reachability guard (gap #3), or the
    /// post-command invariant sweep. An unattributable throw is reported verbatim as a note — never
    /// guessed at.
    /// </summary>
    private ScenarioResult OperationFailure(
        Scenario s,
        Exception ex,
        object? instance,
        IReadOnlyList<CommandStmt> body,
        IReadOnlyDictionary<string, string> before)
    {
        IReadOnlyDictionary<string, string> state = instance is null ? NoState : Snapshot(_entity, instance, recordNotes: false);

        if (!TryReadViolation(ex, out string typeName, out string rule))
        {
            _notes.Add($"'{s.Operation}' threw {Describe(ex)}; the failure could not be attributed to a "
                       + "modelled precondition, transition or invariant.");
            return new ScenarioResult(false, _entity.Name, s.Operation, [], state, [], null, _notes);
        }

        if (typeName != _entity.Name)
        {
            // A value object the command REBUILT rejected its new value (a `Money` driven negative by a
            // discount). It belongs to no statement of this entity's body, but it is the same domain rule
            // the same violation in the given state resolves — so it renders identically (gap #2), never
            // discarded into a bare prose note.
            _notes.Add($"'{s.Operation}' was rejected by '{typeName}': {rule}");
            return new ScenarioResult(
                false, _entity.Name, s.Operation, [], state, [InvariantFor(typeName, rule)], null, _notes);
        }

        ViolationWalk walk = WalkToViolation(rule, body, before, state);

        switch (walk.Source)
        {
            case ViolationSource.Precondition:
                _notes.Add($"'{s.Operation}' was rejected by a precondition: {rule}");
                return new ScenarioResult(
                    false, _entity.Name, s.Operation, walk.Steps, state, InvariantsAfterHalt(walk.Mutated), null, _notes);

            case ViolationSource.StateMachine:
                _notes.Add($"'{s.Operation}' was rejected by the '{walk.Field}' state machine: {rule}");
                return new ScenarioResult(
                    false, _entity.Name, s.Operation, walk.Steps, state, InvariantsAfterHalt(walk.Mutated), null, _notes);

            default:
                // No guard matched: the post-command invariant sweep rejected the mutated state.
                return new ScenarioResult(
                    false, _entity.Name, s.Operation, walk.Steps, state, InvariantsUpTo(rule, s.Operation), null, _notes);
        }
    }

    /// <summary>Which modelled statement a thrown violation's rule turned out to belong to.</summary>
    private enum ViolationSource
    {
        /// <summary>A <c>requires</c> guard's own rule (gap #4).</summary>
        Precondition,

        /// <summary>A state-machine reachability guard refused the write (gap #3).</summary>
        StateMachine,

        /// <summary>No statement claimed it: the post-command invariant sweep threw.</summary>
        InvariantSweep
    }

    /// <summary>The outcome of walking a command body against a thrown violation: the steps that really
    /// ran (ending at the failing one, when a statement claimed the rule), what claimed it, whether any
    /// write happened first, and — for <see cref="ViolationSource.StateMachine"/> — the field guarded.</summary>
    private readonly record struct ViolationWalk(
        List<ScenarioStep> Steps,
        ViolationSource Source,
        bool Mutated,
        string Field);

    /// <summary>
    /// Walks <paramref name="body"/> the way the EMITTED code runs it and attributes
    /// <paramref name="rule"/> to the statement that raised it. Shared by the primary path
    /// (<see cref="OperationFailure"/>) and by fan-out (<see cref="DownstreamFailureSteps"/>), so a
    /// downstream failure gets the same taxonomy rather than a second, drifting one.
    ///
    /// <para>The emitter hoists EVERY <c>requires</c> ahead of the first write
    /// (<c>CSharpEmitter.WriteCommand</c>), while the grammar (<c>commandStmt*</c>) lets one be written
    /// after a transition. Walking in declaration order would then invent a transition for a write the
    /// guard prevented, and blame the missing invariant sweep on it — so the guards are walked first,
    /// exactly as the emitted code runs them. (<c>OrderBy</c> is a STABLE sort, so each group keeps its
    /// declaration order.) <c>emit</c> and <c>result</c> only run after the emitted
    /// <c>CheckInvariants()</c> sweep, so nothing past a violation happened on a failing run.</para>
    /// </summary>
    private static ViolationWalk WalkToViolation(
        string rule,
        IReadOnlyList<CommandStmt> body,
        IReadOnlyDictionary<string, string> before,
        IReadOnlyDictionary<string, string> after)
    {
        var steps = new List<ScenarioStep>();
        bool mutated = false;

        foreach (CommandStmt stmt in body.OrderBy(stmt => stmt is RequiresClause ? 0 : 1))
        {
            switch (stmt)
            {
                case RequiresClause req when RuleOf(req) == rule:
                    steps.Add(new ScenarioStep.Precondition(req.Message, req.Condition.ToFullString(), CheckOutcome.Failed));
                    return new ViolationWalk(steps, ViolationSource.Precondition, mutated, string.Empty);

                case RequiresClause req:
                    steps.Add(new ScenarioStep.Precondition(req.Message, req.Condition.ToFullString(), CheckOutcome.Passed));
                    break;

                case Transition t when rule.StartsWith(IllegalTransitionPrefix + t.Field + " to ", StringComparison.Ordinal):
                    // The emitted state machine refused the write. The transition never happened, so it is
                    // recorded as the failed GUARD it is rather than as a transition that did not occur.
                    steps.Add(new ScenarioStep.Precondition(
                        rule, $"{t.Field} -> {t.Value.ToFullString().Trim()}", CheckOutcome.Failed));
                    return new ViolationWalk(steps, ViolationSource.StateMachine, mutated, t.Field);

                case Transition t:
                    steps.Add(new ScenarioStep.Transition(
                        t.Field,
                        before.GetValueOrDefault(t.Field, "∅"),
                        after.GetValueOrDefault(t.Field, "∅"),
                        IsInitialization: false));
                    mutated = true;
                    break;

                case Initialization init:
                    steps.Add(new ScenarioStep.Transition(
                        init.Field, From: null, after.GetValueOrDefault(init.Field, "∅"), IsInitialization: true));
                    mutated = true;
                    break;
            }
        }

        return new ViolationWalk(steps, ViolationSource.InvariantSweep, mutated, string.Empty);
    }

    /// <summary>The invariant outcomes after a guard halted the command BEFORE any mutation: the state is
    /// still the constructed one, which the emitted constructor already proved. After a mutation nothing
    /// was re-checked, so nothing is claimed.</summary>
    private IReadOnlyList<InvariantCheck> InvariantsAfterHalt(bool mutated)
    {
        if (mutated)
        {
            _notes.Add("The command halted after a field write, so the emitted invariant sweep never ran; "
                       + "no invariant outcome is claimed.");
            return [];
        }

        return _entity.Invariants
            .Select(i => new InvariantCheck(i.Message, i.Condition.ToFullString(), CheckOutcome.Passed))
            .ToList();
    }

    /// <summary>The invariant outcomes when the emitted sweep threw: those before the offender held, the
    /// offender failed, and the ones after it were never reached — so they are reported as unevaluated in a
    /// note rather than guessed at.</summary>
    private IReadOnlyList<InvariantCheck> InvariantsUpTo(string rule, string operation)
    {
        var checks = new List<InvariantCheck>();
        foreach (Invariant invariant in _entity.Invariants)
        {
            string condition = invariant.Condition.ToFullString();
            if (RuleOf(invariant) == rule)
            {
                checks.Add(new InvariantCheck(invariant.Message, condition, CheckOutcome.Failed));
                _notes.Add($"'{operation}' left '{_entity.Name}' violating an invariant: {rule}");
                int unevaluated = _entity.Invariants.Count - checks.Count;
                if (unevaluated > 0)
                {
                    _notes.Add($"{unevaluated} further invariant(s) were not evaluated: the emitted "
                               + "CheckInvariants() throws on the first violation.");
                }

                return checks;
            }

            checks.Add(new InvariantCheck(invariant.Message, condition, CheckOutcome.Passed));
        }

        _notes.Add($"'{operation}' threw \"{rule}\", which matches no declared precondition, transition or "
                   + "invariant on this entity.");
        return [];
    }

    /// <summary>The failed check for a violation raised OUTSIDE the scenario's entity (a value object
    /// building the given state, or one the command rebuilt), resolved back to its declaration so the
    /// condition text is the modelled one; falls back to the emitted rule when the violation is a
    /// synthesized guard (the built-in <c>Range&lt;T&gt;</c>, a quantity's unit check).</summary>
    private InvariantCheck InvariantFor(string typeName, string rule)
    {
        foreach (Invariant invariant in InvariantsDeclaredOn(typeName))
        {
            if (RuleOf(invariant) == rule)
            {
                return new InvariantCheck(invariant.Message, invariant.Condition.ToFullString(), CheckOutcome.Failed);
            }
        }

        return new InvariantCheck(rule, rule, CheckOutcome.Failed);
    }

    /// <summary>
    /// The invariants declared on <paramref name="typeName"/>, resolved from the bounded context of the
    /// scenario's ENTITY rather than by a walk over the whole model: the pizzeria declares two distinct
    /// <c>Money</c> value objects (Ordering's carries a <c>Currency</c>, Payment's a <c>String</c>), and a
    /// flat by-name walk would resolve a Payment violation against Ordering's declaration purely by walk
    /// order. Falls back to the flat lookup for a type no context claims (a shared kernel entry).
    /// </summary>
    private IReadOnlyList<Invariant> InvariantsDeclaredOn(string typeName)
    {
        foreach (string context in _index.DeclaringContextsOf(_entity.Name))
        {
            if (_index.TryGetDeclIn(context, typeName, out TypeDecl scoped))
            {
                return InvariantsOf(scoped);
            }
        }

        return _index.TryGetDecl(typeName, out TypeDecl decl) ? InvariantsOf(decl) : [];
    }

    private static IReadOnlyList<Invariant> InvariantsOf(TypeDecl decl) => decl switch
    {
        ValueObjectDecl vo => vo.Invariants,
        EntityDecl entity => entity.Invariants,
        _ => []
    };

    /// <summary>The rule string the C# emitter gives a <c>requires</c> guard: its message, or the
    /// condition's source text when it has none.</summary>
    private static string RuleOf(RequiresClause requires) => requires.Message ?? RuleTextOf(requires.Condition);

    /// <summary>The rule string the C# emitter gives an <c>invariant</c>: its message, or the condition's
    /// source text when it has none.</summary>
    private static string RuleOf(Invariant invariant) => invariant.Message ?? RuleTextOf(invariant.Condition);

    /// <summary>
    /// Renders a message-less guard/invariant's condition the way the C# emitter does when it synthesizes
    /// the rule the thrown <c>DomainInvariantViolationException</c> carries — the emitter's
    /// <c>SynthesizeMessage</c> IS <see cref="Lowerer.SourceText"/>. It must not be confused with
    /// <see cref="KoineNode.ToFullString"/>, which concatenates child NODES only: Koine has no
    /// <c>SyntaxToken</c> layer, so a tree walk drops every operator (<c>status == Draft</c> comes back as
    /// <c>" status Draft"</c>, issue #1752) and could therefore never equal the emitted rule. The step's
    /// DISPLAYED condition text stays on <c>ToFullString()</c>, which is what
    /// <see cref="ScenarioInterpreter"/> renders — only the MATCHING moves here.
    /// </summary>
    private static string RuleTextOf(Expr condition) => Lowerer.SourceText(condition);

    /// <summary>
    /// Recognizes the emitted invariant exception BY TYPE NAME and reads its payload reflectively — the
    /// type lives in the generated assembly, so there is no compile-time reference to match on.
    /// </summary>
    private static bool TryReadViolation(Exception ex, out string typeName, out string rule)
    {
        typeName = string.Empty;
        rule = string.Empty;

        if (ex.GetType().Name != ViolationExceptionName)
        {
            return false;
        }

        typeName = ScenarioValueBinder.ReadProperty(ex, "TypeName") as string ?? string.Empty;
        rule = ScenarioValueBinder.ReadProperty(ex, "Rule") as string ?? string.Empty;
        return true;
    }

    /// <summary>Unwraps the reflection plumbing so the DOMAIN exception is what gets classified.</summary>
    private static Exception Unwrap(Exception ex) =>
        ex is TargetInvocationException { InnerException: { } inner } ? Unwrap(inner) : ex;

    private static string Describe(Exception ex) => $"{ex.GetType().Name}: {ex.Message}";

    private ScenarioResult Failed(Scenario s) => new(
        Ok: false,
        Target: _entity?.Name ?? s.Target,
        Operation: s.Operation,
        Steps: [],
        ResultingState: NoState,
        Invariants: [],
        Result: null,
        Notes: _notes);
}
