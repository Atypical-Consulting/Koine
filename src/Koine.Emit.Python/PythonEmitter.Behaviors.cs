using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The behavioral slice of <see cref="PythonEmitter"/>: an entity's <c>command</c>s (mutating
/// instance methods), <c>create</c> factories (<c>@classmethod</c>s), and the domain/integration
/// <c>event</c>s those commands/factories emit (frozen-dataclass DTOs). Mirrors the C#/TS emitters'
/// command/factory/event contract — <c>requires</c> guards raise
/// <see cref="PyRuntime"/>'s <c>DomainInvariantViolationError</c>, <c>f -&gt; v</c> transitions
/// reassign fields, <c>emit Ev(...)</c> records onto a per-aggregate event buffer, and a
/// <c>result</c>/return value (or the constructed instance, for a factory) is returned — rendered as
/// idiomatic, <c>mypy --strict</c>-clean Python.
/// <para>
/// <b>Domain-event recording.</b> Koine events emit as plain <c>@dataclass(frozen=True)</c> DTOs with
/// no shared base class (per the Python design: structural eq/hash come free, no behavior), so the
/// recording buffer is typed <c>list[object]</c> — every frozen-dataclass event is an <c>object</c>.
/// An entity that emits any event gains a non-constructor <c>_domain_events</c> field
/// (<c>field(default_factory=list, init=False)</c>), a read-only <c>domain_events</c> property
/// returning a <c>tuple[object, ...]</c> snapshot, and a <c>clear_domain_events()</c> drain — the
/// Python analogue of the C# aggregate's <c>DomainEvents</c>/<c>ClearDomainEvents</c> and the TS
/// <c>domainEvents</c> getter.
/// </para>
/// <para>
/// <b>Parameter-vs-self scoping.</b> Inside a command/factory body the construct's PARAMETERS are
/// locals (rendered bare, snake_case); the entity's own members render as <c>self.&lt;snake&gt;</c>
/// (Property mode). Parameters are pushed via <see cref="PythonExpressionTranslator.PushLocal"/> while
/// guards/transitions/emit payloads are translated and popped before the post-mutation invariant
/// re-check, so an entity invariant reads persisted state, not a same-named parameter — exactly the
/// C#/TS ordering.
/// </para>
/// </summary>
public sealed partial class PythonEmitter
{
    // ----------------------------------------------------------------------
    // Domain-event recording buffer (emitted into the entity body)
    // ----------------------------------------------------------------------

    /// <summary>True when any command or factory of the entity records a domain event (mirrors C#/TS).</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>
    /// Emits the domain-event buffer onto an entity that records events: a non-constructor
    /// <c>_domain_events: list[object]</c> field, a read-only <c>domain_events</c> property, and a
    /// <c>clear_domain_events()</c> drain. Events share no base class (each is a frozen dataclass), so
    /// the buffer is <c>list[object]</c>; the property returns an immutable <c>tuple[object, ...]</c>
    /// snapshot. The field is <c>init=False</c> with a fresh-list default factory, so it never appears
    /// in the dataclass constructor and never shares a mutable default.
    /// </summary>
    private static void WriteDomainEventsBuffer(StringBuilder sb)
    {
        sb.Append('\n');
        sb.Append(Indent).Append("_domain_events: list[object] = field(default_factory=list, init=False)\n");
        sb.Append('\n');
        sb.Append(Indent).Append("@property\n");
        sb.Append(Indent).Append("def domain_events(self) -> tuple[object, ...]:\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"The domain events recorded so far, in order (a read-only snapshot).\"\"\"\n");
        sb.Append(Indent).Append(Indent).Append("return tuple(self._domain_events)\n");
        sb.Append('\n');
        sb.Append(Indent).Append("def clear_domain_events(self) -> None:\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"Drains the recorded domain events after they have been dispatched.\"\"\"\n");
        sb.Append(Indent).Append(Indent).Append("self._domain_events.clear()\n");
    }

