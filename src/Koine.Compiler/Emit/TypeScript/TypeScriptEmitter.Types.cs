using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The user-type slice of <see cref="TypeScriptEmitter"/>: value objects, entities (with their
/// branded ID type), and domain events. Mirrors the C# emitter's shape — immutable readonly
/// fields, a validating constructor whose invariants throw <c>DomainInvariantViolationError</c>,
/// derived (getter) members, structural <c>equals</c> for value objects, and identity <c>equals</c>
/// for entities — but renders idiomatic TypeScript.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    // ----------------------------------------------------------------------
    // Value objects
    // ----------------------------------------------------------------------

    private EmittedFile EmitValueObject(TsEmitContext emit, ValueObjectDecl vo, string ns, TypeScriptTypeMapper typeMapper)
    {
        var name = TypeScriptNaming.ToPascalCase(vo.Name);
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        var ctorMembers = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var translator = new TypeScriptExpressionTranslator(emit.Index, vo.Members, emit.EnumMemberToType, typeMapper, ContextOf(ns), regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        var sb = new StringBuilder();
        WriteDoc(sb, vo.Doc, "");
        sb.Append("export class ").Append(name).Append(" extends ValueObject {\n");

        // Readonly fields (the constructor parameters ARE the immutable fields).
        foreach (Member m in ctorMembers)
        {
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("readonly ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append(FieldBang).Append(": ")
              .Append(typeMapper.Map(m.Type)).Append(";\n");
        }
        sb.Append('\n');

        WriteConstructor(sb, name, ctorMembers, vo.Invariants, translator, typeMapper);

        // Derived members as getters.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("get ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append("(): ")
              .Append(typeMapper.Map(m.Type)).Append(" {\n");
            if (RefOnly)
            {
                sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            }
            else
            {
                sb.Append(Indent).Append(Indent).Append("return ")
                  .Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append(";\n");
            }

            sb.Append(Indent).Append("}\n");
        }

        // A quantity gets unit-checked add/subtract + scalar multiply; a plain value object gets a
        // scalar `multiply` and/or additive `add` ONLY where the model actually uses them (R9),
        // mirroring the C# emitter's demand-driven operator generation.
        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, name, ctorMembers, emit.Index);
        }
        else
        {
            if (emit.ScalarNeeds.ContainsKey(vo.Name) && ctorMembers.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarOp(sb, name, ctorMembers);
            }
            if (emit.AdditiveNeeds.Contains(vo.Name))
            {
                WriteAdditiveOp(sb, name, ctorMembers);
            }
        }

        WriteEqualityComponents(sb, ctorMembers);
        sb.Append("}\n");

        return new EmittedFile(PathFor(ns, KindFolder.ValueObjects, name), Assemble(emit, ns, KindFolder.ValueObjects, sb.ToString(), name, vo.Span));
    }

    private void WriteConstructor(
        StringBuilder sb, string typeName, IReadOnlyList<Member> ctorMembers,
        IReadOnlyList<Invariant> invariants, TypeScriptExpressionTranslator translator, TypeScriptTypeMapper typeMapper)
    {
        var ordered = OrderCtorParams(ctorMembers).ToList();
        sb.Append(Indent).Append("constructor(");
        sb.Append(string.Join(", ", ordered.Select(m => FormatParam(m, typeMapper, translator))));
        sb.Append(") {\n");
        sb.Append(Indent).Append(Indent).Append("super();\n");

        if (RefOnly)
        {
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            sb.Append(Indent).Append("}\n");
            return;
        }

        // A value object's invariants run in the constructor, where members are still the bare
        // parameters (not yet `this.` fields) — Parameter mode.
        WriteInvariantGuards(sb, typeName, invariants, translator, TypeScriptExpressionTranslator.NameMode.Parameter);
        foreach (Member m in ctorMembers)
        {
            WriteAssignment(sb, m);
        }

        sb.Append(Indent).Append("}\n");
    }

    private void WriteInvariantGuards(StringBuilder sb, string typeName, IReadOnlyList<Invariant> invariants,
        TypeScriptExpressionTranslator translator, TypeScriptExpressionTranslator.NameMode mode)
    {
        foreach (Invariant inv in invariants)
        {
            WriteGuard(sb, typeName, inv.Condition, inv.Message ?? SynthesizeMessage(), translator, mode);
        }
    }

    /// <summary>Emits a throwing guard: <c>if (!(cond)) throw new DomainInvariantViolationError(...)</c>.</summary>
    private void WriteGuard(StringBuilder sb, string typeName, Expr condition, string rule,
        TypeScriptExpressionTranslator translator, TypeScriptExpressionTranslator.NameMode mode)
    {
        string test;
        if (condition is GuardExpr guard)
        {
            test = translator.Translate(guard.Condition, mode) + " && !(" + translator.Translate(guard.Body, mode) + ")";
        }
        else if (condition is MatchExpr)
        {
            test = "!(" + translator.Translate(condition, mode) + ")";
        }
        else
        {
            test = translator.TranslateNegated(condition, mode);
        }

        sb.Append(Indent).Append(Indent).Append("if (").Append(test).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("throw new DomainInvariantViolationError('").Append(typeName).Append("', ")
          .Append(RuleLiteral(rule)).Append(");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
    }

    private void WriteAssignment(StringBuilder sb, Member m)
    {
        var field = TypeScriptNaming.ToCamelCase(m.Name);
        sb.Append(Indent).Append(Indent).Append("this.").Append(field).Append(" = ").Append(field).Append(";\n");
    }

    private string FormatParam(Member m, TypeScriptTypeMapper typeMapper, TypeScriptExpressionTranslator translator)
    {
        var param = TypeScriptNaming.ToCamelCase(m.Name);
        var type = typeMapper.Map(m.Type);

        // A defaulted member keeps its default; an enum default is a member-object value.
        if (m.Initializer is not null)
        {
            return $"{param}: {type} = {translator.Translate(m.Initializer, m.Type.Name)}";
        }
        if (m.Type.IsOptional)
        {
            return $"{param}: {type} = undefined";
        }
        return $"{param}: {type}";
    }

    private void WriteEqualityComponents(StringBuilder sb, IReadOnlyList<Member> members)
    {
        if (RefOnly)
        {
            WriteRefStubMethod(sb, "protected equalityComponents(): readonly unknown[]");
            return;
        }

        sb.Append('\n');
        sb.Append(Indent).Append("protected equalityComponents(): readonly unknown[] {\n");
        sb.Append(Indent).Append(Indent).Append("return [");
        sb.Append(string.Join(", ", members.Select(m => "this." + TypeScriptNaming.ToCamelCase(m.Name))));
        sb.Append("];\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// A value object's scalar <c>multiply(factor: number)</c> (e.g. <c>Money * quantity</c>): scales
    /// every numeric field by the factor (Decimal via the runtime op, a plain Int by JS <c>*</c>) and
    /// carries the rest unchanged. Both <c>Int</c> and <c>Decimal</c> scalars are a TS <c>number</c>.
    /// </summary>
    private void WriteScalarOp(StringBuilder sb, string name, IReadOnlyList<Member> ctorMembers)
    {
        if (RefOnly)
        {
            WriteRefStubMethod(sb, $"multiply(factor: number): {name}");
            return;
        }

        var numeric = new HashSet<string>(ctorMembers.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name), StringComparer.Ordinal);
        var ordered = OrderCtorParams(ctorMembers).ToList();

        string Arg(Member m)
        {
            var field = "this." + TypeScriptNaming.ToCamelCase(m.Name);
            if (!numeric.Contains(m.Name))
            {
                return field;
            }
            // A Decimal scales by the (possibly fractional) factor exactly, via a Decimal factor; an
            // Int field scales by `*`, rounded to stay an integer.
            return m.Type.Name == "Decimal"
                ? $"{field}.multiply(new Decimal(factor.toString()))"
                : $"Math.round({field} * factor)";
        }

        sb.Append('\n');
        sb.Append(Indent).Append("multiply(factor: number): ").Append(name).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append("return new ").Append(name).Append('(')
          .Append(string.Join(", ", ordered.Select(Arg))).Append(");\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>A value object's additive <c>add</c> method (for <c>sum</c> folds): adds numeric fields, carries the rest.</summary>
    private void WriteAdditiveOp(StringBuilder sb, string name, IReadOnlyList<Member> ctorMembers)
    {
        if (RefOnly)
        {
            WriteRefStubMethod(sb, $"add(other: {name}): {name}");
            return;
        }

        var numeric = new HashSet<string>(ctorMembers.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name), StringComparer.Ordinal);
        var ordered = OrderCtorParams(ctorMembers).ToList();

        string Arg(Member m)
        {
            var field = "this." + TypeScriptNaming.ToCamelCase(m.Name);
            var rightField = "other." + TypeScriptNaming.ToCamelCase(m.Name);
            if (!numeric.Contains(m.Name))
            {
                return field;
            }
            return m.Type.Name == "Decimal" ? $"{field}.add({rightField})" : $"{field} + {rightField}";
        }

        sb.Append('\n');
        sb.Append(Indent).Append("add(other: ").Append(name).Append("): ").Append(name).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append("return new ").Append(name).Append('(')
          .Append(string.Join(", ", ordered.Select(Arg))).Append(");\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>A quantity's unit-checked <c>add</c>/<c>subtract</c> and scalar <c>multiply</c>.</summary>
    private void WriteQuantityOps(StringBuilder sb, string name, IReadOnlyList<Member> ctorMembers, ModelIndex index)
    {
        Member? amount = ctorMembers.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = ctorMembers.FirstOrDefault(m => index.Classify(m.Type.Name) == TypeKind.Enum && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return;
        }

        if (RefOnly)
        {
            WriteRefStubMethod(sb, $"add(other: {name}): {name}");
            WriteRefStubMethod(sb, $"subtract(other: {name}): {name}");
            WriteRefStubMethod(sb, $"multiply(factor: number): {name}");
            return;
        }

        var amt = TypeScriptNaming.ToCamelCase(amount.Name);
        var u = TypeScriptNaming.ToCamelCase(unit.Name);
        var ordered = OrderCtorParams(ctorMembers).ToList();

        string Construct(string amtExpr, string unitExpr) =>
            $"new {name}(" + string.Join(", ", ordered.Select(m =>
                ReferenceEquals(m, amount) ? amtExpr : ReferenceEquals(m, unit) ? unitExpr : "undefined as never")) + ")";

        foreach (var (method, verb, op) in new[] { ("add", "add", "add"), ("subtract", "subtract", "subtract") })
        {
            sb.Append('\n');
            sb.Append(Indent).Append(method).Append("(other: ").Append(name).Append("): ").Append(name).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append("if (this.").Append(u).Append(" !== other.").Append(u).Append(") {\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationError('").Append(name)
              .Append("', 'cannot ").Append(verb).Append(" quantities of different units');\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct($"this.{amt}.{op}(other.{amt})", $"this.{u}")).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        sb.Append('\n');
        sb.Append(Indent).Append("multiply(factor: number): ").Append(name).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append("return ")
          .Append(Construct($"this.{amt}.multiply(new Decimal(factor.toString()))", $"this.{u}")).Append(";\n");
        sb.Append(Indent).Append("}\n");
    }

    // ----------------------------------------------------------------------
    // Entities (+ branded ID)
    // ----------------------------------------------------------------------

    private EmittedFile EmitEntity(TsEmitContext emit, EntityDecl entity, string ns, bool isRoot, TypeScriptTypeMapper typeMapper)
    {
        var name = TypeScriptNaming.ToPascalCase(entity.Name);
        var idName = TypeScriptNaming.ToPascalCase(entity.IdentityName);
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var scopeMembers = entity.Members.Append(new Member("id", new TypeRef(entity.IdentityName), null)).ToList();
        var translator = new TypeScriptExpressionTranslator(emit.Index, scopeMembers, emit.EnumMemberToType, typeMapper, ContextOf(ns), regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        var ctorMembers = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var mutated = MutatedFields(entity);

        var sb = new StringBuilder();
        WriteDoc(sb, entity.Doc, "");
        sb.Append("export class ").Append(name).Append(" {\n");

        // Identity, then member fields. A mutated field is not `readonly`.
        sb.Append(Indent).Append("readonly id").Append(FieldBang).Append(": ").Append(idName).Append(";\n");
        foreach (Member m in ctorMembers)
        {
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append(mutated.Contains(m.Name) ? "" : "readonly ")
              .Append(TypeScriptNaming.ToCamelCase(m.Name)).Append(FieldBang).Append(": ").Append(typeMapper.Map(m.Type)).Append(";\n");
        }
        sb.Append('\n');

        // Constructor: id first, then ordered members. Private when a factory funnels creation.
        var ordered = OrderCtorParams(ctorMembers).ToList();
        var access = entity.Factories.Count > 0 ? "private " : "";
        sb.Append(Indent).Append(access).Append("constructor(id: ").Append(idName);
        foreach (Member m in ordered)
        {
            sb.Append(", ").Append(FormatParam(m, typeMapper, translator));
        }
        sb.Append(") {\n");
        if (RefOnly)
        {
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            sb.Append(Indent).Append("}\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append("this.id = id;\n");
            foreach (Member m in ctorMembers)
            {
                WriteAssignment(sb, m);
            }
            if (entity.Invariants.Count > 0)
            {
                sb.Append(Indent).Append(Indent).Append("this.checkInvariants();\n");
            }
            sb.Append(Indent).Append("}\n");
        }

        // Shared invariant check.
        if (entity.Invariants.Count > 0)
        {
            if (RefOnly)
            {
                WriteRefStubMethod(sb, "private checkInvariants(): void");
            }
            else
            {
                sb.Append('\n');
                sb.Append(Indent).Append("private checkInvariants(): void {\n");
                WriteInvariantGuards(sb, name, entity.Invariants, translator, TypeScriptExpressionTranslator.NameMode.Property);
                sb.Append(Indent).Append("}\n");
            }
        }

        // Derived members.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("get ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append("(): ")
              .Append(typeMapper.Map(m.Type)).Append(" {\n");
            if (RefOnly)
            {
                sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            }
            else
            {
                sb.Append(Indent).Append(Indent).Append("return ").Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append(";\n");
            }

            sb.Append(Indent).Append("}\n");
        }

        // Domain-event recording (when any command or factory emits events). The collection
        // is exposed read-only via the `domainEvents` getter; `clearDomainEvents()` drains it
        // after dispatch — the idiomatic-TS analogue of the C# aggregate's `DomainEvents`.
        if (EmitsEvents(entity))
        {
            sb.Append('\n');
            sb.Append(Indent).Append("private readonly _domainEvents: DomainEvent[] = [];\n");
            if (RefOnly)
            {
                WriteRefStubMethod(sb, "get domainEvents(): readonly DomainEvent[]");
                WriteRefStubMethod(sb, "clearDomainEvents(): void");
            }
            else
            {
                sb.Append(Indent).Append("get domainEvents(): readonly DomainEvent[] {\n");
                sb.Append(Indent).Append(Indent).Append("return this._domainEvents;\n");
                sb.Append(Indent).Append("}\n");
                sb.Append(Indent).Append("clearDomainEvents(): void {\n");
                sb.Append(Indent).Append(Indent).Append("this._domainEvents.length = 0;\n");
                sb.Append(Indent).Append("}\n");
            }
        }

        // Commands.
        foreach (CommandDecl cmd in entity.Commands)
        {
            WriteCommand(sb, entity, cmd, translator, typeMapper, emit.Index);
        }

        // Factories.
        foreach (FactoryDecl factory in entity.Factories)
        {
            WriteFactory(sb, entity, name, idName, factory, ctorMembers, translator, typeMapper, emit.Index);
        }

        // Identity equality.
        if (RefOnly)
        {
            WriteRefStubMethod(sb, $"equals(other: {name} | undefined): boolean");
        }
        else
        {
            sb.Append('\n');
            sb.Append(Indent).Append("equals(other: ").Append(name).Append(" | undefined): boolean {\n");
            sb.Append(Indent).Append(Indent).Append("return other !== undefined && this.id.equals(other.id);\n");
            sb.Append(Indent).Append("}\n");
        }

        sb.Append("}\n");

        return new EmittedFile(PathFor(ns, isRoot ? KindFolder.Root : KindFolder.Entities, name),
            Assemble(emit, ns, isRoot ? KindFolder.Root : KindFolder.Entities, sb.ToString(), name, entity.Span));
    }

    private void WriteCommand(StringBuilder sb, EntityDecl entity, CommandDecl cmd, TypeScriptExpressionTranslator translator, TypeScriptTypeMapper typeMapper, ModelIndex index)
    {
        var name = TypeScriptNaming.ToCamelCase(cmd.Name);
        var entityName = TypeScriptNaming.ToPascalCase(entity.Name);
        var paramList = string.Join(", ", cmd.Parameters.Select(p =>
            $"{TypeScriptNaming.ToCamelCase(p.Name)}: {typeMapper.Map(p.Type)}"));
        var returnType = cmd.ReturnType is { } rt ? typeMapper.Map(rt) : "void";

        sb.Append('\n');
        WriteDoc(sb, cmd.Doc, Indent);
        sb.Append(Indent).Append(name).Append('(').Append(paramList).Append("): ").Append(returnType).Append(" {\n");

        if (RefOnly)
        {
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            sb.Append(Indent).Append("}\n");
            return;
        }

        foreach (Param p in cmd.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var requires = cmd.Body.OfType<RequiresClause>().ToList();
        var transitions = cmd.Body.OfType<Transition>().ToList();
        var emits = cmd.Body.OfType<EmitClause>().ToList();
        ResultClause? result = cmd.Body.OfType<ResultClause>().FirstOrDefault();

        foreach (RequiresClause req in requires)
        {
            WriteGuard(sb, entityName, req.Condition, req.Message ?? SynthesizeMessage(), translator, TypeScriptExpressionTranslator.NameMode.Property);
        }

        foreach (Transition tr in transitions)
        {
            var expectedEnum = entity.Members.FirstOrDefault(m => m.Name == tr.Field) is { } fm && index.Classify(fm.Type.Name) == TypeKind.Enum
                ? fm.Type.Name : null;
            sb.Append(Indent).Append(Indent).Append("this.").Append(TypeScriptNaming.ToCamelCase(tr.Field))
              .Append(" = ").Append(translator.Translate(tr.Value, expectedEnum)).Append(";\n");
        }

        // Translate the result FIRST, in the same scope as the emit payloads, so the emit builder
        // can substitute it. If the same value also appears as a WHOLE emit argument it is hoisted
        // into a single `const __result` computed once — mirroring the C# emitter. The match is
        // per-argument and exact (not a substring of the rendered statement), so a sibling argument
        // that merely shares a prefix — e.g. `this.taxRate` vs a `this.tax` result — is left intact.
        string? resultExpr = result is not null ? translator.Translate(result.Value, cmd.ReturnType?.Name) : null;

        // Domain events are recorded while parameters are still in scope (their payloads may
        // reference parameters), but rendered AFTER the post-mutation invariant re-check so an
        // invalid state throws before any event is recorded — mirroring the C# emitter's order.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index, "this.", resultExpr)).ToList();
        bool hoistResult = emitStatements.Any(s => s.Hoisted);

        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        if (transitions.Count > 0 && entity.Invariants.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("this.checkInvariants();\n");
        }

        // Compute the hoisted result (once) BEFORE the events so an emit payload can carry the
        // same value without recomputing it.
        if (hoistResult)
        {
            sb.Append(Indent).Append(Indent).Append("const __result = ").Append(resultExpr).Append(";\n");
        }

        foreach (var stmt in emitStatements)
        {
            sb.Append(Indent).Append(Indent).Append(stmt.Text).Append('\n');
        }

        if (resultExpr is not null)
        {
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(hoistResult ? "__result" : resultExpr).Append(";\n");
        }

        sb.Append(Indent).Append("}\n");
    }

    private void WriteFactory(StringBuilder sb, EntityDecl entity, string name, string idName, FactoryDecl factory,
        IReadOnlyList<Member> ctorMembers, TypeScriptExpressionTranslator translator, TypeScriptTypeMapper typeMapper, ModelIndex index)
    {
        var methodName = TypeScriptNaming.ToCamelCase(factory.Name);
        var paramList = string.Join(", ", factory.Parameters.Select(p =>
            $"{TypeScriptNaming.ToCamelCase(p.Name)}: {typeMapper.Map(p.Type)}"));

        sb.Append('\n');
        WriteDoc(sb, factory.Doc, Indent);
        sb.Append(Indent).Append("static ").Append(methodName).Append('(').Append(paramList).Append("): ").Append(name).Append(" {\n");

        if (RefOnly)
        {
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            sb.Append(Indent).Append("}\n");
            return;
        }

        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        // Identity. By default generate client-side (`<Id>New()`). When the factory supplies it as an
        // explicit identity-typed parameter (#324), bind `id` to that parameter instead of generating:
        // omit when the parameter is already named `id`; otherwise alias it (`const id = bookId;`).
        FactoryIdBinding idBinding = FactoryIdBinding.ResolveFactoryId(entity, factory, TypeScriptNaming.ToCamelCase);
        switch (idBinding.Source)
        {
            case FactoryIdSource.Generate:
                sb.Append(Indent).Append(Indent).Append("const id = ").Append(idName).Append("New();\n");
                break;
            case FactoryIdSource.Alias:
                sb.Append(Indent).Append(Indent).Append("const id = ").Append(idBinding.AliasFrom).Append(";\n");
                break;
            case FactoryIdSource.ParamProvidesIdDirectly:
                // The `id` parameter already provides the local — emit nothing.
                break;
        }

        foreach (RequiresClause req in factory.Body.OfType<RequiresClause>())
        {
            // Inside a static factory the guard refers to parameters/`id` (no `this`); reuse the
            // guard renderer but it will reference `this.*` only for members, which a factory's
            // requires must not do — Koine validates that, so parameters/id render verbatim.
            WriteGuard(sb, name, req.Condition, req.Message ?? SynthesizeMessage(), translator, TypeScriptExpressionTranslator.NameMode.Property);
        }

        // Build the all-args constructor call: an explicit `field <- value` init wins; otherwise a
        // same-named factory parameter auto-binds (R8.2), then a member's own default, then
        // undefined for an optional field, and finally `undefined as never` for a required field
        // with no source (already flagged upstream).
        var inits = factory.Body.OfType<Initialization>().ToDictionary(i => i.Field, i => i.Value);
        var factoryParams = new HashSet<string>(factory.Parameters.Select(p => p.Name), StringComparer.Ordinal);
        var ordered = OrderCtorParams(ctorMembers).ToList();
        var args = new List<string> { "id" };
        foreach (Member m in ordered)
        {
            if (inits.TryGetValue(m.Name, out Expr? value))
            {
                args.Add(translator.Translate(value, EnumExpected(m, index)));
            }
            else if (factoryParams.Contains(m.Name))
            {
                args.Add(TypeScriptNaming.ToCamelCase(m.Name));
            }
            else if (m.Initializer is not null)
            {
                args.Add(translator.Translate(m.Initializer, m.Type.Name));
            }
            else if (m.Type.IsOptional)
            {
                args.Add("undefined");
            }
            else
            {
                args.Add("undefined as never");
            }
        }

        // Creation events (payloads may reference `id` and parameters, so build them before
        // those locals leave scope) record onto the freshly-constructed instance.
        var emits = factory.Body.OfType<EmitClause>().ToList();
        // Factories have no `result` clause, so there is nothing to hoist — take the text only.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index, "instance.").Text).ToList();

        translator.PopLocal("id");
        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        if (emitStatements.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("const instance = new ").Append(name).Append('(').Append(string.Join(", ", args)).Append(");\n");
            foreach (var stmt in emitStatements)
            {
                sb.Append(Indent).Append(Indent).Append(stmt).Append('\n');
            }
            sb.Append(Indent).Append(Indent).Append("return instance;\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append("return new ").Append(name).Append('(').Append(string.Join(", ", args)).Append(");\n");
        }
        sb.Append(Indent).Append("}\n");
    }

    // ----------------------------------------------------------------------
    // Branded ID types
    // ----------------------------------------------------------------------

    private EmittedFile EmitIdType(TsEmitContext emit, string idRaw, string ns, IdentityStrategy strategy, string? backing)
    {
        var idName = TypeScriptNaming.ToPascalCase(idRaw);
        var backingType = strategy switch
        {
            IdentityStrategy.Sequence => "number",
            IdentityStrategy.Natural => backing == "Int" ? "number" : "string",
            _ => "string"
        };
        var validates = strategy == IdentityStrategy.Natural && backingType == "string";

        var sb = new StringBuilder();
        WriteDoc(sb, "A strongly-typed, branded identity value object.", "");

        // The branded primitive: cannot be confused with a plain primitive.
        sb.Append("export class ").Append(idName).Append(" extends ValueObject {\n");
        sb.Append(Indent).Append("readonly value").Append(FieldBang).Append(": ").Append(backingType).Append(";\n\n");

        if (RefOnly)
        {
            sb.Append(Indent).Append("constructor(value: ").Append(backingType).Append(") {\n");
            sb.Append(Indent).Append(Indent).Append("super();\n");
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            sb.Append(Indent).Append("}\n\n");
            sb.Append(Indent).Append("protected equalityComponents(): readonly unknown[] {\n");
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
            sb.Append(Indent).Append("}\n");
            sb.Append("}\n\n");

            if (strategy == IdentityStrategy.Guid)
            {
                sb.Append("/** Generates a fresh ").Append(idName).Append(" (a random UUID). */\n");
                sb.Append("export function ").Append(idName).Append("New(): ").Append(idName).Append(" {\n");
                sb.Append(Indent).Append(RefStubStatement).Append('\n');
                sb.Append("}\n");
            }

            return new EmittedFile(PathFor(ns, KindFolder.ValueObjects, idName), Assemble(emit, ns, KindFolder.ValueObjects, sb.ToString()));
        }

        sb.Append(Indent).Append("constructor(value: ").Append(backingType).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append("super();\n");
        if (validates)
        {
            sb.Append(Indent).Append(Indent).Append("if (value.trim().length === 0) {\n");
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("throw new DomainInvariantViolationError('").Append(idName).Append("', 'identity value cannot be blank');\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
        }
        sb.Append(Indent).Append(Indent).Append("this.value = value;\n");
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("protected equalityComponents(): readonly unknown[] {\n");
        sb.Append(Indent).Append(Indent).Append("return [this.value];\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n\n");

        // A Guid identity is generated client-side; sequence/natural keys are supplied externally.
        if (strategy == IdentityStrategy.Guid)
        {
            sb.Append("/** Generates a fresh ").Append(idName).Append(" (a random UUID). */\n");
            sb.Append("export function ").Append(idName).Append("New(): ").Append(idName).Append(" {\n");
            sb.Append(Indent).Append("return new ").Append(idName).Append("(crypto.randomUUID());\n");
            sb.Append("}\n");
        }

        return new EmittedFile(PathFor(ns, KindFolder.ValueObjects, idName), Assemble(emit, ns, KindFolder.ValueObjects, sb.ToString()));
    }

    // ----------------------------------------------------------------------
    // Domain events (immutable readonly records with an occurredOn timestamp)
    // ----------------------------------------------------------------------

    private EmittedFile EmitEvent(TsEmitContext emit, EventDecl ev, string ns, TypeScriptTypeMapper typeMapper)
    {
        var name = TypeScriptNaming.ToPascalCase(ev.Name);
        var memberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var ctorMembers = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();
        WriteDoc(sb, ev.Doc, "");
        sb.Append("export class ").Append(name).Append(" {\n");

        foreach (Member m in ctorMembers)
        {
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("readonly ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append(FieldBang).Append(": ")
              .Append(typeMapper.Map(m.Type)).Append(";\n");
        }
        sb.Append(Indent).Append("readonly occurredOn").Append(FieldBang).Append(": Instant;\n\n");

        var ordered = OrderCtorParams(ctorMembers).ToList();
        sb.Append(Indent).Append("constructor(");
        sb.Append(string.Join(", ", ordered.Select(m => $"{TypeScriptNaming.ToCamelCase(m.Name)}: {typeMapper.Map(m.Type)}")));
        sb.Append(ordered.Count > 0 ? ", " : "").Append("occurredOn: Instant = Instant.now()) {\n");
        if (RefOnly)
        {
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
        }
        else
        {
            foreach (Member m in ctorMembers)
            {
                WriteAssignment(sb, m);
            }
            sb.Append(Indent).Append(Indent).Append("this.occurredOn = occurredOn;\n");
        }

        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(PathFor(ns, KindFolder.Events, name), Assemble(emit, ns, KindFolder.Events, sb.ToString(), name, ev.Span));
    }

    // ----------------------------------------------------------------------
    // Shared helpers
    // ----------------------------------------------------------------------

    private static IEnumerable<Member> OrderCtorParams(IEnumerable<Member> members) =>
        members.OrderBy(m => m.Initializer is not null || m.Type.IsOptional ? 1 : 0);

    private static ISet<string> MutatedFields(EntityDecl entity) =>
        new HashSet<string>(
            entity.Commands.SelectMany(c => c.Body).OfType<Transition>().Select(t => t.Field),
            StringComparer.Ordinal);

    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;

    /// <summary>True when any command or factory of the entity records a domain event.</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>
    /// Builds the <c>&lt;prefix&gt;_domainEvents.push(new EventName(...));</c> statement for an
    /// <c>emit</c> clause. Positional arguments follow the event's emitted constructor order
    /// (<see cref="OrderCtorParams"/> moves defaulted/optional fields last); <c>occurredOn</c>
    /// is supplied by the event constructor's own default. When <paramref name="hoistedResultExpr"/>
    /// is supplied, any argument whose WHOLE rendered form equals it is replaced with the
    /// <c>__result</c> local and <c>Hoisted</c> is returned true, so the caller knows to emit the
    /// <c>const __result = …;</c> binding. The TS analogue of the C# emitter's <c>BuildEmitStatement</c>.
    /// </summary>
    private (string Text, bool Hoisted) BuildEmitStatement(
        EmitClause emit, TypeScriptExpressionTranslator translator, ModelIndex index,
        string targetPrefix, string? hoistedResultExpr = null)
    {
        if (!index.TryGetDecl(emit.EventName, out TypeDecl decl) || decl is not EventDecl ev)
        {
            return ($"/* unknown event '{emit.EventName}' */", false);
        }

        var eventMemberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var ctorFields = OrderCtorParams(ev.Members.Where(m => !MemberAnalysis.IsDerived(m, eventMemberNames))).ToList();
        var argByField = emit.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);

        bool hoisted = false;
        var args = ctorFields.Select(f =>
        {
            if (!argByField.TryGetValue(f.Name, out Expr? value))
            {
                return "undefined as never"; // validator guarantees presence; defensive
            }

            var rendered = translator.Translate(value, EnumExpected(f, index));
            // Substitute the hoisted local only when the WHOLE argument is the result expression; a
            // substring match (a sibling argument sharing a prefix) must NOT be rewritten.
            if (hoistedResultExpr is not null && string.Equals(rendered, hoistedResultExpr, StringComparison.Ordinal))
            {
                hoisted = true;
                return "__result";
            }
            return rendered;
        }).ToList();

        var eventName = TypeScriptNaming.ToPascalCase(ev.Name);
        return ($"{targetPrefix}_domainEvents.push(new {eventName}({string.Join(", ", args)}));", hoisted);
    }

    /// <summary>A readable fallback rule message synthesized from a condition (mirrors the C# emitter's intent).</summary>
    private static string SynthesizeMessage() => "invariant failed";
}
