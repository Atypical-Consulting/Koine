using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The entity slice of <see cref="KotlinEmitter"/>. A Koine <c>entity</c> emits as a Kotlin <c>class</c> with
/// a <c>val</c> identity, read-only-from-outside state (immutable members are <c>val</c>s; a member a behavior
/// mutates is a <c>var … private set</c>), an <c>init { checkInvariants() }</c> block enforcing the
/// invariants (throwing <c>koine.runtime.DomainException</c>), get-only computed properties for derived
/// members, identity-based <c>equals</c>/<c>hashCode</c> keyed on the id, one mutating method per behavior —
/// each re-checking its preconditions, applying its transitions, re-validating the invariants, and recording
/// any domain events — and a <c>companion object</c> of factory functions. Recorded events collect into a
/// private <c>MutableList&lt;DomainEvent&gt;</c> exposed read-only as <c>domainEvents()</c>.
/// <para>
/// The identity type is emitted separately by the value-object slice (<see cref="EmitId"/>). Behaviors and
/// factories read stored members through <see cref="KotlinExpressionTranslator.NameMode.Property"/>
/// (<c>this.name</c>, no accessor parens — Kotlin properties), with their parameters registered as locals.
/// The recorded-events list is typed on the per-context <c>DomainEvent</c> sealed interface the messages
/// slice emits.
/// </para>
/// </summary>
public sealed partial class KotlinEmitter
{
    /// <summary>Emits an entity as its class file plus its generated identity <c>value class</c> file (one top-level type per file).</summary>
    private void EmitEntity(KotlinEmitContext emit, List<EmittedFile> files, string context, EntityDecl entity)
    {
        files.Add(EmitId(emit, context, entity));
        files.Add(EmitEntityClass(emit, context, entity));
    }

    /// <summary>Builds the entity class file: identity + members, invariant guard, accessors, behaviors/factories, and identity equality.</summary>
    private EmittedFile EmitEntityClass(KotlinEmitContext emit, string context, EntityDecl entity)
    {
        var name = KotlinNaming.ToTypeName(entity.Name);
        var idType = KotlinNaming.ToTypeName(entity.IdentityName);
        var typeMapper = new KotlinTypeMapper(emit.Index, context, PackageFor);

        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var stored = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var required = stored.Where(m => m.Initializer is null).ToList();
        var defaulted = stored.Where(m => m.Initializer is not null).ToList();
        var mutated = MutatedFields(entity);
        var hasEmits = EmitsEvents(entity);
        var eventsAccessor = SyntheticEventsName(entity);
        var eventsField = "_" + eventsAccessor;

        // A synthetic `id` member (of the identity type) so an `id` reference in a behavior body or an `emit`
        // argument resolves to the entity's identity property (`this.id`), mirroring the other backends.
        var bodyMembers = entity.Members
            .Append(new Member("id", new TypeRef(entity.IdentityName), null))
            .ToList();
        var translator = new KotlinExpressionTranslator(
            emit.Index, bodyMembers, typeMapper, context, memberReceiver: "this", emit.EnumMemberToType);

        var sb = new StringBuilder();
        WriteKdoc(sb, entity.Doc, string.Empty);

        // Primary constructor: identity first, then the required members (defaulted members take their
        // initializer inside the body; they are not constructor parameters).
        sb.Append("class ").Append(name).Append("(\n");
        sb.Append(Indent).Append("id: ").Append(idType).Append(",\n");
        foreach (Member m in required)
        {
            sb.Append(Indent).Append(KotlinNaming.ToMemberName(m.Name)).Append(": ").Append(typeMapper.Map(m.Type)).Append(",\n");
        }

        sb.Append(") {\n");

        // Properties: identity, then each stored member (a `val`, or a `var … private set` when a behavior
        // mutates it), then the recorded-events collector.
        sb.Append(Indent).Append("val id: ").Append(idType).Append(" = id\n");
        foreach (Member m in required)
        {
            WriteStoredProperty(sb, m, typeMapper, KotlinNaming.ToMemberName(m.Name), mutated.Contains(m.Name));
        }

        foreach (Member m in defaulted)
        {
            var value = translator.Translate(m.Initializer!, KotlinExpressionTranslator.NameMode.Parameter, EnumExpected(m, emit.Index));
            WriteStoredProperty(sb, m, typeMapper, value, mutated.Contains(m.Name));
        }

        if (hasEmits)
        {
            sb.Append(Indent).Append("private val ").Append(eventsField)
              .Append(": MutableList<DomainEvent> = mutableListOf()\n");
        }

        // Validating init block + the shared invariant check.
        if (entity.Invariants.Count > 0)
        {
            sb.Append('\n').Append(Indent).Append("init {\n");
            sb.Append(Indent).Append(Indent).Append("checkInvariants()\n");
            sb.Append(Indent).Append("}\n");

            sb.Append('\n');
            WriteCheckInvariants(sb, entity, translator);
        }

        // Derived (computed) members.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteEntityDerived(sb, emit, m, typeMapper, translator);
        }

