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
        // #1848: an identity type the model ALSO declares explicitly (`value OrderId { … }`) is
        // already emitted via the ValueObjectDecl case elsewhere — synthesizing a second one here
        // would duplicate it under the same RelativePath and fail to compile.
        if (!DeclaredIdentityValueObject.IsDeclaredIn(emit.Index, context, entity.IdentityName))
        {
            files.Add(EmitId(emit, context, entity));
        }

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

        // The same pair for the R19 published-language collector, seeded with `eventsAccessor` so the
        // two synthetic members can never collide with each other either.
        var hasPublishes = PublishesEvents(entity);
        var integrationEventsAccessor = SyntheticIntegrationEventsName(entity, eventsAccessor);
        var integrationEventsField = "_" + integrationEventsAccessor;

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
            // Reconciled against the member's OWN declared type (#1880) via the same TranslateReconciled
            // the sibling call sites in this family already use (#1732/#1615/#1866) — the stored property
            // carries the declared Kotlin type, so an `Int` default on a `Decimal` member emitted
            // `val total: java.math.BigDecimal = 5L`, a hard `kotlinc` type mismatch.
            var value = translator.TranslateReconciled(m.Initializer!, KotlinExpressionTranslator.NameMode.Parameter, EnumExpected(m, emit.Index, translator.Context), m.Type);
            WriteStoredProperty(sb, m, typeMapper, value, mutated.Contains(m.Name));
        }

        if (hasEmits)
        {
            sb.Append(Indent).Append("private val ").Append(eventsField)
              .Append(": MutableList<DomainEvent> = mutableListOf()\n");
        }

        // The published-integration-events collector (R19): a SEPARATE list from the domain events
        // above — the two have distinct delivery (in-process dispatch vs. the transactional outbox).
        // The element type stays the per-context `DomainEvent` sealed interface, which this emitter
        // already has every integration-event data class implement (see EmitDomainEventInterface).
        if (hasPublishes)
        {
            sb.Append(Indent).Append("private val ").Append(integrationEventsField)
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

        // The published-integration-events accessor (R19), parallel to the domain-event one above.
        if (hasPublishes)
        {
            sb.Append('\n');
            WriteKdoc(sb, "The integration events published so far, as a read-only snapshot.", Indent);
            sb.Append(Indent).Append("fun ").Append(integrationEventsAccessor).Append("(): List<DomainEvent> = this.")
              .Append(integrationEventsField).Append(".toList()\n");
        }

        // Mutating behaviors.
        foreach (CommandDecl cmd in entity.Commands)
        {
            sb.Append('\n');
            WriteBehavior(sb, emit, entity, cmd, translator, typeMapper, eventsField, integrationEventsField);
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
        var body = translator.Translate(m.Initializer!, KotlinExpressionTranslator.NameMode.Property, EnumExpected(m, emit.Index, translator.Context));
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
        KotlinExpressionTranslator translator, KotlinTypeMapper typeMapper, string eventsField,
        string integrationEventsField)
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

        // Translate the `result` expression FIRST, in the SAME scope as the event payloads (parameters
        // are still pushed as locals — they are only popped once the whole body is written), so the
        // payload builders below can recognise it. When the same value is ALSO a whole payload argument
        // it is hoisted into one `__result` binding evaluated once (#1838): Koine's `now` reads the
        // clock, so a second rendering is a second reading, and the instant the event RECORDS would
        // drift from the one the behavior RETURNS.
        // Widen the result expression toward the command's declared return type (#1511) — an Int-inferred
        // `result` against a `: Decimal` return would otherwise emit an uncoerced `return this.tax` that
        // kotlinc rejects. Reuses the same TranslateReconciled decision the factory-ctor-arg (#1732) and
        // event-payload (below, #1866) call sites already apply.
        ResultClause? resultClause = cmd.Body.OfType<ResultClause>().FirstOrDefault();
        string? resultExpr = resultClause is { } result
            ? cmd.ReturnType is { } returnDecl
                ? translator.TranslateReconciled(result.Value, KotlinExpressionTranslator.NameMode.Property, cmd.ReturnType?.Name, returnDecl)
                : translator.Translate(result.Value, KotlinExpressionTranslator.NameMode.Property, cmd.ReturnType?.Name)
            : null;

        // The type resultExpr actually renders AS — starts as the value's own inferred type (what the
        // #1838 hoisted local below is annotated with) and is corrected when reconciliation widens the
        // rendering. Annotating the hoisted local with a STALE pre-widen type while initializing it from
        // the WIDENED expression is a real kotlinc "initializer type mismatch" error (#1866 code review:
        // an Int-typed `result` shared with a Decimal-widened payload hoisted to `val __result: Long =
        // BigDecimal.valueOf(...)`).
        TypeRef? resultRenderedType = resultClause is { } r0 ? translator.InferType(r0.Value) : null;
        if (resultClause is { } widenResult && cmd.ReturnType is { } widenReturnDecl)
        {
            TypeRef? valueType = translator.InferCtorArgValueType(widenResult.Value);
            BranchReconciliation needs = BranchReconciliation.Classify(valueType, widenReturnDecl);
            if (needs.NeedsWiden || needs.NeedsOptionalWiden)
            {
                resultRenderedType = new TypeRef("Decimal", IsOptional: needs.NeedsOptionalWiden);
            }
        }

        // The statements are BUILT here and WRITTEN below: the binding has to precede the first
        // `add(...)`, yet whether it is needed at all is only known once every payload has been
        // rendered and compared. Integration events (R19) join the SAME hoist — `emit` and `publish`
        // of one expression must record one instant, or the published contract stops mirroring the
        // domain event it accompanies.
        var eventStatements = new List<(string Text, bool Hoisted)>();
        foreach (EmitClause em in cmd.Body.OfType<EmitClause>())
        {
            if (BuildEmitStatement(emit, em, translator, eventsField, "this.", Indent + Indent, resultExpr) is { } stmt)
            {
                eventStatements.Add(stmt);
            }
        }

        foreach (PublishClause pub in cmd.Body.OfType<PublishClause>())
        {
            if (BuildPublishStatement(emit, pub, translator, integrationEventsField, Indent + Indent, resultExpr) is { } stmt)
            {
                eventStatements.Add(stmt);
            }
        }

        var hoistResult = eventStatements.Any(s => s.Hoisted);

        // Bind the hoisted local AFTER the invariant re-check above and BEFORE the first recorded event,
        // so an invalid post-state still throws before anything is computed or recorded. Annotated with
        // the EXPRESSION'S OWN inferred type rather than left to inference: a target-typed expression (a
        // generic factory call such as `listOf()`) infers a different type without a target, and this
        // local is both passed to a payload constructor and returned, so it must keep exactly the typing
        // the inline rendering had.
        //
        // NOT the declared return type: `command maybeStamp: Instant? { emit Stamped(at: now) … }` over a
        // NON-optional `Stamped.at` would then bind `val __result: Instant? = …` and fail the payload
        // constructor with "actual type is 'Instant?', but 'Instant' was expected". The bound value's own
        // type is the only annotation both readers accept — Kotlin nullability is subtyping, so a
        // non-optional `T` flows into a `T?` payload field AND out of a `T?` return unchanged. When the
        // type cannot be inferred there is nothing truthful to write, so the binding falls back to plain
        // inference rather than to a type the expression may not have.
        if (hoistResult)
        {
            var annotation = resultRenderedType is not null ? ": " + typeMapper.Map(resultRenderedType) : string.Empty;
            sb.Append(Indent).Append(Indent).Append("val ").Append(ResultHoist.LocalName).Append(annotation)
              .Append(" = ").Append(resultExpr).Append('\n');
        }

        // The domain events this behavior raises, then the integration events it publishes (R19) —
        // inside-out recording order, onto their separate collectors.
        foreach ((string text, _) in eventStatements)
        {
            sb.Append(text);
        }

        if (resultExpr is not null)
        {
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(hoistResult ? ResultHoist.LocalName : resultExpr).Append('\n');
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
        var expectedEnum = field is not null
            && emit.Index.Classify(field.Type.Qualifier ?? translator.Context, field.Type.Name) == TypeKind.Enum
                ? field.Type.Name
                : null;
        var value = translator.Translate(t.Value, KotlinExpressionTranslator.NameMode.Property, expectedEnum);
        sb.Append(indent).Append("this.").Append(KotlinNaming.ToMemberName(t.Field)).Append(" = ").Append(value).Append('\n');
    }

    /// <summary>
    /// Records a domain event: <c>&lt;receiver&gt;&lt;events&gt;.add(EventName(args…))</c> — null for an
    /// unknown event, so the caller skips it.
    /// <para>Returns the rendered statement paired with whether it substituted the hoisted result local,
    /// so the caller can decide to bind it (#1838).</para>
    /// </summary>
    private static (string Text, bool Hoisted)? BuildEmitStatement(
        KotlinEmitContext emit, EmitClause em, KotlinExpressionTranslator translator,
        string eventsField, string receiver, string indent, string? hoistedResultExpr = null)
    {
        // Passes the context for the same reason `publish` does (#1834): `ValidateEmit` resolves the
        // event name context-aware, so this must too or it builds the payload from another context's
        // same-named declaration. The two halves are one contract.
        (var expr, var hoisted) = BuildEventExpression(
            emit, em.EventName, em.Args, translator, translator.Context, hoistedResultExpr);

        return expr is null
            ? null
            : ($"{indent}{receiver}{eventsField}.add({expr})\n", hoisted);
    }

    /// <summary>
    /// Records a published integration event (R19):
    /// <c>this.&lt;integrationEvents&gt;.add(EventName(args…))</c> — the published-language counterpart
    /// of <see cref="BuildEmitStatement"/>, adding to a SEPARATE collector. No receiver parameter: the
    /// grammar admits <c>publish</c> in a behavior body only, so it is always <c>this.</c>.
    /// <para>Returns the rendered statement paired with whether it substituted the hoisted result local,
    /// so the caller can decide to bind it (#1838); null for an unknown event.</para>
    /// </summary>
    private static (string Text, bool Hoisted)? BuildPublishStatement(
        KotlinEmitContext emit, PublishClause pub, KotlinExpressionTranslator translator,
        string integrationEventsField, string indent, string? hoistedResultExpr = null)
    {
        // Resolved CONTEXT-AWARE (unlike `emit`, whose validator is itself flat): two contexts may each
        // legally publish a same-named integration event with DIFFERENT payloads (R14), and the flat
        // ModelIndex view is last-write-wins — see BuildEventExpression's `context` parameter (#1796 review).
        (var expr, var hoisted) = BuildEventExpression(
            emit, pub.EventName, pub.Args, translator, translator.Context, hoistedResultExpr);

        return expr is null
            ? null
            : ($"{indent}this.{integrationEventsField}.add({expr})\n", hoisted);
    }

    /// <summary>
    /// The name/payload-only core of <see cref="BuildEmitStatement"/>, shared verbatim with a
    /// <c>publish</c> clause (R19): both clauses carry the same <see cref="EmitArg"/> payload and both
    /// construct a data class, so the argument binding and enum-qualification rules stay identical
    /// rather than being re-derived per clause. Arguments bind by field name in the event data class's
    /// declaration order, with a bare enum member qualified; a missing field falls back to a benign type
    /// default so the emitted code still compiles.
    /// <para><paramref name="context"/> is the bounded context the NAME resolves within, and BOTH
    /// clauses pass it: <c>ValidatePublish</c> has always resolved context-aware, and <c>ValidateEmit</c>
    /// does since #1834, so the emitter must too or it builds the payload from another context's
    /// same-named declaration. Null falls back to the flat, last-write-wins lookup — no caller relies on
    /// that any more.</para>
    /// <para><paramref name="hoistedResultExpr"/> is the behavior's rendered <c>result</c> expression,
    /// when it has one (#1838). An argument whose WHOLE rendering equals it is replaced by
    /// <see cref="ResultHoist.LocalName"/> and <c>Hoisted</c> comes back true, so the caller knows to
    /// bind it. The rule is <see cref="ResultHoist.ShouldSubstitute"/>'s — exact, never a substring —
    /// because the comparison runs on rendered source: a <c>this.taxRate</c> sibling next to a
    /// <c>this.tax</c> result contains the result's rendering, and a substring splice would produce
    /// <c>__resultRate</c>, which does not compile.</para>
    /// <para>Note the two sides are not translated through identical calls: an argument passes its
    /// field's enum type as <c>expectedEnum</c> while the caller translates the result without one. In
    /// practice a bare enum member still qualifies on both sides (the command's declared return type
    /// gives the translator the same frame), but nothing forces that — where two renderings of one
    /// expression ever do diverge the argument simply fails to match and stays inline, which is the
    /// deliberate posture: a missed hoist is safe where a wrong one is not.</para>
    /// </summary>
    private static (string? Expr, bool Hoisted) BuildEventExpression(
        KotlinEmitContext emit, string eventName, IReadOnlyList<EmitArg> clauseArgs, KotlinExpressionTranslator translator,
        string? context = null, string? hoistedResultExpr = null)
    {
        if (!emit.Index.TryGetDecl(context, eventName, out TypeDecl decl))
        {
            return (null, false);
        }

        IReadOnlyList<Member> members = decl switch
        {
            EventDecl e => e.Members,
            IntegrationEventDecl ie => ie.Members,
            _ => Array.Empty<Member>(),
        };

        var argByField = clauseArgs.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);
        var hoist = new ResultHoist.HoistTracker(hoistedResultExpr);
        var args = members.Select(m =>
        {
            if (!argByField.TryGetValue(m.Name, out Expr? value))
            {
                return KotlinTypeDefault(m.Type);
            }

            // Widen a payload argument toward its event member's declared type (#1511) — an Int-inferred
            // argument against a Decimal-declared field would otherwise emit an uncoerced value that
            // kotlinc rejects (#1866).
            var expectedEnum = emit.Index.Classify(m.Type.Qualifier ?? translator.Context, m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
            var rendered = translator.TranslateReconciled(value, KotlinExpressionTranslator.NameMode.Property, expectedEnum, m.Type);

            // Substitute the hoisted local only when the WHOLE argument is the result expression; a
            // substring match (a sibling argument sharing a prefix) must NOT be rewritten.
            return hoist.Substitute(rendered, ResultHoist.LocalName);
        }).ToList(); // Materialise: the tracker only latches while the sequence is enumerated.

        return (KotlinNaming.ToTypeName(eventName) + "(" + string.Join(", ", args) + ")", hoist.Hoisted);
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
                // A factory has no `result` clause, so no hoist can apply — take the text only.
                if (BuildEmitStatement(emit, em, translator, eventsField, "instance.", body) is { } stmt)
                {
                    sb.Append(stmt.Text);
                }
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
                var expectedEnum = emit.Index.Classify(m.Type.Qualifier ?? translator.Context, m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
                args.Add(translator.TranslateReconciled(value, KotlinExpressionTranslator.NameMode.Property, expectedEnum, m.Type));
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
    /// True when any behavior of the entity <c>publish</c>es an integration event (R19). No factory
    /// counterpart: the grammar admits <c>publish</c> in command bodies only.
    /// </summary>
    private static bool PublishesEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<PublishClause>().Any();

    /// <summary>
    /// A collision-free name for the entity's recorded-events accessor (base <c>domainEvents</c>, underscore-suffixed
    /// until it clears every emitted member/behavior/factory name plus the fixed <c>id</c>) — so the accessor never
    /// collides with a user member literally named <c>domainEvents</c>. The private backing field prefixes it with
    /// <c>_</c>.
    /// </summary>
    private static string SyntheticEventsName(EntityDecl entity) =>
        FreeMemberName(ReservedMemberNames(entity), "domainEvents");

    /// <summary>
    /// The same, for the entity's published-integration-events accessor (R19), base
    /// <c>integrationEvents</c>. Seeded with the domain-event accessor's chosen name too, so the two
    /// synthetic members can never collide with each other.
    /// </summary>
    private static string SyntheticIntegrationEventsName(EntityDecl entity, string eventsAccessor)
    {
        var used = ReservedMemberNames(entity);
        used.Add(eventsAccessor);
        return FreeMemberName(used, "integrationEvents");
    }

    /// <summary>Every user-visible member/behavior/factory name a synthetic member must dodge.</summary>
    private static HashSet<string> ReservedMemberNames(EntityDecl entity)
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

        return used;
    }

    /// <summary><paramref name="preferred"/>, underscore-suffixed until it clears <paramref name="used"/>.</summary>
    private static string FreeMemberName(HashSet<string> used, string preferred)
    {
        var name = preferred;
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
