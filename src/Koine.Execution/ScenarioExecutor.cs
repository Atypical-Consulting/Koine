using System.Collections;
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

    private static readonly IReadOnlyDictionary<string, string> NoState =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private readonly SemanticModel _sema;
    private readonly ModelIndex _index;
    private readonly ScenarioValueBinder _binder;
    private readonly List<string> _notes = [];

    private EntityDecl _entity = null!;

    private ScenarioExecutor(SemanticModel sema)
    {
        _sema = sema;
        _index = sema.Index;
        _binder = new ScenarioValueBinder(_index);
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
            executor._notes.Add($"The scenario could not be executed: {Describe(Unwrap(ex))}");
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
            if (!TryConstructGivenState(entityType, s, out instance, out Exception? constructionFailure))
            {
                return constructionFailure is null ? Failed(s) : GivenStateViolation(s, constructionFailure);
            }
        }
        else if (s.Given.Count > 0)
        {
            _notes.Add($"'{s.Operation}' is a factory: it builds the instance itself, so the given state was not applied.");
        }

        IReadOnlyDictionary<string, string> before = instance is null ? NoState : Snapshot(instance, recordNotes: false);

        object? returned;
        try
        {
            returned = method.Invoke(instance, args);
        }
        catch (Exception ex)
        {
            return OperationFailure(s, Unwrap(ex), instance, body, before);
        }

        object? subject = isFactory ? returned : instance;
        if (subject is null)
        {
            _notes.Add($"'{s.Operation}' returned no instance to read the resulting state from.");
            return Failed(s);
        }

        IReadOnlyDictionary<string, string> after = Snapshot(subject, recordNotes: true);
        string? result = null;
        List<ScenarioStep> steps = SuccessSteps(body, before, after, subject, returned, ref result);

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
    /// Builds the aggregate's given state through its own (emitter-generated, often private) all-args
    /// constructor, so the constructor's <c>CheckInvariants()</c> and every value object it builds really
    /// run. Returns <c>false</c> with <paramref name="violation"/> set when the emitted code REJECTED the
    /// state (a domain outcome to report, not an error), or with it <c>null</c> when a value simply could
    /// not be bound.
    /// </summary>
    private bool TryConstructGivenState(Type entityType, Scenario s, out object? instance, out Exception? violation)
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
                if (!TryBindConstructorParameter(entityType, s, parameters[i], out args[i]))
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

    private bool TryBindConstructorParameter(Type entityType, Scenario s, ParameterInfo parameter, out object? bound)
    {
        bound = null;
        string name = parameter.Name ?? string.Empty;

        Member? member = _entity.Members.FirstOrDefault(m => string.Equals(m.Name, name, StringComparison.OrdinalIgnoreCase));
        if (member is null)
        {
            // The synthetic identity the emitter threads through as `id`.
            if (string.Equals(name, "id", StringComparison.OrdinalIgnoreCase))
            {
                return TryBindIdentity(s, parameter, out bound);
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

        if (s.Given.TryGetValue(member.Name, out ScenarioValue? given))
        {
            if (_binder.TryBind(given, parameter.ParameterType, out bound, out string? error))
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
                   + $"so '{_entity.Name}' could not be constructed.");
        return false;
    }

    private bool TryBindIdentity(Scenario s, ParameterInfo parameter, out object? bound)
    {
        bound = null;

        if (s.Given.TryGetValue("id", out ScenarioValue? given))
        {
            if (_binder.TryBind(given, parameter.ParameterType, out bound, out string? error))
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

    /// <summary>Reads every declared member off the live instance — including the DERIVED ones, whose
    /// values the emitted code actually computed (gap #1).</summary>
    private Dictionary<string, string> Snapshot(object instance, bool recordNotes)
    {
        var state = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Member member in _entity.Members)
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
        IReadOnlyDictionary<string, string> state = instance is null ? NoState : Snapshot(instance, recordNotes: false);

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

        var steps = new List<ScenarioStep>();
        bool mutated = false;

        // The emitter hoists EVERY `requires` ahead of the first write (CSharpEmitter.WriteCommand),
        // while the grammar (`commandStmt*`) lets one be written after a transition. Walking the body in
        // declaration order would then invent a transition for a write the guard prevented, and blame the
        // missing invariant sweep on it — so walk the guards first, exactly as the emitted code runs them.
        // (OrderBy is a STABLE sort, so each group keeps its declaration order.)
        foreach (CommandStmt stmt in body.OrderBy(stmt => stmt is RequiresClause ? 0 : 1))
        {
            switch (stmt)
            {
                case RequiresClause req when RuleOf(req) == rule:
                    steps.Add(new ScenarioStep.Precondition(req.Message, req.Condition.ToFullString(), CheckOutcome.Failed));
                    _notes.Add($"'{s.Operation}' was rejected by a precondition: {rule}");
                    return new ScenarioResult(
                        false, _entity.Name, s.Operation, steps, state, InvariantsAfterHalt(mutated), null, _notes);

                case RequiresClause req:
                    steps.Add(new ScenarioStep.Precondition(req.Message, req.Condition.ToFullString(), CheckOutcome.Passed));
                    break;

                case Transition t when rule.StartsWith(IllegalTransitionPrefix + t.Field + " to ", StringComparison.Ordinal):
                    // The emitted state machine refused the write. The transition never happened, so it is
                    // recorded as the failed GUARD it is rather than as a transition that did not occur.
                    steps.Add(new ScenarioStep.Precondition(
                        rule, $"{t.Field} -> {t.Value.ToFullString().Trim()}", CheckOutcome.Failed));
                    _notes.Add($"'{s.Operation}' was rejected by the '{t.Field}' state machine: {rule}");
                    return new ScenarioResult(
                        false, _entity.Name, s.Operation, steps, state, InvariantsAfterHalt(mutated), null, _notes);

                case Transition t:
                    steps.Add(new ScenarioStep.Transition(
                        t.Field,
                        before.GetValueOrDefault(t.Field, "∅"),
                        state.GetValueOrDefault(t.Field, "∅"),
                        IsInitialization: false));
                    mutated = true;
                    break;

                case Initialization init:
                    steps.Add(new ScenarioStep.Transition(
                        init.Field, From: null, state.GetValueOrDefault(init.Field, "∅"), IsInitialization: true));
                    mutated = true;
                    break;

                    // `emit` and `result` only run AFTER the emitted CheckInvariants() sweep, so nothing past
                    // this point happened on a failing run.
            }
        }

        // No guard matched: the post-command invariant sweep rejected the mutated state.
        return new ScenarioResult(
            false, _entity.Name, s.Operation, steps, state, InvariantsUpTo(rule, s.Operation), null, _notes);
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