        // The recorded-events accessor (a read-only snapshot).
        if (hasEmits)
        {
            sb.Append('\n');
            WriteKdoc(sb, "The domain events recorded so far, as a read-only snapshot.", Indent);
            sb.Append(Indent).Append("fun ").Append(eventsAccessor).Append("(): List<DomainEvent> = this.")
              .Append(eventsField).Append(".toList()\n");
        }

        // Mutating behaviors.
        foreach (CommandDecl cmd in entity.Commands)
        {
            sb.Append('\n');
            WriteBehavior(sb, emit, entity, cmd, translator, typeMapper, eventsField);
        }

        // Identity-based equality (an entity is its identity).
        sb.Append('\n');
        WriteIdentityEquality(sb, name);

        // Factories: creation functions on the companion object.
        if (entity.Factories.Count > 0)
        {
            sb.Append('\n').Append(Indent).Append("companion object {\n");
            foreach (FactoryDecl factory in entity.Factories)
            {
                WriteFactory(sb, emit, name, idType, entity, factory, translator, typeMapper, required, eventsField);
            }

            sb.Append(Indent).Append("}\n");
        }

        sb.Append("}\n");
        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>
    /// Writes one stored member as a property: a <c>var … private set</c> when a behavior mutates it (read-only
    /// from outside, mutable within), else a <c>val</c>. A collection is defensively copied so the entity never
    /// holds an aliased mutable collection. <paramref name="init"/> is the initializer expression (a
    /// constructor parameter name for a required member, or a translated default for a defaulted one).
    /// </summary>
    private static void WriteStoredProperty(StringBuilder sb, Member m, KotlinTypeMapper typeMapper, string init, bool isMutated)
    {
        WriteKdoc(sb, m.Doc, Indent);
        var field = KotlinNaming.ToMemberName(m.Name);
        var value = DefensiveCopy(m, init);
        if (isMutated)
        {
            sb.Append(Indent).Append("var ").Append(field).Append(": ").Append(typeMapper.Map(m.Type)).Append(" = ").Append(value).Append('\n');
            sb.Append(Indent).Append(Indent).Append("private set\n");
        }
        else
        {
            sb.Append(Indent).Append("val ").Append(field).Append(": ").Append(typeMapper.Map(m.Type)).Append(" = ").Append(value).Append('\n');
        }
    }

    /// <summary>Wraps a collection initializer in a defensive copy (<c>.toList()</c>/<c>.toSet()</c>/<c>.toMap()</c>, null-safe for an optional collection), or returns it unchanged for a scalar.</summary>
    private static string DefensiveCopy(Member m, string init)
    {
        if (!KotlinTypeMapper.IsCollection(m.Type))
        {
            return init;
        }

        var copy = KotlinTypeMapper.IsMap(m.Type) ? "toMap" : KotlinTypeMapper.IsSet(m.Type) ? "toSet" : "toList";
        return m.Type.IsOptional ? $"{init}?.{copy}()" : $"{init}.{copy}()";
    }

