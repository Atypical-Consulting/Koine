using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The entity slice of <see cref="JavaEmitter"/>. A Koine <c>entity</c> emits as a
/// <c>public final class</c> with <c>private</c> fields (an identity field plus one per member),
/// a validating constructor that enforces the invariants (throwing <c>koine.runtime.DomainException</c>,
/// the Java analogue of the Rust smart constructor's <c>Result::Err</c> and the C# guarded constructor),
/// identity-based <c>equals</c>/<c>hashCode</c> keyed on the id field, get-accessors for the readable
/// members, and one mutating method per behavior — each re-checking its preconditions, applying its state
/// transitions, re-validating the entity invariants, and recording any domain events. The entity's
/// generated identity type is emitted as a separate branded <c>record</c> file (deferred here from the
/// value-object task): a <c>java.util.UUID</c>/<c>String</c>/<c>long</c> wrapper carrying any format
/// invariant in its compact constructor, and a <c>generate()</c> minter for a UUID identity.
/// <para>
/// Because the fields are mutable stored state, the shared <see cref="JavaExpressionTranslator"/> is built
/// with <c>membersAsAccessors: false</c> and every behavior/invariant expression is translated in
/// <see cref="JavaExpressionTranslator.NameMode.Property"/> — a stored member renders as
/// <c>this.&lt;field&gt;</c> and a derived (computed) member as <c>this.&lt;field&gt;()</c>. Behavior and
/// factory parameters are registered as locals (<see cref="JavaExpressionTranslator.PushLocal"/>) before
/// their body is translated. Recorded domain events reference the per-context <c>DomainEvent</c> sealed
/// interface by simple name (same package), which the events task emits.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>How an entity's generated identity type is backed in Java.</summary>
    private enum JavaIdKind
    {
        /// <summary>A <c>java.util.UUID</c>-backed identity (the default Guid strategy) with a <c>generate()</c> minter.</summary>
        Uuid,

        /// <summary>A <c>long</c>-backed identity (a store-assigned sequence, or a natural <c>Int</c> key).</summary>
        LongId,

        /// <summary>A <c>String</c>-backed identity (a natural <c>String</c> key), validated non-blank at construction.</summary>
        StringId,
    }

    /// <summary>Emits an entity as its class file plus its generated identity <c>record</c> file (one public type per file).</summary>
    private void EmitEntity(JavaEmitContext emit, List<EmittedFile> files, string context, EntityDecl entity)
    {
        files.Add(EmitEntityClass(emit, context, entity));
        files.Add(EmitId(emit, context, entity));
    }

    /// <summary>Builds the entity class file: fields, validating constructor, accessors, behaviors/factories, and identity equality.</summary>
    private EmittedFile EmitEntityClass(JavaEmitContext emit, string context, EntityDecl entity)
    {
        var name = JavaNaming.Type(entity.Name);
        var idType = JavaNaming.Type(entity.IdentityName);
        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);

        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var stored = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var required = stored.Where(m => m.Initializer is null).ToList();
        var defaulted = stored.Where(m => m.Initializer is not null).ToList();
        var mutated = MutatedFields(entity);
        var hasEmits = EmitsEvents(entity);
        var eventsField = SyntheticEventsField(entity);

        // A synthetic `id` member (of the identity type) so an `id` reference in a behavior body or an
        // `emit` argument resolves to the entity's identity field (`this.id`), mirroring the other backends.
        var bodyMembers = entity.Members
            .Append(new Member("id", new TypeRef(entity.IdentityName), null))
            .ToList();
        // membersAsAccessors:false — mutable stored fields, so a member read in a method body is `this.<field>`
        // (a derived member reads through its `this.<field>()` accessor); parameter-mode reads stay bare.
        var translator = new JavaExpressionTranslator(
            emit.Index, bodyMembers, typeMapper, context: context,
            memberReceiver: "this", membersAsAccessors: false);

        var sb = new StringBuilder();
        WriteJavadoc(sb, entity.Doc, string.Empty);
        sb.Append("public final class ").Append(name).Append(" {\n");

        // Fields: identity first (always final), then stored members (final unless a behavior mutates them).
        sb.Append(Indent).Append("private final ").Append(idType).Append(" id;\n");
        foreach (Member m in stored)
        {
            WriteJavadoc(sb, m.Doc, Indent);
            var modifier = mutated.Contains(m.Name) ? "private " : "private final ";
            sb.Append(Indent).Append(modifier).Append(typeMapper.Map(m.Type)).Append(' ')
              .Append(JavaNaming.Member(m.Name)).Append(";\n");
        }

        // The recorded-domain-events collector (only when a behavior/factory emits events).
        if (hasEmits)
        {
            sb.Append(Indent).Append("private final java.util.List<DomainEvent> ").Append(eventsField)
              .Append(" = new java.util.ArrayList<>();\n");
        }

        // Validating constructor.
        sb.Append('\n');
        WriteEntityConstructor(sb, emit, name, idType, entity, required, defaulted, typeMapper, translator);

        // Shared invariant check, called by the constructor and every mutating behavior.
        if (entity.Invariants.Count > 0)
        {
            sb.Append('\n');
            WriteCheckInvariants(sb, entity, translator);
        }

        // Accessors: id, then each stored member, then each derived (computed) member.
        sb.Append('\n');
        sb.Append(Indent).Append("public ").Append(idType).Append(" id() {\n");
        sb.Append(Indent).Append(Indent).Append("return this.id;\n");
        sb.Append(Indent).Append("}\n");
        foreach (Member m in stored)
        {
            sb.Append('\n');
            WriteFieldAccessor(sb, m, typeMapper);
        }

        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteDerivedMethod(sb, emit, m, typeMapper, translator);
        }

        // The recorded-events accessor (an unmodifiable snapshot).
        if (hasEmits)
        {
            sb.Append('\n');
            WriteJavadoc(sb, "The domain events recorded so far, as an unmodifiable snapshot.", Indent);
            sb.Append(Indent).Append("public java.util.List<DomainEvent> ").Append(eventsField).Append("() {\n");
            sb.Append(Indent).Append(Indent).Append("return java.util.List.copyOf(this.").Append(eventsField).Append(");\n");
            sb.Append(Indent).Append("}\n");
        }

        // Mutating behaviors.
        foreach (CommandDecl cmd in entity.Commands)
        {
            sb.Append('\n');
            WriteBehavior(sb, emit, name, entity, cmd, translator, typeMapper, eventsField);
        }

        // Factories: static creation methods that mint identity, check preconditions, build, and record events.
        foreach (FactoryDecl factory in entity.Factories)
        {
            sb.Append('\n');
            WriteFactory(sb, emit, name, idType, entity, factory, translator, typeMapper, required, eventsField);
        }

        // Identity-based equality (an entity is its identity).
        sb.Append('\n');
        WriteIdentityEquality(sb, name);

        sb.Append("}\n");
        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>
    /// Writes the validating constructor: identity parameter first, then the required members. It assigns the
    /// identity, defensively normalizes and assigns each required member (an optional → a never-null
    /// <c>Optional</c>, a collection → an unmodifiable copy), binds each defaulted member to its initializer,
    /// then runs <c>checkInvariants()</c> so a constructed entity is always valid.
    /// </summary>
    private void WriteEntityConstructor(
        StringBuilder sb, JavaEmitContext emit, string name, string idType, EntityDecl entity,
        IReadOnlyList<Member> required, IReadOnlyList<Member> defaulted,
        JavaTypeMapper typeMapper, JavaExpressionTranslator translator)
    {
        var ctorParams = new List<string> { idType + " id" };
        ctorParams.AddRange(required.Select(m => typeMapper.Map(m.Type) + " " + JavaNaming.Member(m.Name)));

        WriteJavadoc(sb, "Creates a validated " + name + ", enforcing its invariants.", Indent);
        sb.Append(Indent).Append("public ").Append(name).Append('(').Append(string.Join(", ", ctorParams)).Append(") {\n");

        sb.Append(Indent).Append(Indent).Append("this.id = id;\n");
        foreach (Member m in required)
        {
            sb.Append(Indent).Append(Indent).Append("this.").Append(JavaNaming.Member(m.Name)).Append(" = ")
              .Append(NormalizedCtorArg(m)).Append(";\n");
        }

        foreach (Member m in defaulted)
        {
            var value = translator.Translate(m.Initializer!, JavaExpressionTranslator.NameMode.Parameter, EnumExpected(m, emit.Index));
            sb.Append(Indent).Append(Indent).Append("this.").Append(JavaNaming.Member(m.Name)).Append(" = ")
              .Append(value).Append(";\n");
        }

        if (entity.Invariants.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("checkInvariants();\n");
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// The constructor-argument expression for a required member, defensively normalized: a nullable becomes a
    /// never-null <c>Optional</c>, and a <c>List</c>/<c>Set</c>/<c>Map</c> becomes an unmodifiable copy — so a
    /// constructed entity never holds a null <c>Optional</c> or an aliased mutable collection. Optionality wins
    /// over the collection case.
    /// </summary>
    private static string NormalizedCtorArg(Member m)
    {
        var field = JavaNaming.Member(m.Name);
        if (m.Type.IsOptional)
        {
            return field + " == null ? java.util.Optional.empty() : " + field;
        }

        if (JavaTypeMapper.IsMap(m.Type))
        {
            return "java.util.Map.copyOf(" + field + ")";
        }

        if (JavaTypeMapper.IsSet(m.Type))
        {
            return "java.util.Set.copyOf(" + field + ")";
        }

        if (JavaTypeMapper.IsList(m.Type))
        {
            return "java.util.List.copyOf(" + field + ")";
        }

        return field;
    }

    /// <summary>Writes the shared <c>checkInvariants()</c> method: one fail-fast guard per invariant over the current state.</summary>
    private static void WriteCheckInvariants(StringBuilder sb, EntityDecl entity, JavaExpressionTranslator translator)
    {
        sb.Append(Indent).Append("private void checkInvariants() {\n");
        foreach (Invariant inv in entity.Invariants)
        {
            AppendInvariantGuard(sb, inv, translator, Indent + Indent, JavaExpressionTranslator.NameMode.Property);
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits one invariant as a fail-fast guard: <c>if (&lt;failure&gt;) { throw new DomainException(msg); }</c>.
    /// A plain invariant fails when its condition does not hold (<c>!(cond)</c>); a <c>body when cond</c> guard
    /// fails only when the guard fires and the body does not (<c>(cond) &amp;&amp; !(body)</c>).
    /// </summary>
    private static void AppendInvariantGuard(
        StringBuilder sb, Invariant inv, JavaExpressionTranslator translator, string indent,
        JavaExpressionTranslator.NameMode mode)
    {
        string failure;
        if (inv.Condition is GuardExpr guard)
        {
            var cond = translator.Translate(guard.Condition, mode);
            var body = translator.Translate(guard.Body, mode);
            failure = "(" + cond + ") && !(" + body + ")";
        }
        else
        {
            failure = "!(" + translator.Translate(inv.Condition, mode) + ")";
        }

        sb.Append(indent).Append("if (").Append(failure).Append(") {\n");
        sb.Append(indent).Append(Indent).Append("throw new koine.runtime.DomainException(")
          .Append(JavaStringLiteral(inv.Message ?? "invariant violated")).Append(");\n");
        sb.Append(indent).Append("}\n");
    }

    /// <summary>Emits a get-accessor for a stored member: <c>public &lt;type&gt; &lt;name&gt;() { return this.&lt;name&gt;; }</c>.</summary>
    private static void WriteFieldAccessor(StringBuilder sb, Member m, JavaTypeMapper typeMapper)
    {
        WriteJavadoc(sb, m.Doc, Indent);
        var field = JavaNaming.Member(m.Name);
        sb.Append(Indent).Append("public ").Append(typeMapper.Map(m.Type)).Append(' ').Append(field).Append("() {\n");
        sb.Append(Indent).Append(Indent).Append("return this.").Append(field).Append(";\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>Emits a derived (computed) member as a get-only accessor reading through the stored fields.</summary>
    private static void WriteDerivedMethod(
        StringBuilder sb, JavaEmitContext emit, Member m, JavaTypeMapper typeMapper, JavaExpressionTranslator translator)
    {
        WriteJavadoc(sb, m.Doc, Indent);
        var body = translator.Translate(m.Initializer!, JavaExpressionTranslator.NameMode.Property, EnumExpected(m, emit.Index));
        sb.Append(Indent).Append("public ").Append(typeMapper.Map(m.Type)).Append(' ')
          .Append(JavaNaming.Member(m.Name)).Append("() {\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(body).Append(";\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits a mutating behavior as a public method: preconditions (<c>requires</c>) throwing
    /// <c>DomainException</c> when a guard fails, then state transitions, then an invariant re-check over the
    /// post-transition state, then any recorded domain events, then the optional result. Behavior parameters
    /// are locals while the body is translated (members stay <c>this.&lt;field&gt;</c>).
    /// </summary>
    private void WriteBehavior(
        StringBuilder sb, JavaEmitContext emit, string typeName, EntityDecl entity, CommandDecl cmd,
        JavaExpressionTranslator translator, JavaTypeMapper typeMapper, string eventsField)
    {
        var method = JavaNaming.Member(cmd.Name);
        var paramList = string.Join(", ", cmd.Parameters.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));
        var returnType = cmd.ReturnType is { } rt ? typeMapper.Map(rt) : "void";

        foreach (Param p in cmd.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        WriteJavadoc(sb, cmd.Doc, Indent);
        sb.Append(Indent).Append("public ").Append(returnType).Append(' ').Append(method).Append('(').Append(paramList).Append(") {\n");

        // 1. Preconditions.
        foreach (RequiresClause req in cmd.Body.OfType<RequiresClause>())
        {
            WritePrecondition(sb, req, translator);
        }

        // 2. State transitions.
        foreach (Transition t in cmd.Body.OfType<Transition>())
        {
            WriteTransition(sb, emit, entity, t, translator);
        }

        // 3. Re-check the entity invariants over the post-transition state.
        if (entity.Invariants.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("checkInvariants();\n");
        }

        // 4. Record the domain events this behavior raises.
        foreach (EmitClause em in cmd.Body.OfType<EmitClause>())
        {
            WriteEmitStatement(sb, emit, em, translator, eventsField, "this.");
        }

        // 5. Result (only when the behavior declares a return type).
        if (cmd.Body.OfType<ResultClause>().FirstOrDefault() is { } result)
        {
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(result.Value, JavaExpressionTranslator.NameMode.Property)).Append(";\n");
        }

        sb.Append(Indent).Append("}\n");

        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }
    }

    /// <summary>Emits a precondition guard: <c>if (!(cond)) { throw new DomainException(msg); }</c> (Property mode).</summary>
    private static void WritePrecondition(StringBuilder sb, RequiresClause req, JavaExpressionTranslator translator)
    {
        var cond = translator.Translate(req.Condition, JavaExpressionTranslator.NameMode.Property);
        sb.Append(Indent).Append(Indent).Append("if (!(").Append(cond).Append(")) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new koine.runtime.DomainException(")
          .Append(JavaStringLiteral(req.Message ?? "precondition failed")).Append(");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits a state transition <c>Field -&gt; Value</c> as a field assignment <c>this.&lt;field&gt; = &lt;value&gt;;</c>.
    /// Assigning a non-optional value into an <c>Optional</c> field (e.g. <c>placedAt -&gt; now</c>) wraps it in
    /// <c>Optional.of(...)</c>; an already-optional value flows through unchanged. A bare enum member on the RHS
    /// is qualified with the field's enum type.
    /// </summary>
    private void WriteTransition(StringBuilder sb, JavaEmitContext emit, EntityDecl entity, Transition t, JavaExpressionTranslator translator)
    {
        Member? field = entity.Members.FirstOrDefault(m => m.Name == t.Field);
        var expectedEnum = field is not null && emit.Index.Classify(field.Type.Name) == TypeKind.Enum ? field.Type.Name : null;
        var value = translator.Translate(t.Value, JavaExpressionTranslator.NameMode.Property, expectedEnum);

        if (field is { Type.IsOptional: true } && translator.InferType(t.Value)?.IsOptional != true)
        {
            value = "java.util.Optional.of(" + value + ")";
        }

        sb.Append(Indent).Append(Indent).Append("this.").Append(JavaNaming.Member(t.Field)).Append(" = ").Append(value).Append(";\n");
    }

    /// <summary>Records a domain event: <c>&lt;receiver&gt;&lt;events&gt;.add(new EventName(args…));</c> (null-skipping for an unknown event).</summary>
    private void WriteEmitStatement(
        StringBuilder sb, JavaEmitContext emit, EmitClause em, JavaExpressionTranslator translator,
        string eventsField, string receiver)
    {
        if (BuildEmitExpression(emit, em, translator) is { } expr)
        {
            sb.Append(Indent).Append(Indent).Append(receiver).Append(eventsField).Append(".add(").Append(expr).Append(");\n");
        }
    }

    /// <summary>
    /// Builds the <c>new EventName(args…)</c> expression for an <c>emit EventName(field: value, …)</c> clause
    /// (null for an unknown event — the validator guarantees presence). Arguments bind by field name in the
    /// event record's declaration order, with a bare enum member qualified; a missing field falls back to a
    /// benign type default so the emitted code still compiles.
    /// </summary>
    private static string? BuildEmitExpression(JavaEmitContext emit, EmitClause em, JavaExpressionTranslator translator)
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
                return JavaTypeDefault(m.Type);
            }

            var expectedEnum = emit.Index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
            return translator.Translate(value, JavaExpressionTranslator.NameMode.Property, expectedEnum);
        });

        return "new " + JavaNaming.Type(em.EventName) + "(" + string.Join(", ", args) + ")";
    }

    /// <summary>
    /// Emits a factory as a static creation method that obtains the new entity's identity, checks the factory
    /// preconditions, constructs through the validating constructor (which runs the invariants), and records
    /// any creation events. Identity is minted by default (<c>&lt;Id&gt;.generate()</c> for a UUID id); when
    /// the factory supplies it as an explicit identity-typed parameter (#324) the local <c>id</c> binds to that
    /// parameter instead.
    /// </summary>
    private void WriteFactory(
        StringBuilder sb, JavaEmitContext emit, string typeName, string idType, EntityDecl entity, FactoryDecl factory,
        JavaExpressionTranslator translator, JavaTypeMapper typeMapper, IReadOnlyList<Member> required, string eventsField)
    {
        var method = JavaNaming.Member(factory.Name);
        var paramList = string.Join(", ", factory.Parameters.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));

        // Factory scope: the generated `id` and the factory parameters are locals (they shadow any same-named
        // member); the entity itself does not exist until construction.
        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        WriteJavadoc(sb, factory.Doc, Indent);
        sb.Append(Indent).Append("public static ").Append(typeName).Append(' ').Append(method).Append('(').Append(paramList).Append(") {\n");

        // 1. Identity, in scope for the preconditions and the event payloads.
        FactoryIdBinding idBinding = FactoryIdBinding.ResolveFactoryId(entity, factory, JavaNaming.Member);
        switch (idBinding.Source)
        {
            case FactoryIdSource.Generate:
                sb.Append(Indent).Append(Indent).Append(idType).Append(" id = ").Append(MintExpression(entity, idType)).Append(";\n");
                break;
            case FactoryIdSource.Alias:
                sb.Append(Indent).Append(Indent).Append(idType).Append(" id = ").Append(idBinding.AliasFrom).Append(";\n");
                break;
            case FactoryIdSource.ParamProvidesIdDirectly:
                // The `id` parameter already provides the local — emit nothing.
                break;
        }

        // 2. Preconditions — before any state is constructed.
        foreach (RequiresClause req in factory.Body.OfType<RequiresClause>())
        {
            WritePrecondition(sb, req, translator);
        }

        // 3. Construct through the validating constructor, then attach any creation events.
        var ctorArgs = BuildFactoryCtorArgs(emit, factory, required, translator);
        var emits = factory.Body.OfType<EmitClause>().ToList();
        if (emits.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append(typeName).Append(" instance = new ").Append(typeName)
              .Append('(').Append(string.Join(", ", ctorArgs)).Append(");\n");
            foreach (EmitClause em in emits)
            {
                WriteEmitStatement(sb, emit, em, translator, eventsField, "instance.");
            }

            sb.Append(Indent).Append(Indent).Append("return instance;\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append("return new ").Append(typeName)
              .Append('(').Append(string.Join(", ", ctorArgs)).Append(");\n");
        }

        sb.Append(Indent).Append("}\n");

        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        translator.PopLocal("id");
    }

    /// <summary>
    /// The positional arguments for a factory's <c>new &lt;Entity&gt;(id, …)</c> call. Each required member draws
    /// its value, in priority order, from an explicit <c>field &lt;- expr</c> initialization, a same-named
    /// auto-bound parameter, <c>Optional.empty()</c> for an unset optional, or a defensive type default (a
    /// required+unset member is a validator-warned case).
    /// </summary>
    private static List<string> BuildFactoryCtorArgs(
        JavaEmitContext emit, FactoryDecl factory, IReadOnlyList<Member> required, JavaExpressionTranslator translator)
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
                var translated = translator.Translate(value, JavaExpressionTranslator.NameMode.Property, expectedEnum);
                args.Add(ReconcileFactoryCtorArg(translator.InferType(value), m.Type, translated));
            }
            else if (factory.Parameters.FirstOrDefault(p => MemberAnalysis.AutoBinds(p, m)) is { } boundParam)
            {
                var field = JavaNaming.Member(m.Name); // auto-bound same-named parameter

                // Wrap in Optional.of(...) only when the bound parameter isn't itself Optional-typed —
                // AutoBinds legally permits a non-optional parameter to bind to an optional-declared
                // required member (the constructor still declares Optional<T> since the member can be
                // legitimately unset in other factories), but a param that is already optional-typed is
                // already the correct Optional<T> shape, and wrapping it again would double-wrap into
                // Optional<Optional<T>>, a real javac "incompatible types" error.
                args.Add(m.Type.IsOptional && !boundParam.Type.IsOptional
                    ? $"java.util.Optional.of({field})"
                    : field);
            }
            else if (m.Type.IsOptional)
            {
                args.Add("java.util.Optional.empty()");
            }
            else
            {
                args.Add(JavaTypeDefault(m.Type));
            }
        }

        return args;
    }

    /// <summary>
    /// Reconciles an explicit-init factory ctor argument's already-translated Java expression against the
    /// member's <paramref name="declared"/> type, reusing the same shared <see cref="BranchReconciliation"/>
    /// decision (#1368) every code emitter's ternary-branch reconciliation already applies (#1344) rather
    /// than a hand-rolled, narrower duplicate (#1519) — composed exactly as <c>WriteReconciledBranch</c>
    /// does: widen inside, wrap outside. <c>NeedsWiden</c> widens a non-optional <c>Int</c> value to
    /// <c>BigDecimal</c>; <c>NeedsOptionalWiden</c> does the same when the value is itself
    /// <c>Optional</c>-typed, via <c>.map(BigDecimal::valueOf)</c> instead (an already-<c>Optional</c>-shaped
    /// value can't be widened with a bare call); <c>NeedsSomeWrap</c> lifts a non-optional value into
    /// <c>Optional.of(...)</c> against an optional-declared member (#1479). <c>NeedsWiden</c> and
    /// <c>NeedsOptionalWiden</c> are mutually exclusive and <c>NeedsOptionalWiden</c> never composes with
    /// <c>NeedsSomeWrap</c> (see <see cref="BranchReconciliation"/>'s own remarks), so applying all three in
    /// sequence is safe.
    /// </summary>
    private static string ReconcileFactoryCtorArg(TypeRef? valueType, TypeRef declared, string body)
    {
        BranchReconciliation needs = BranchReconciliation.Classify(valueType, declared);
        var widened = needs.NeedsWiden ? $"java.math.BigDecimal.valueOf({body})" : body;
        var mapped = needs.NeedsOptionalWiden ? $"{widened}.map(java.math.BigDecimal::valueOf)" : widened;
        return needs.NeedsSomeWrap ? $"java.util.Optional.of({mapped})" : mapped;
    }

    /// <summary>Writes identity-based <c>equals</c>/<c>hashCode</c> keyed on the id field (an entity is its identity).</summary>
    private static void WriteIdentityEquality(StringBuilder sb, string name)
    {
        sb.Append(Indent).Append("@Override\n");
        sb.Append(Indent).Append("public boolean equals(Object o) {\n");
        sb.Append(Indent).Append(Indent).Append("if (this == o) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return true;\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("if (!(o instanceof ").Append(name).Append(" other)) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return false;\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("return java.util.Objects.equals(this.id, other.id);\n");
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("@Override\n");
        sb.Append(Indent).Append("public int hashCode() {\n");
        sb.Append(Indent).Append(Indent).Append("return java.util.Objects.hashCode(this.id);\n");
        sb.Append(Indent).Append("}\n");
    }

    // ----------------------------------------------------------------------
    // Generated identity record
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits an entity's generated identity type as a branded <c>record</c> file wrapping a
    /// <c>java.util.UUID</c> (the default Guid strategy), a <c>long</c> (a sequence or natural <c>Int</c> key),
    /// or a <c>String</c> (a natural <c>String</c> key). A String-backed id validates non-blank in its compact
    /// constructor; a UUID-backed id gains a <c>generate()</c> minter that mints a fresh v4 UUID.
    /// </summary>
    private EmittedFile EmitId(JavaEmitContext emit, string context, EntityDecl entity)
    {
        var idName = JavaNaming.Type(entity.IdentityName);
        (string javaType, JavaIdKind kind) = JavaIdBacking(entity);

        var sb = new StringBuilder();
        WriteJavadoc(sb, "A strongly-typed identity value for " + JavaNaming.Type(entity.Name) + ".", string.Empty);
        sb.Append("public record ").Append(idName).Append('(').Append(javaType).Append(" value) {\n");

        if (kind == JavaIdKind.StringId)
        {
            // A natural string key cannot be blank — it is the entity's real-world identity.
            sb.Append(Indent).Append("public ").Append(idName).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append("if (value == null || value.isBlank()) {\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new koine.runtime.DomainException(")
              .Append(JavaStringLiteral("identity value cannot be blank")).Append(");\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append("}\n");
        }

        if (kind == JavaIdKind.Uuid)
        {
            WriteJavadoc(sb, "Mints a fresh, random identity (a v4 UUID).", Indent);
            sb.Append(Indent).Append("public static ").Append(idName).Append(" generate() {\n");
            sb.Append(Indent).Append(Indent).Append("return new ").Append(idName).Append("(java.util.UUID.randomUUID());\n");
            sb.Append(Indent).Append("}\n");
        }

        sb.Append("}\n");
        return TypeFile(context, idName, sb.ToString());
    }

    /// <summary>The Java expression that mints a factory's identity: <c>&lt;Id&gt;.generate()</c> for a UUID id (the only mintable kind).</summary>
    private string MintExpression(EntityDecl entity, string idType) =>
        JavaIdBacking(entity).Kind == JavaIdKind.Uuid ? idType + ".generate()" : "null";

    /// <summary>The Java backing type and kind of an entity's generated identity (per its <see cref="IdentityStrategy"/>).</summary>
    private static (string JavaType, JavaIdKind Kind) JavaIdBacking(EntityDecl entity) => entity.IdStrategy switch
    {
        IdentityStrategy.Sequence => ("long", JavaIdKind.LongId),
        IdentityStrategy.Natural => entity.IdBackingType == "Int" ? ("long", JavaIdKind.LongId) : ("String", JavaIdKind.StringId),
        _ => ("java.util.UUID", JavaIdKind.Uuid), // Guid (default): a UUID-backed brand with a client-side generator.
    };

    // ----------------------------------------------------------------------
    // Shared entity analysis
    // ----------------------------------------------------------------------

    /// <summary>The member names mutated by at least one behavior transition (so the field is not <c>final</c>).</summary>
    private static ISet<string> MutatedFields(EntityDecl entity) =>
        new HashSet<string>(
            entity.Commands.SelectMany(c => c.Body).OfType<Transition>().Select(t => t.Field),
            StringComparer.Ordinal);

    /// <summary>True when any behavior or factory of the entity raises a domain event (so it records events).</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>
    /// A collision-free name for the entity's synthetic recorded-events list (base <c>domainEvents</c>,
    /// underscore-suffixed until it clears every emitted member/behavior/factory name plus the fixed
    /// <c>id</c>) — so the collector never duplicates a user member literally named <c>domainEvents</c>.
    /// </summary>
    private static string SyntheticEventsField(EntityDecl entity)
    {
        var used = new HashSet<string>(StringComparer.Ordinal) { "id" };
        foreach (Member m in entity.Members)
        {
            used.Add(JavaNaming.Member(m.Name));
        }

        foreach (CommandDecl c in entity.Commands)
        {
            used.Add(JavaNaming.Member(c.Name));
        }

        foreach (FactoryDecl f in entity.Factories)
        {
            used.Add(JavaNaming.Member(f.Name));
        }

        var name = "domainEvents";
        while (used.Contains(name))
        {
            name += "_";
        }

        return name;
    }

    /// <summary>The enum type expected for a member's value (so a bare enum member reference qualifies), or null.</summary>
    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;

    /// <summary>A benign Java default for a type (an unset optional/collection or a validator-warned required field).</summary>
    private static string JavaTypeDefault(TypeRef type)
    {
        if (type.IsOptional)
        {
            return "java.util.Optional.empty()";
        }

        return type.Name switch
        {
            "Int" => "0L",
            "Bool" => "false",
            "Decimal" => "java.math.BigDecimal.ZERO",
            _ => "null",
        };
    }
}