    // ----------------------------------------------------------------------
    // Command — mutating instance method
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a Koine <c>command</c> as a mutating instance method on the entity:
    /// <c>def &lt;snake&gt;(self, &lt;params&gt;) -&gt; &lt;ret&gt;:</c>. The body mirrors the
    /// C#/TS order exactly:
    /// <list type="number">
    ///   <item>each <c>requires</c> precondition raises <c>DomainInvariantViolationError</c> when it
    ///   does not hold (checked before any mutation);</item>
    ///   <item>each <c>f -&gt; v</c> transition reassigns <c>self.&lt;field&gt; = &lt;value&gt;</c>
    ///   (the entity is a mutable <c>@dataclass(eq=False)</c>, so a direct assignment is correct —
    ///   no <c>object.__setattr__</c>);</item>
    ///   <item>after a transition, the entity invariants are re-checked (<c>self.__post_init__()</c>,
    ///   the Python analogue of the C# <c>CheckInvariants()</c>) so an invalid post-state throws before
    ///   any event is recorded;</item>
    ///   <item>each <c>emit Ev(...)</c> records the constructed event DTO onto the buffer;</item>
    ///   <item>a <c>result</c> value is returned (a command with neither a result nor a declared
    ///   return type returns <c>None</c>).</item>
    /// </list>
    /// Command parameters are locals while the guards/transitions/emit payloads are translated (so a
    /// payload referencing a parameter renders bare); they are popped before the re-check so an
    /// invariant reads persisted <c>self.*</c> state.
    /// </summary>
    private void WriteCommand(StringBuilder sb, EntityDecl entity, CommandDecl cmd, PythonExpressionTranslator translator, PythonTypeMapper typeMapper, ModelIndex index)
    {
        var name = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(cmd.Name));
        var entityName = PythonNaming.ToPascalCase(entity.Name);
        var memberTypes = entity.Members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);

        // A declared return type renders `-> <T>`; a `result` value with no declared type infers from
        // its own expression's annotation; an effect-only command returns `None`.
        var returnType = cmd.ReturnType is { } rt ? typeMapper.Map(rt) : "None";

        sb.Append('\n');
        sb.Append(Indent).Append("def ").Append(name).Append("(self");
        foreach (Param p in cmd.Parameters)
        {
            sb.Append(", ").Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name)))
              .Append(": ").Append(typeMapper.Map(p.Type));
        }
        sb.Append(") -> ").Append(returnType).Append(":\n");

        WriteDoc(sb, cmd.Doc, Indent + Indent);

        // Command parameters are locals inside the body (members render as `self.<snake>`).
        foreach (Param p in cmd.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var requires = cmd.Body.OfType<RequiresClause>().ToList();
        var transitions = cmd.Body.OfType<Transition>().ToList();
        var emits = cmd.Body.OfType<EmitClause>().ToList();
        ResultClause? result = cmd.Body.OfType<ResultClause>().FirstOrDefault();

        // 1. Preconditions — checked before any mutation.
        foreach (RequiresClause req in requires)
        {
            WriteRequiresGuard(sb, entityName, req, translator, Indent + Indent);
        }

        // Positive renderings of the preconditions, used to suppress a state-machine reachability
        // guard that would merely restate one of them (the C# `requiresConds` suppression). The
        // top-level translator wraps a comparison in parens; strip a balanced outer pair so the
        // comparison is against the same bare form the source conditions are built in — robust to
        // whether or how the translator parenthesizes.
        var requiresConds = new HashSet<string>(
            requires.Select(r => StripOuterParens(
                translator.Translate(r.Condition, PythonExpressionTranslator.NameMode.Property))),
            StringComparer.Ordinal);

        // 2. State transitions: direct field reassignment (the entity is NOT frozen). When a state
        //    machine governs the field, a reachability guard precedes the assignment (mirroring the
        //    C# `WriteStateMachineGuard`) — unless it would just restate a precondition.
        foreach (Transition tr in transitions)
        {
            var expectedEnum = memberTypes.TryGetValue(tr.Field, out TypeRef? ft) && index.Classify(ft.Name) == TypeKind.Enum
                ? ft.Name : null;

            // A single-source guard that merely restates a precondition is suppressed; both sides are
            // compared in the same bare (paren-stripped) form (see `requiresConds` above).
            if (expectedEnum is not null
                && BuildStateMachineConditions(entity, tr, expectedEnum, translator, index, cmd.Parameters) is { } conds
                && !(conds.Count == 1 && requiresConds.Contains(conds[0].Positive)))
            {
                WriteStateMachineGuard(sb, entityName, conds, tr.Field, ((IdentifierExpr)tr.Value).Name);
            }

            var value = translator.Translate(tr.Value, PythonExpressionTranslator.NameMode.Property, expectedEnum);
            sb.Append(Indent).Append(Indent).Append("self.")
              .Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(tr.Field)))
              .Append(" = ").Append(value).Append('\n');
        }

        // Translate the emit payloads and the result while parameters are still in scope (their
        // payloads may reference parameters); they are written AFTER the re-check.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index, "self.")).ToList();
        string? resultExpr = result is not null
            ? translator.Translate(result.Value, PythonExpressionTranslator.NameMode.Property, cmd.ReturnType?.Name)
            : null;

        // Parameters leave scope BEFORE the re-check: entity invariants reference only persisted
        // state, which must render as `self.*`, not a parameter that shares a field's name.
        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        // 3. Re-check entity invariants after the state change (re-run __post_init__, the shared guard
        //    method) so an invalid post-state throws before any event is recorded.
        if (transitions.Count > 0 && entity.Invariants.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("self.__post_init__()\n");
        }

        // 4. Record domain events (only reached once preconditions + re-check pass).
        foreach (var stmt in emitStatements)
        {
            sb.Append(Indent).Append(Indent).Append(stmt).Append('\n');
        }

        // 5. Return the result value (the terminal statement). An effect-only command has no return.
        if (resultExpr is not null)
        {
            sb.Append(Indent).Append(Indent).Append("return ").Append(resultExpr).Append('\n');
        }
    }

    // ----------------------------------------------------------------------
    // State-machine reachability guards (R7), ported from the C# emitter
    // ----------------------------------------------------------------------

    /// <summary>One legal source of a transition: its positive reachability check and the negation.</summary>
    private readonly record struct PyStateSource(string Positive, string Negated);

    /// <summary>
    /// Removes one balanced outer parenthesis pair if the whole string is wrapped in it
    /// (<c>(a == b)</c> → <c>a == b</c>), leaving a string with unbalanced or no outer parens
    /// untouched (<c>(a) and (b)</c> stays as-is). Used to compare a translator-rendered, top-level-
    /// parenthesized precondition against a bare-built source condition.
    /// </summary>
    private static string StripOuterParens(string s)
    {
        if (s.Length < 2 || s[0] != '(' || s[^1] != ')')
        {
            return s;
        }

        var depth = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '(')
            {
                depth++;
            }
            else if (s[i] == ')')
            {
                depth--;
                // The opening paren closes before the end → the outer pair isn't a single wrapper.
                if (depth == 0 && i != s.Length - 1)
                {
                    return s;
                }
            }
        }

        return s[1..^1];
    }

    /// <summary>
    /// Builds the reachability conditions for a state-machine-governed transition with a literal
    /// target: the set of legal source states (each optionally guarded) the current state must be one
    /// of. Returns <c>null</c> when the field has no state machine or the target is dynamic
    /// (non-literal) — the Python analogue of the C# <c>BuildStateMachineConditions</c>. Command
    /// parameters are popped while a per-rule guard is translated so a same-named parameter cannot
    /// shadow the persisted member it must read.
    /// </summary>
    private static List<PyStateSource>? BuildStateMachineConditions(
        EntityDecl entity, Transition tr, string enumType,
        PythonExpressionTranslator translator, ModelIndex index, IReadOnlyList<Param> commandParams)
    {
        StatesDecl? states = entity.States.FirstOrDefault(s => s.Field == tr.Field);
        if (states is null || tr.Value is not IdentifierExpr stateRef
            || !index.EnumsDeclaring(stateRef.Name).Contains(enumType))
        {
            return null; // no state machine, or a dynamic (non-literal) target
        }

        var sources = states.Rules.Where(r => r.To.Contains(stateRef.Name)).ToList();
        if (sources.Count == 0)
        {
            return null; // unreachable target — already a semantic error (KOI0703)
        }

        var prop = "self." + PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(tr.Field));
        var enumName = PythonNaming.ToPascalCase(enumType);

        foreach (Param p in commandParams)
        {
            translator.PopLocal(p.Name);
        }

        var conditions = sources.Select(r =>
        {
            var fromMember = PythonNaming.ToUpperSnake(r.From);
            var srcEq = $"{prop} == {enumName}.{fromMember}";
            if (r.Guard is null)
            {
                // A bare source: its negation is the simple `!=` (no wrapping needed).
                return new PyStateSource(srcEq, $"{prop} != {enumName}.{fromMember}");
            }

            // A guarded source: keep the guard parenthesized so an `or` guard binds below the `and`
            // joining the source check.
            var guard = translator.Translate(r.Guard, PythonExpressionTranslator.NameMode.Property);
            var positive = $"{srcEq} and ({guard})";
            return new PyStateSource(positive, $"not ({positive})");
        }).ToList();

        foreach (Param p in commandParams)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        return conditions;
    }

    /// <summary>
    /// Emits a reachability guard from prebuilt source conditions: the transition is illegal unless
    /// the current state is one of the legal sources. The test is the De Morgan negation
    /// (<c>not a and not b</c>) so it reads as a plain "is none of these", raising
    /// <c>DomainInvariantViolationError</c> — the Python analogue of the C# <c>WriteStateMachineGuard</c>.
    /// </summary>
    private static void WriteStateMachineGuard(
        StringBuilder sb, string entityName, IReadOnlyList<PyStateSource> conditions, string field, string targetState)
    {
        var test = string.Join(" and ", conditions.Select(c => c.Negated));
        sb.Append(Indent).Append(Indent).Append("if ").Append(test).Append(":\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("raise DomainInvariantViolationError(\"")
          .Append(entityName).Append("\", \"illegal transition of ").Append(field).Append(" to ").Append(targetState).Append("\")\n");
    }

    // ----------------------------------------------------------------------
    // Factory — @classmethod creation
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a Koine <c>create</c> factory as a <c>@classmethod</c>:
    /// <c>def &lt;snake&gt;(cls, &lt;params&gt;) -&gt; &lt;Entity&gt;:</c>. The body mirrors the
    /// C#/TS factory contract:
    /// <list type="number">
    ///   <item>obtain the identity first, so it is in scope for the preconditions and payloads — mint
    ///   it (<c>id = &lt;IdName&gt;.new()</c>) by default, or bind it to an explicit identity-typed
    ///   parameter (#324) instead of generating;</item>
    ///   <item>each <c>requires</c> precondition raises before any state is constructed;</item>
    ///   <item>construct the instance (<c>instance = cls(...)</c>), each constructor field drawn — in
    ///   priority order — from an explicit <c>field &lt;- value</c> initialization, a same-named
    ///   factory parameter (auto-bind), the member's own default, or <c>None</c> for an optional field
    ///   (a required field with no source was already flagged upstream and is omitted, so the
    ///   constructor raises a clear missing-argument error);</item>
    ///   <item>record any creation events onto the freshly-built instance;</item>
    ///   <item>return the instance.</item>
    /// </list>
    /// The synthetic <c>id</c> and the factory's parameters are locals; entity members are NOT in
    /// scope (the aggregate does not exist yet), so a guard/payload references only parameters and
    /// <c>id</c>.
    /// </summary>
    private void WriteFactory(StringBuilder sb, EntityDecl entity, string name, string idName, FactoryDecl factory,
        IReadOnlyList<Member> ctorMembers, PythonExpressionTranslator translator, PythonTypeMapper typeMapper, ModelIndex index)
    {
        var methodName = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(factory.Name));

        sb.Append('\n');
        sb.Append(Indent).Append("@classmethod\n");
        sb.Append(Indent).Append("def ").Append(methodName).Append("(cls");
        foreach (Param p in factory.Parameters)
        {
            sb.Append(", ").Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name)))
              .Append(": ").Append(typeMapper.Map(p.Type));
        }
        sb.Append(") -> ").Append(name).Append(":\n");

        WriteDoc(sb, factory.Doc, Indent + Indent);

        // Factory scope: the synthetic `id` and the factory's parameters are locals (entity members
        // are not in scope — the aggregate does not exist yet).
        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var requires = factory.Body.OfType<RequiresClause>().ToList();
        var inits = factory.Body.OfType<Initialization>().ToList();
        var emits = factory.Body.OfType<EmitClause>().ToList();

        // 1. Identity (no side effects), in scope for preconditions + payloads. By default mint it
        //    (`<IdName>.new()`); when the factory supplies it as an explicit identity-typed parameter
        //    (#324), bind `id` to that parameter instead — omit when the parameter is already named
        //    `id`, else alias it (`id = book_id`).
        FactoryIdBinding idBinding = FactoryIdBinding.ResolveFactoryId(
            entity, factory, name => PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(name)));
        switch (idBinding.Source)
        {
            case FactoryIdSource.Generate:
                sb.Append(Indent).Append(Indent).Append("id = ").Append(idName).Append(".new()\n");
                break;
            case FactoryIdSource.Alias:
                sb.Append(Indent).Append(Indent).Append("id = ").Append(idBinding.AliasFrom).Append('\n');
                break;
            case FactoryIdSource.ParamProvidesIdDirectly:
                // The `id` parameter already provides the local — emit nothing.
                break;
        }

        // 2. Preconditions — checked before any state is constructed.
        foreach (RequiresClause req in requires)
        {
            WriteRequiresGuard(sb, name, req, translator, Indent + Indent);
        }

        // 3. Construct. Each ctor member draws its value, in priority order, from: an explicit
        //    `field <- value` init; a same-named factory parameter (auto-bind); the member's own
        //    default; `None` for an optional field; else omit (required+unset, already flagged
        //    upstream — the constructor then raises a clear missing-argument error).
        var initByField = new Dictionary<string, Expr>(StringComparer.Ordinal);
        foreach (Initialization i in inits)
        {
            initByField.TryAdd(i.Field, i.Value);
        }

        var factoryParams = new HashSet<string>(factory.Parameters.Select(p => p.Name), StringComparer.Ordinal);
        var args = new List<string> { "id=id" };
        foreach (Member m in ctorMembers)
        {
            var field = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            if (initByField.TryGetValue(m.Name, out Expr? value))
            {
                var expectedEnum = index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
                args.Add($"{field}={translator.Translate(value, PythonExpressionTranslator.NameMode.Property, expectedEnum)}");
            }
            else if (factoryParams.Contains(m.Name))
            {
                args.Add($"{field}={field}");
            }
            else if (m.Initializer is not null)
            {
                args.Add($"{field}={translator.Translate(m.Initializer, NameModeForDefault(), m.Type.Name)}");
            }
            else if (m.Type.IsOptional)
            {
                args.Add($"{field}=None");
            }
            // else: required + unset — omit (validated upstream; constructor surfaces the gap).
        }
        sb.Append(Indent).Append(Indent).Append("instance = cls(").Append(string.Join(", ", args)).Append(")\n");

        // 4. Record creation events (payloads may reference `id` and parameters) onto the instance.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index, "instance.")).ToList();

        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }
        translator.PopLocal("id");

        foreach (var stmt in emitStatements)
        {
            sb.Append(Indent).Append(Indent).Append(stmt).Append('\n');
        }

        sb.Append(Indent).Append(Indent).Append("return instance\n");
    }

    // ----------------------------------------------------------------------
    // requires guard + emit statement (shared by command/factory)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits one <c>requires</c> precondition as a throwing guard:
    /// <c>if not (&lt;condition&gt;): raise DomainInvariantViolationError("&lt;Entity&gt;", "&lt;message&gt;")</c>.
    /// A <c>when</c>-guarded condition (<see cref="GuardExpr"/>) only asserts the body where the guard
    /// holds. Mirrors the value-object invariant guard's negation handling.
    /// </summary>
    private void WriteRequiresGuard(StringBuilder sb, string typeName, RequiresClause req, PythonExpressionTranslator translator, string indent)
    {
        const PythonExpressionTranslator.NameMode mode = PythonExpressionTranslator.NameMode.Property;

        string test;
        if (req.Condition is GuardExpr guard)
        {
            test = translator.Translate(guard.Condition, mode) + " and " + Negate(translator.Translate(guard.Body, mode));
        }
        else
        {
            test = Negate(translator.Translate(req.Condition, mode));
        }

        sb.Append(indent).Append("if ").Append(test).Append(":\n");
        sb.Append(indent).Append(Indent).Append("raise DomainInvariantViolationError(\"").Append(typeName).Append("\", ")
          .Append(RuleLiteral(req.Message ?? "requirement not met")).Append(")\n");
    }

    /// <summary>
    /// Builds the <c>&lt;prefix&gt;_domain_events.append(Ev(&lt;field&gt;=&lt;value&gt;, …))</c>
    /// statement for an <c>emit</c> clause. Arguments are keyword-named per the event's emitted field
    /// names (so positional ordering is irrelevant) and translated in the surrounding scope (params as
    /// locals, members as <c>self.*</c>). The Python analogue of the C#/TS <c>BuildEmitStatement</c>.
    /// </summary>
    private string BuildEmitStatement(EmitClause emit, PythonExpressionTranslator translator, ModelIndex index, string targetPrefix)
    {
        if (!index.TryGetDecl(emit.EventName, out TypeDecl decl) || decl is not EventDecl ev)
        {
            return $"# unknown event '{emit.EventName}'";
        }

        var eventMemberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var ctorFields = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, eventMemberNames)).ToList();
        var argByField = emit.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);

        var args = ctorFields
            .Where(f => argByField.ContainsKey(f.Name))
            .Select(f =>
            {
                var field = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(f.Name));
                var expectedEnum = index.Classify(f.Type.Name) == TypeKind.Enum ? f.Type.Name : null;
                return $"{field}={translator.Translate(argByField[f.Name], PythonExpressionTranslator.NameMode.Property, expectedEnum)}";
            });

        var eventName = PythonNaming.ToPascalCase(ev.Name);
        return $"{targetPrefix}_domain_events.append({eventName}({string.Join(", ", args)}))";
    }

    // ----------------------------------------------------------------------
    // Domain / integration events — frozen-dataclass DTOs
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a domain <c>event</c> or <c>integration event</c> as a pure <c>@dataclass(frozen=True)</c>
    /// DTO: each declared member becomes a typed, snake_case field; frozen gives structural equality
    /// and hashing for free. An event carries no behavior and no shared base class. Constant-default
    /// members carry a dataclass default and are ordered after non-defaulted fields (the dataclass
    /// rule), exactly as a value object's fields are. Integration-event field types are already
    /// validated to be primitives/enums/ids/other integration events; the emitter just renders them.
    /// </summary>
    private EmittedFile EmitEvent(PyEmitContext emit, string rawName, string? doc, IReadOnlyList<Member> members, string ns, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(rawName);
        var memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);

        var fields = members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var ordered = fields.OrderBy(m => HasDefault(m) ? 1 : 0).ToList();

        var translator = new PythonExpressionTranslator(emit.Index, members, emit.EnumMemberToType, typeMapper, ContextOf(ns), regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(name).Append(":\n");

        if (!string.IsNullOrEmpty(doc))
        {
            WriteDoc(sb, doc, Indent);
        }

        if (ordered.Count == 0 && string.IsNullOrEmpty(doc) && derived.Count == 0)
        {
            sb.Append(Indent).Append("pass\n");
        }

        foreach (Member m in ordered)
        {
            WriteDoc(sb, m.Doc, Indent);
            var field = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            sb.Append(Indent).Append(field).Append(": ").Append(typeMapper.Map(m.Type));
            if (DefaultExpr(m, translator, emit.Index) is { } def)
            {
                sb.Append(" = ").Append(def);
            }
            sb.Append('\n');
        }

        // Computed (derived) event members as read-only @property getters (rare, but supported for
        // parity with the value-object emitter).
        foreach (Member m in derived)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("@property\n");
            sb.Append(Indent).Append("def ").Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name)))
              .Append("(self) -> ").Append(typeMapper.Map(m.Type)).Append(":\n");
            WriteDoc(sb, m.Doc, Indent + Indent);
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append('\n');
        }

        return new EmittedFile(
            PathFor(ns, KindFolder.Events, rawName),
            Assemble(emit, ns, sb.ToString(), name));
    }
}