    /// <summary>Writes the shared <c>checkInvariants()</c> function: one fail-fast guard per invariant over the current state (Property mode).</summary>
    private static void WriteCheckInvariants(StringBuilder sb, EntityDecl entity, KotlinExpressionTranslator translator)
    {
        sb.Append(Indent).Append("private fun checkInvariants() {\n");
        foreach (Invariant inv in entity.Invariants)
        {
            WriteInvariantGuard(sb, inv, translator, Indent + Indent, KotlinExpressionTranslator.NameMode.Property);
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>Emits a derived (computed) member as a get-only property reading through the stored properties.</summary>
    private static void WriteEntityDerived(
        StringBuilder sb, KotlinEmitContext emit, Member m, KotlinTypeMapper typeMapper, KotlinExpressionTranslator translator)
    {
        WriteKdoc(sb, m.Doc, Indent);
        var body = translator.Translate(m.Initializer!, KotlinExpressionTranslator.NameMode.Property, EnumExpected(m, emit.Index));
        sb.Append(Indent).Append("val ").Append(KotlinNaming.ToMemberName(m.Name)).Append(": ")
          .Append(typeMapper.Map(m.Type)).Append(" get() = ").Append(body).Append('\n');
    }

    /// <summary>
    /// Emits a mutating behavior as a function: preconditions (<c>requires</c>) throwing <c>DomainException</c>
    /// when a guard fails, then state transitions, then an invariant re-check over the post-transition state,
    /// then any recorded domain events, then the optional result. Behavior parameters are locals while the body
    /// is translated (members stay <c>this.&lt;field&gt;</c>).
    /// </summary>
    private void WriteBehavior(
        StringBuilder sb, KotlinEmitContext emit, EntityDecl entity, CommandDecl cmd,
        KotlinExpressionTranslator translator, KotlinTypeMapper typeMapper, string eventsField)
    {
        var method = KotlinNaming.ToMemberName(cmd.Name);
        var paramList = string.Join(", ", cmd.Parameters.Select(p => KotlinNaming.ToMemberName(p.Name) + ": " + typeMapper.Map(p.Type)));
        var returnType = cmd.ReturnType is { } rt ? ": " + typeMapper.Map(rt) : string.Empty;

        foreach (Param p in cmd.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        WriteKdoc(sb, cmd.Doc, Indent);
        sb.Append(Indent).Append("fun ").Append(method).Append('(').Append(paramList).Append(')').Append(returnType).Append(" {\n");

        foreach (RequiresClause req in cmd.Body.OfType<RequiresClause>())
        {
            WritePrecondition(sb, req, translator);
        }

        foreach (Transition t in cmd.Body.OfType<Transition>())
        {
            WriteTransition(sb, emit, entity, t, translator, Indent + Indent);
        }

        if (entity.Invariants.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("checkInvariants()\n");
        }

        foreach (EmitClause em in cmd.Body.OfType<EmitClause>())
        {
            WriteEmitStatement(sb, emit, em, translator, eventsField, "this.", Indent + Indent);
        }

        if (cmd.Body.OfType<ResultClause>().FirstOrDefault() is { } result)
        {
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(result.Value, KotlinExpressionTranslator.NameMode.Property)).Append('\n');
        }

        sb.Append(Indent).Append("}\n");

        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }
    }

    /// <summary>Emits a precondition guard: <c>if (!(cond)) throw DomainException(msg)</c> (Property mode).</summary>
    private static void WritePrecondition(StringBuilder sb, RequiresClause req, KotlinExpressionTranslator translator)
    {
        var cond = translator.Translate(req.Condition, KotlinExpressionTranslator.NameMode.Property);
        sb.Append(Indent).Append(Indent).Append("if (!(").Append(cond).Append(")) throw koine.runtime.DomainException(")
          .Append(KotlinStringLiteral(req.Message ?? "precondition failed")).Append(")\n");
    }

    /// <summary>
    /// Emits a state transition <c>Field -&gt; Value</c> as an assignment <c>this.&lt;field&gt; = &lt;value&gt;</c>.
    /// Kotlin nullability means a non-optional value assigns straight into a <c>T?</c> field (no wrapping); a bare
    /// enum member on the RHS is qualified with the field's enum type.
    /// </summary>
    private void WriteTransition(StringBuilder sb, KotlinEmitContext emit, EntityDecl entity, Transition t, KotlinExpressionTranslator translator, string indent)
    {
        Member? field = entity.Members.FirstOrDefault(m => m.Name == t.Field);
        var expectedEnum = field is not null && emit.Index.Classify(field.Type.Name) == TypeKind.Enum ? field.Type.Name : null;
        var value = translator.Translate(t.Value, KotlinExpressionTranslator.NameMode.Property, expectedEnum);
        sb.Append(indent).Append("this.").Append(KotlinNaming.ToMemberName(t.Field)).Append(" = ").Append(value).Append('\n');
    }

    /// <summary>Records a domain event: <c>&lt;receiver&gt;&lt;events&gt;.add(EventName(args…))</c> (a no-op for an unknown event).</summary>
    private void WriteEmitStatement(
        StringBuilder sb, KotlinEmitContext emit, EmitClause em, KotlinExpressionTranslator translator,
        string eventsField, string receiver, string indent)
    {
        if (BuildEmitExpression(emit, em, translator) is { } expr)
        {
            sb.Append(indent).Append(receiver).Append(eventsField).Append(".add(").Append(expr).Append(")\n");
        }
    }

    /// <summary>
    /// Builds the <c>EventName(args…)</c> constructor call for an <c>emit EventName(field: value, …)</c> clause
    /// (null for an unknown event — the validator guarantees presence). Arguments bind by field name in the
    /// event data class's declaration order, with a bare enum member qualified; a missing field falls back to a
    /// benign type default so the emitted code still compiles.
    /// </summary>
    private static string? BuildEmitExpression(KotlinEmitContext emit, EmitClause em, KotlinExpressionTranslator translator)
    {
        if (!emit.Index.TryGetDecl(em.EventName, out TypeDecl decl))
        {
            return null;
        }

        IReadOnlyList<Member> members = decl switch
        {
            EventDecl e => e.Members,
            IntegrationEventDecl ie => ie.Members,
            _ => Array.Empty<Member>(),
        };

        var argByField = em.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);
        var args = members.Select(m =>
        {
            if (!argByField.TryGetValue(m.Name, out Expr? value))
            {
                return KotlinTypeDefault(m.Type);
            }

            var expectedEnum = emit.Index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
            return translator.Translate(value, KotlinExpressionTranslator.NameMode.Property, expectedEnum);
        });

        return KotlinNaming.ToTypeName(em.EventName) + "(" + string.Join(", ", args) + ")";
    }

