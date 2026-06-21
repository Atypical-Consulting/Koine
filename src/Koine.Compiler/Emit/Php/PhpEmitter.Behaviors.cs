using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The behavioral slice of <see cref="PhpEmitter"/>: an entity's <c>command</c>s (mutating
/// instance methods), <c>create</c> factories (static methods returning a new instance), and the
/// domain/integration <c>event</c>s those commands/factories emit (<c>final class</c> DTOs with
/// <c>public readonly</c> promoted properties — PHP 8.1-valid, since readonly classes are 8.2).
/// Mirrors the C#/Python/TS emitters' command/factory/event contract — <c>requires</c> guards throw
/// <c>\Koine\Runtime\DomainInvariantViolationException</c>, <c>f -&gt; v</c> transitions reassign
/// properties, <c>emit Ev(...)</c> records onto a per-aggregate event buffer, and a
/// <c>result</c>/return value (or the constructed instance, for a factory) is returned — rendered as
/// idiomatic PHP 8.1.
/// <para>
/// <b>Domain-event recording.</b> Koine events emit as <c>final class</c> DTOs (readonly props) with no
/// shared base class (each is a plain value-object). An entity that emits any event gains a private
/// <c>$domainEvents = []</c> property (not a constructor parameter), a <c>domainEvents(): array</c>
/// snapshot accessor, a <c>releaseDomainEvents(): array</c> drain, and a
/// <c>clearDomainEvents(): void</c> — the PHP analogue of the C# aggregate's
/// <c>DomainEvents</c>/<c>ClearDomainEvents</c>.
/// </para>
/// <para>
/// <b>Parameter-vs-this scoping.</b> Inside a command/factory body the construct's parameters are
/// locals (rendered as <c>$camelParam</c>); the entity's own members render as
/// <c>$this-&gt;camelProp</c> (Property mode). Parameters are pushed via
/// <see cref="PhpExpressionTranslator.PushLocal"/> while guards/transitions/emit payloads are
/// translated and popped before the post-mutation invariant re-check, so an entity invariant reads
/// persisted state, not a same-named parameter — exactly the C#/Python/TS ordering.
/// </para>
/// </summary>
public sealed partial class PhpEmitter
{
    // -----------------------------------------------------------------------
    // Domain-event recording buffer
    // -----------------------------------------------------------------------

