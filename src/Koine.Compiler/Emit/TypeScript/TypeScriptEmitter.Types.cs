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
        var translator = new TypeScriptExpressionTranslator(emit.Index, vo.Members, emit.EnumMemberToType, typeMapper, ContextOf(ns));

        var sb = new StringBuilder();
        WriteDoc(sb, vo.Doc, "");
        sb.Append("export class ").Append(name).Append(" extends ValueObject {\n");

        // Readonly fields (the constructor parameters ARE the immutable fields).
        foreach (Member m in ctorMembers)
        {
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("readonly ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append(": ")
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
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        // A quantity gets unit-checked add/subtract + scalar multiply; a plain value object gets a
        // scalar `multiply` and/or additive `add` ONLY where the model actually uses them (R9),
        // mirroring the C# emitter's demand-driven operator generation.
        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, vo, name, ctorMembers, emit.Index, typeMapper);
        }
        else
        {
            if (emit.ScalarNeeds.ContainsKey(vo.Name) && ctorMembers.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarOp(sb, vo, name, ctorMembers);
            }
            if (emit.AdditiveNeeds.Contains(vo.Name))
            {
                WriteAdditiveOp(sb, vo, name, ctorMembers, typeMapper);
            }
        }

        WriteEqualityComponents(sb, ctorMembers);
        sb.Append("}\n");

        return new EmittedFile(PathFor(ns, KindFolder.ValueObjects, name), Assemble(emit, ns, KindFolder.ValueObjects, sb.ToString()));
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
            WriteGuard(sb, typeName, inv.Condition, inv.Message ?? SynthesizeMessage(inv.Condition), translator, mode);
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
    private void WriteScalarOp(StringBuilder sb, ValueObjectDecl vo, string name, IReadOnlyList<Member> ctorMembers)
    {
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
    private void WriteAdditiveOp(StringBuilder sb, ValueObjectDecl vo, string name, IReadOnlyList<Member> ctorMembers, TypeScriptTypeMapper typeMapper)
    {
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
    private void WriteQuantityOps(StringBuilder sb, ValueObjectDecl vo, string name, IReadOnlyList<Member> ctorMembers, ModelIndex index, TypeScriptTypeMapper typeMapper)
    {
        Member? amount = ctorMembers.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = ctorMembers.FirstOrDefault(m => index.Classify(m.Type.Name) == TypeKind.Enum && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
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
        var translator = new TypeScriptExpressionTranslator(emit.Index, scopeMembers, emit.EnumMemberToType, typeMapper, ContextOf(ns));

        var ctorMembers = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var mutated = MutatedFields(entity);

        var sb = new StringBuilder();
        WriteDoc(sb, entity.Doc, "");
        sb.Append("export class ").Append(name).Append(" {\n");

        // Identity, then member fields. A mutated field is not `readonly`.
        sb.Append(Indent).Append("readonly id: ").Append(idName).Append(";\n");
        foreach (Member m in ctorMembers)
        {
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append(mutated.Contains(m.Name) ? "" : "readonly ")
              .Append(TypeScriptNaming.ToCamelCase(m.Name)).Append(": ").Append(typeMapper.Map(m.Type)).Append(";\n");
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

        // Shared invariant check.
        if (entity.Invariants.Count > 0)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("private checkInvariants(): void {\n");
            WriteInvariantGuards(sb, name, entity.Invariants, translator, TypeScriptExpressionTranslator.NameMode.Property);
            sb.Append(Indent).Append("}\n");
        }

        // Derived members.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("get ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append("(): ")
              .Append(typeMapper.Map(m.Type)).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append("return ").Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append(";\n");
            sb.Append(Indent).Append("}\n");
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
        sb.Append('\n');
        sb.Append(Indent).Append("equals(other: ").Append(name).Append(" | undefined): boolean {\n");
        sb.Append(Indent).Append(Indent).Append("return other !== undefined && this.id.equals(other.id);\n");
        sb.Append(Indent).Append("}\n");

        sb.Append("}\n");

        return new EmittedFile(PathFor(ns, isRoot ? KindFolder.Root : KindFolder.Entities, name),
            Assemble(emit, ns, isRoot ? KindFolder.Root : KindFolder.Entities, sb.ToString()));
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

        foreach (Param p in cmd.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var requires = cmd.Body.OfType<RequiresClause>().ToList();
        var transitions = cmd.Body.OfType<Transition>().ToList();
        ResultClause? result = cmd.Body.OfType<ResultClause>().FirstOrDefault();

        foreach (RequiresClause req in requires)
        {
            WriteGuard(sb, entityName, req.Condition, req.Message ?? SynthesizeMessage(req.Condition), translator, TypeScriptExpressionTranslator.NameMode.Property);
        }

        foreach (Transition tr in transitions)
        {
            var expectedEnum = entity.Members.FirstOrDefault(m => m.Name == tr.Field) is { } fm && index.Classify(fm.Type.Name) == TypeKind.Enum
                ? fm.Type.Name : null;
            sb.Append(Indent).Append(Indent).Append("this.").Append(TypeScriptNaming.ToCamelCase(tr.Field))
              .Append(" = ").Append(translator.Translate(tr.Value, expectedEnum)).Append(";\n");
        }

        string? resultExpr = result is not null ? translator.Translate(result.Value, cmd.ReturnType?.Name) : null;

        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        if (transitions.Count > 0 && entity.Invariants.Count > 0)
        {
            sb.Append(Indent).Append(Indent).Append("this.checkInvariants();\n");
        }

        if (resultExpr is not null)
        {
            sb.Append(Indent).Append(Indent).Append("return ").Append(resultExpr).Append(";\n");
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

        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        sb.Append(Indent).Append(Indent).Append("const id = ").Append(idName).Append("New();\n");

        foreach (RequiresClause req in factory.Body.OfType<RequiresClause>())
        {
            // Inside a static factory the guard refers to parameters/`id` (no `this`); reuse the
            // guard renderer but it will reference `this.*` only for members, which a factory's
            // requires must not do — Koine validates that, so parameters/id render verbatim.
            WriteGuard(sb, name, req.Condition, req.Message ?? SynthesizeMessage(req.Condition), translator, TypeScriptExpressionTranslator.NameMode.Property);
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

        translator.PopLocal("id");
        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        sb.Append(Indent).Append(Indent).Append("return new ").Append(name).Append('(').Append(string.Join(", ", args)).Append(");\n");
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
        sb.Append(Indent).Append("readonly value: ").Append(backingType).Append(";\n\n");

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
            sb.Append(Indent).Append("readonly ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append(": ")
              .Append(typeMapper.Map(m.Type)).Append(";\n");
        }
        sb.Append(Indent).Append("readonly occurredOn: Instant;\n\n");

        var ordered = OrderCtorParams(ctorMembers).ToList();
        sb.Append(Indent).Append("constructor(");
        sb.Append(string.Join(", ", ordered.Select(m => $"{TypeScriptNaming.ToCamelCase(m.Name)}: {typeMapper.Map(m.Type)}")));
        sb.Append(ordered.Count > 0 ? ", " : "").Append("occurredOn: Instant = Instant.now()) {\n");
        foreach (Member m in ctorMembers)
        {
            WriteAssignment(sb, m);
        }
        sb.Append(Indent).Append(Indent).Append("this.occurredOn = occurredOn;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(PathFor(ns, KindFolder.Events, name), Assemble(emit, ns, KindFolder.Events, sb.ToString()));
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

    /// <summary>A readable fallback rule message synthesized from a condition (mirrors the C# emitter's intent).</summary>
    private static string SynthesizeMessage(Expr condition) => "invariant failed";
}