    /// <summary>
    /// Emits a factory as a companion-object function that obtains the new entity's identity, checks the factory
    /// preconditions, constructs through the validating primary constructor (which runs the invariants), and
    /// records any creation events. Identity is minted by default (<c>&lt;Id&gt;.generate()</c> for a UUID id);
    /// when the factory supplies it as an explicit identity-typed parameter (#324) the local <c>id</c> binds to
    /// that parameter instead.
    /// </summary>
    private void WriteFactory(
        StringBuilder sb, KotlinEmitContext emit, string typeName, string idType, EntityDecl entity, FactoryDecl factory,
        KotlinExpressionTranslator translator, KotlinTypeMapper typeMapper, IReadOnlyList<Member> required, string eventsField)
    {
        var method = KotlinNaming.ToMemberName(factory.Name);
        var paramList = string.Join(", ", factory.Parameters.Select(p => KotlinNaming.ToMemberName(p.Name) + ": " + typeMapper.Map(p.Type)));

        // Factory scope: the generated `id` and the factory parameters are locals (they shadow any same-named
        // member); the entity itself does not exist until construction.
        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        WriteKdoc(sb, factory.Doc, Indent + Indent);
        sb.Append(Indent).Append(Indent).Append("fun ").Append(method).Append('(').Append(paramList).Append("): ").Append(typeName).Append(" {\n");
        var body = Indent + Indent + Indent;

        // 1. Identity, in scope for the preconditions and the event payloads.
        FactoryIdBinding idBinding = FactoryIdBinding.ResolveFactoryId(entity, factory, KotlinNaming.ToMemberName);
        switch (idBinding.Source)
        {
            case FactoryIdSource.Generate:
                sb.Append(body).Append("val id: ").Append(idType).Append(" = ").Append(MintExpression(entity, idType)).Append('\n');
                break;
            case FactoryIdSource.Alias:
                sb.Append(body).Append("val id: ").Append(idType).Append(" = ").Append(idBinding.AliasFrom).Append('\n');
                break;
            case FactoryIdSource.ParamProvidesIdDirectly:
                // The `id` parameter already provides the local — emit nothing.
                break;
        }

        // 2. Preconditions — before any state is constructed.
        foreach (RequiresClause req in factory.Body.OfType<RequiresClause>())
        {
            var cond = translator.Translate(req.Condition, KotlinExpressionTranslator.NameMode.Property);
            sb.Append(body).Append("if (!(").Append(cond).Append(")) throw koine.runtime.DomainException(")
              .Append(KotlinStringLiteral(req.Message ?? "precondition failed")).Append(")\n");
        }

        // 3. Construct through the validating constructor, then attach any creation events.
        var ctorArgs = BuildFactoryCtorArgs(emit, factory, required, translator);
        var emits = factory.Body.OfType<EmitClause>().ToList();
        if (emits.Count > 0)
        {
            sb.Append(body).Append("val instance = ").Append(typeName).Append('(').Append(string.Join(", ", ctorArgs)).Append(")\n");
            foreach (EmitClause em in emits)
            {
                WriteEmitStatement(sb, emit, em, translator, eventsField, "instance.", body);
            }

            sb.Append(body).Append("return instance\n");
        }
        else
        {
            sb.Append(body).Append("return ").Append(typeName).Append('(').Append(string.Join(", ", ctorArgs)).Append(")\n");
        }

        sb.Append(Indent).Append(Indent).Append("}\n");

        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        translator.PopLocal("id");
    }