    /// <summary>True when any command or factory of the entity records a domain event.</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>
    /// Emits the domain-event buffer members into the entity class body: a private
    /// <c>$domainEvents = []</c> property, a <c>domainEvents(): array</c> snapshot accessor,
    /// a <c>releaseDomainEvents(): array</c> drain that returns and clears, and a
    /// <c>clearDomainEvents(): void</c>.
    /// </summary>
    private static void WriteDomainEventsBuffer(StringBuilder sb)
    {
        sb.Append('\n');
        sb.Append(Indent).Append("/** @var array<object> */\n");
        sb.Append(Indent).Append("private array $domainEvents = [];\n");

        sb.Append('\n');
        sb.Append(Indent).Append("/** Returns a snapshot of recorded domain events (read-only). */\n");
        sb.Append(Indent).Append("public function domainEvents(): array\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("return $this->domainEvents;\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        sb.Append(Indent).Append("/** Returns all recorded domain events and clears the buffer. */\n");
        sb.Append(Indent).Append("public function releaseDomainEvents(): array\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("$events = $this->domainEvents;\n");
        sb.Append(Indent).Append(Indent).Append("$this->domainEvents = [];\n");
        sb.Append(Indent).Append(Indent).Append("return $events;\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        sb.Append(Indent).Append("/** Clears the domain event buffer without returning the events. */\n");
        sb.Append(Indent).Append("public function clearDomainEvents(): void\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("$this->domainEvents = [];\n");
        sb.Append(Indent).Append("}\n");
    }

    // -----------------------------------------------------------------------
    // Command — mutating instance method
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a Koine <c>command</c> as a mutating instance method on the entity:
    /// <c>public function &lt;camel&gt;(&lt;params&gt;): &lt;ret&gt;</c>. The body mirrors the
    /// C#/Python/TS order exactly:
    /// <list type="number">
    ///   <item>each <c>requires</c> precondition throws before any mutation;</item>
    ///   <item>each <c>f -&gt; v</c> transition reassigns <c>$this-&gt;&lt;field&gt;</c>;</item>
    ///   <item>after a transition the entity invariants are re-checked so an invalid post-state
    ///   throws before any event is recorded;</item>
    ///   <item>each <c>emit Ev(...)</c> records the constructed event DTO;</item>
    ///   <item>a <c>result</c> value is returned (no result → <c>void</c>).</item>
    /// </list>
    /// </summary>
    private void WriteCommand(
        StringBuilder sb,
        EntityDecl entity,
        CommandDecl cmd,
        PhpExpressionTranslator translator,
        PhpTypeMapper typeMapper,
        ModelIndex index)
    {
        var methodName = PhpNaming.EscapeIdentifier(PhpNaming.MethodName(cmd.Name));
        var className = PhpNaming.ClassName(entity.Name);
        var memberTypes = entity.Members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
        var returnType = cmd.ReturnType is { } rt ? typeMapper.Map(rt) : "void";

        sb.Append('\n');
        WriteDoc(sb, cmd.Doc, Indent);
        sb.Append(Indent).Append("public function ").Append(methodName).Append('(');

        var first = true;
        foreach (Param p in cmd.Parameters)
        {
            if (!first)
            {
                sb.Append(", ");
            }

            first = false;
            sb.Append(typeMapper.Map(p.Type)).Append(" $")
              .Append(PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(p.Name)));
        }

        sb.Append("): ").Append(returnType).Append('\n');
        sb.Append(Indent).Append("{\n");

        // Command parameters are locals inside the body.
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
            WriteRequiresGuard(sb, className, req, translator, Indent + Indent);
        }

        // 2. State transitions.
        foreach (Transition tr in transitions)
        {
            var expectedEnum = memberTypes.TryGetValue(tr.Field, out TypeRef? ft)
                && index.Classify(ft.Name) == TypeKind.Enum ? ft.Name : null;
            var value = translator.Translate(tr.Value, PhpExpressionTranslator.NameMode.Property, expectedEnum);
            var prop = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(tr.Field));
            sb.Append(Indent).Append(Indent).Append("$this->").Append(prop).Append(" = ").Append(value).Append(";\n");
        }

        // Translate emit payloads and result while parameters are still in scope. A command is an
        // instance method, so member references render as `$this->member` (Property mode).
        var emitStatements = emits.Select(e =>
            BuildEmitStatement(e, translator, index, "$this->", PhpExpressionTranslator.NameMode.Property)).ToList();
        string? resultExpr = result is not null
            ? translator.Translate(result.Value, PhpExpressionTranslator.NameMode.Property, cmd.ReturnType?.Name)
            : null;

        // Parameters leave scope BEFORE the re-check.
        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        // 3. Re-check entity invariants after the state change.
        if (transitions.Count > 0 && entity.Invariants.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("$this->checkInvariants();\n");
        }

        // 4. Record domain events.
        foreach (var stmt in emitStatements)
        {
            sb.Append(Indent).Append(Indent).Append(stmt).Append(";\n");
        }

        // 5. Return the result value.
        if (resultExpr is not null)
        {
            sb.Append(Indent).Append(Indent).Append("return ").Append(resultExpr).Append(";\n");
        }

        sb.Append(Indent).Append("}\n");
    }

    // -----------------------------------------------------------------------
    // Factory — static creation method
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a Koine <c>create</c> factory as a <c>public static function</c> returning the entity.
    /// The body mirrors the C#/Python/TS factory contract:
    /// <list type="number">
    ///   <item>mint the identity (<c>$id = &lt;IdName&gt;::generate()</c>);</item>
    ///   <item>check preconditions;</item>
    ///   <item>construct the instance;</item>
    ///   <item>record creation events;</item>
    ///   <item>return the instance.</item>
    /// </list>
    /// </summary>
    private void WriteFactory(
        StringBuilder sb,
        EntityDecl entity,
        string name,
        string idName,
        FactoryDecl factory,
        IReadOnlyList<Member> ctorMembers,
        PhpExpressionTranslator translator,
        PhpTypeMapper typeMapper,
        ModelIndex index)
    {
        var methodName = PhpNaming.EscapeIdentifier(PhpNaming.MethodName(factory.Name));

        sb.Append('\n');
        WriteDoc(sb, factory.Doc, Indent);
        sb.Append(Indent).Append("public static function ").Append(methodName).Append('(');

        var first = true;
        foreach (Param p in factory.Parameters)
        {
            if (!first)
            {
                sb.Append(", ");
            }

            first = false;
            sb.Append(typeMapper.Map(p.Type)).Append(" $")
              .Append(PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(p.Name)));
        }

        sb.Append("): self\n");
        sb.Append(Indent).Append("{\n");

        // Factory scope: synthetic `id` and factory parameters are locals.
        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var requires = factory.Body.OfType<RequiresClause>().ToList();
        var inits = factory.Body.OfType<Initialization>().ToList();
        var emits = factory.Body.OfType<EmitClause>().ToList();

        // 1. Mint the identity.
        sb.Append(Indent).Append(Indent).Append("$id = ").Append(idName).Append("::generate();\n");

        // 2. Preconditions.
        foreach (RequiresClause req in requires)
        {
            WriteRequiresGuard(sb, name, req, translator, Indent + Indent);
        }

        // 3. Construct the instance.
        var initByField = new Dictionary<string, Expr>(StringComparer.Ordinal);
        foreach (Initialization i in inits)
        {
            initByField.TryAdd(i.Field, i.Value);
        }

        var factoryParams = new HashSet<string>(factory.Parameters.Select(p => p.Name), StringComparer.Ordinal);
        var args = new List<string> { "$id" };
        foreach (Member m in ctorMembers)
        {
            var param = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            if (initByField.TryGetValue(m.Name, out Expr? value))
            {
                var expectedEnum = index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
                // A factory is a STATIC method — Property mode would render an entity-member
                // reference as `$this->member` ("Cannot use $this in a static method"). Use
                // Parameter mode so a bare member renders as `$member` (the factory's params and
                // synthetic `id` are pushed as locals and take precedence anyway).
                args.Add(translator.Translate(value, PhpExpressionTranslator.NameMode.Parameter, expectedEnum));
            }
            else if (factoryParams.Contains(m.Name))
            {
                args.Add("$" + param);
            }
            else if (m.Initializer is not null
                && !MemberAnalysis.IsDerived(m, ctorMembers.Select(f => f.Name).ToHashSet()))
            {
                args.Add(translator.Translate(m.Initializer, PhpExpressionTranslator.NameMode.Parameter, m.Type.Name));
            }
            else if (m.Type.IsOptional)
            {
                args.Add("null");
            }
            // else: required + unset — omit (constructor surfaces the gap).
        }

        sb.Append(Indent).Append(Indent).Append("$instance = new self(")
          .Append(string.Join(", ", args)).Append(");\n");

        // 4. Record creation events (payloads may reference `id` and parameters). A factory is a
        // static method, so use Parameter mode (no `$this->`); `id`/params are locals anyway.
        var emitStatements = emits.Select(e =>
            BuildEmitStatement(e, translator, index, "$instance->", PhpExpressionTranslator.NameMode.Parameter)).ToList();

        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }
        translator.PopLocal("id");