    /// <summary>
    /// The positional arguments for a factory's <c>&lt;Entity&gt;(id, …)</c> construction. Each required member
    /// draws its value, in priority order, from an explicit <c>field &lt;- expr</c> initialization, a same-named
    /// auto-bound parameter, a null for an unset optional, or a benign type default.
    /// </summary>
    private static List<string> BuildFactoryCtorArgs(
        KotlinEmitContext emit, FactoryDecl factory, IReadOnlyList<Member> required, KotlinExpressionTranslator translator)
    {
        var initByField = new Dictionary<string, Expr>(StringComparer.Ordinal);
        foreach (Initialization init in factory.Body.OfType<Initialization>())
        {
            initByField.TryAdd(init.Field, init.Value);
        }

        var args = new List<string> { "id" };
        foreach (Member m in required)
        {
            if (initByField.TryGetValue(m.Name, out Expr? value))
            {
                var expectedEnum = emit.Index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
                args.Add(translator.Translate(value, KotlinExpressionTranslator.NameMode.Property, expectedEnum));
            }
            else if (factory.Parameters.Any(p => MemberAnalysis.AutoBinds(p, m)))
            {
                args.Add(KotlinNaming.ToMemberName(m.Name)); // auto-bound same-named parameter
            }
            else if (m.Type.IsOptional)
            {
                args.Add("null");
            }
            else
            {
                args.Add(KotlinTypeDefault(m.Type));
            }
        }

        return args;
    }