        foreach (var stmt in emitStatements)
        {
            sb.Append(Indent).Append(Indent).Append(stmt).Append(";\n");
        }

        sb.Append(Indent).Append(Indent).Append("return $instance;\n");
        sb.Append(Indent).Append("}\n");
    }

    // -----------------------------------------------------------------------
    // Invariant re-check helper method (checkInvariants)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a private <c>checkInvariants(): void</c> method used by commands to re-check
    /// entity invariants after a state transition. This mirrors the Python emitter's re-calling
    /// <c>__post_init__()</c> and the C# emitter's <c>CheckInvariants()</c>.
    /// Members are rendered as <c>$this-&gt;prop</c> (Property mode — this is an instance method,
    /// not a constructor).
    /// </summary>
    private void WriteCheckInvariants(
        StringBuilder sb,
        string className,
        IReadOnlyList<Invariant> invariants,
        PhpExpressionTranslator translator)
    {
        sb.Append('\n');
        sb.Append(Indent).Append("private function checkInvariants(): void\n");
        sb.Append(Indent).Append("{\n");
        foreach (Invariant inv in invariants)
        {
            WriteInvariantPropertyGuard(sb, className, inv, translator);
        }
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Like <see cref="WriteInvariantGuard"/> but uses <see cref="PhpExpressionTranslator.NameMode.Property"/>
    /// so member references render as <c>$this-&gt;prop</c> — used inside instance methods
    /// (commands, <c>checkInvariants</c>) where the properties are already assigned.
    /// </summary>
    private static void WriteInvariantPropertyGuard(
        StringBuilder sb,
        string typeName,
        Invariant inv,
        PhpExpressionTranslator translator)
    {
        const PhpExpressionTranslator.NameMode mode = PhpExpressionTranslator.NameMode.Property;

        string test;
        if (inv.Condition is GuardExpr guard)
        {
            var guardStr = translator.Translate(guard.Condition, mode);
            var bodyNeg = translator.TranslateNegated(guard.Body);
            test = guardStr + " && " + bodyNeg;
        }
        else
        {
            test = translator.TranslateNegated(inv.Condition);
        }

        sb.Append(Indent).Append(Indent).Append("if (").Append(test).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("throw new \\Koine\\Runtime\\DomainInvariantViolationException(")
          .Append('"').Append(typeName).Append('"')
          .Append(", ")
          .Append(RuleLiteral(inv.Message ?? "invariant failed"))
          .Append(");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
    }

    // -----------------------------------------------------------------------
    // requires guard + emit statement (shared by command/factory)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits one <c>requires</c> precondition as a throwing guard:
    /// <c>if (&lt;negated condition&gt;) { throw new ...; }</c>.
    /// </summary>
    private void WriteRequiresGuard(
        StringBuilder sb,
        string typeName,
        RequiresClause req,
        PhpExpressionTranslator translator,
        string indent)
    {
        string test;
        if (req.Condition is GuardExpr guard)
        {
            var guardStr = translator.Translate(guard.Condition, PhpExpressionTranslator.NameMode.Property);
            var bodyNeg = translator.TranslateNegated(guard.Body);
            test = guardStr + " && " + bodyNeg;
        }
        else
        {
            test = translator.TranslateNegated(req.Condition);
        }

        sb.Append(indent).Append("if (").Append(test).Append(") {\n");
        sb.Append(indent).Append(Indent)
          .Append("throw new \\Koine\\Runtime\\DomainInvariantViolationException(")
          .Append('"').Append(typeName).Append('"')
          .Append(", ")
          .Append(RuleLiteral(req.Message ?? "requirement not met"))
          .Append(");\n");
        sb.Append(indent).Append("}\n");
    }

    /// <summary>
    /// Builds the <c>&lt;prefix&gt;domainEvents[] = new Ev(&lt;field&gt;: &lt;value&gt;, …)</c>
    /// statement for an <c>emit</c> clause. Arguments are positional-ordered per the event's
    /// declared fields and translated in the surrounding scope.
    /// </summary>
    private string BuildEmitStatement(
        EmitClause emit,
        PhpExpressionTranslator translator,
        ModelIndex index,
        string targetPrefix,
        PhpExpressionTranslator.NameMode mode)
    {
        if (!index.TryGetDecl(emit.EventName, out TypeDecl decl) || decl is not EventDecl ev)
        {
            return $"/* unknown event '{emit.EventName}' */";
        }

        var memberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var ctorFields = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var argByField = emit.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);

        var args = ctorFields
            .Where(f => argByField.ContainsKey(f.Name))
            .Select(f =>
            {
                var expectedEnum = index.Classify(f.Type.Name) == TypeKind.Enum ? f.Type.Name : null;
                return translator.Translate(argByField[f.Name], mode, expectedEnum);
            });

        var eventName = PhpNaming.ClassName(ev.Name);
        return $"{targetPrefix}domainEvents[] = new {eventName}({string.Join(", ", args)})";
    }

    // -----------------------------------------------------------------------
    // Domain / integration events — final class DTOs (readonly promoted props)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Emits a domain <c>event</c> or <c>integration event</c> as a <c>final class</c>
    /// DTO with <c>public readonly</c> promoted properties (PHP 8.1-valid; readonly *classes* are
    /// 8.2): each declared member becomes a typed, camelCase constructor-promoted property. An event
    /// carries no behavior and no shared base class. Constant-default members use constructor
    /// defaults. Integration-event field types are already validated to be safe; the emitter just
    /// renders them.
    /// </summary>
    private EmittedFile EmitEvent(
        PhpEmitContext emit,
        string rawName,
        string? doc,
        IReadOnlyList<Member> members,
        string contextName,
        PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(rawName);
        var memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        var fields = members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var translator = new PhpExpressionTranslator(emit.Index, members, emit.EnumMemberToType);

        var sb = new StringBuilder();
        WriteDoc(sb, doc, "");

        // PHP 8.1 floor: readonly *properties* are 8.1, readonly *classes* are 8.2 — so the class
        // is a plain `final class` and immutability comes from the `public readonly` promoted props.
        sb.Append("final class ").Append(name).Append('\n');
        sb.Append("{\n");

        // Constructor-promoted readonly properties for all stored fields.
        sb.Append(Indent).Append("public function __construct(\n");

        for (int i = 0; i < fields.Count; i++)
        {
            Member m = fields[i];
            var propName = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            var typeName = typeMapper.Map(m.Type);
            sb.Append(Indent).Append(Indent).Append("public readonly ").Append(typeName).Append(" $").Append(propName);

            // Default value for constant-initializer fields.
            if (m.Initializer is not null
                && !MemberAnalysis.IsDerived(m, fields.Select(f => f.Name).ToHashSet()))
            {
                var defaultVal = translator.Translate(m.Initializer, PhpExpressionTranslator.NameMode.Parameter);
                sb.Append(" = ").Append(defaultVal);
            }
            else if (m.Type.IsOptional)
            {
                sb.Append(" = null");
            }

            var sep = i < fields.Count - 1 ? "," : "";
            sb.Append(sep).Append('\n');
        }

        sb.Append(Indent).Append(") {}\n");

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Events, rawName),
            Assemble(contextName, KindFolder.Events, sb.ToString(), name));
    }
}