    /// <summary>Writes identity-based <c>equals</c>/<c>hashCode</c> keyed on the id (an entity is its identity).</summary>
    private static void WriteIdentityEquality(StringBuilder sb, string name)
    {
        sb.Append(Indent).Append("override fun equals(other: Any?): Boolean =\n");
        sb.Append(Indent).Append(Indent).Append("this === other || (other is ").Append(name).Append(" && this.id == other.id)\n\n");
        sb.Append(Indent).Append("override fun hashCode(): Int = this.id.hashCode()\n");
    }

    // ----------------------------------------------------------------------
    // Shared entity analysis
    // ----------------------------------------------------------------------

    /// <summary>
    /// The Kotlin expression that mints a factory's identity: <c>&lt;Id&gt;.generate()</c> for a UUID id (the
    /// only client-mintable kind). A sequence/natural identity is store-assigned or a real-world key — a factory
    /// cannot mint it, and its <c>@JvmInline value class</c> is non-nullable, so (unlike Java's nullable
    /// reference types) a <c>null</c> mint would not compile. We emit a <c>TODO(…)</c>, which type-checks (it
    /// returns <c>Nothing</c>) and fails loudly at runtime — a factory over a non-mintable identity is a
    /// validator-warned model shape that should supply the id as a parameter instead.
    /// </summary>
    private static string MintExpression(EntityDecl entity, string idType) =>
        KotlinIdBacking(entity).Kind == KotlinIdKind.Uuid
            ? idType + ".generate()"
            : $"TODO(\"{idType} is a store-assigned/natural identity and cannot be minted in a factory\")";

    /// <summary>The member names mutated by at least one behavior transition (so the property is a <c>var … private set</c>).</summary>
    private static ISet<string> MutatedFields(EntityDecl entity) =>
        new HashSet<string>(
            entity.Commands.SelectMany(c => c.Body).OfType<Transition>().Select(t => t.Field),
            StringComparer.Ordinal);

    /// <summary>True when any behavior or factory of the entity raises a domain event (so it records events).</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>
    /// A collision-free name for the entity's recorded-events accessor (base <c>domainEvents</c>, underscore-suffixed
    /// until it clears every emitted member/behavior/factory name plus the fixed <c>id</c>) — so the accessor never
    /// collides with a user member literally named <c>domainEvents</c>. The private backing field prefixes it with
    /// <c>_</c>.
    /// </summary>
    private static string SyntheticEventsName(EntityDecl entity)
    {
        var used = new HashSet<string>(StringComparer.Ordinal) { "id" };
        foreach (Member m in entity.Members)
        {
            used.Add(KotlinNaming.ToMemberName(m.Name));
        }

        foreach (CommandDecl c in entity.Commands)
        {
            used.Add(KotlinNaming.ToMemberName(c.Name));
        }

        foreach (FactoryDecl f in entity.Factories)
        {
            used.Add(KotlinNaming.ToMemberName(f.Name));
        }

        var name = "domainEvents";
        while (used.Contains(name))
        {
            name += "_";
        }

        return name;
    }

    /// <summary>A benign Kotlin default for a type (an unset optional/collection or a validator-warned required field).</summary>
    private static string KotlinTypeDefault(TypeRef type)
    {
        if (type.IsOptional)
        {
            return "null";
        }

        return type.Name switch
        {
            "Int" => "0L",
            "Bool" => "false",
            "Decimal" => "java.math.BigDecimal.ZERO",
            ModelIndex.ListTypeName => "emptyList()",
            ModelIndex.SetTypeName => "emptySet()",
            ModelIndex.MapTypeName => "emptyMap()",
            _ => "TODO()",
        };
    }
}
