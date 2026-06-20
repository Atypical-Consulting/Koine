using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The value-object slice of <see cref="CSharpEmitter"/>: rendering a declared value
/// object (properties, guarded constructor, derived members, structural equality and
/// ToString) and its usage-gated/quantity arithmetic operators (R9). Split out as a
/// partial to keep the orchestrating emitter focused.
/// </summary>
public sealed partial class CSharpEmitter
{
    // ----------------------------------------------------------------------
    // Value objects
    // ----------------------------------------------------------------------

    private EmittedFile EmitValueObject(
        EmitContext emit,
        ValueObjectDecl vo,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var translator = new CSharpExpressionTranslator(index, vo.Members, enumMemberToType, SpecBodiesFor(vo.Name, index), context: ContextOf(ns), options: _options);

        // The lowered field projection (Commit 5): ctor-vs-derived classification, default dispositions,
        // collection shape, and canonical ctor ordering are all owned by the bound nodes now, computed
        // once in the lowerer rather than re-derived from raw syntax here.
        BoundValueObject bound = emit.Semantic.BoundValueObjectFor(vo);
        var storedFields = bound.StoredFields.ToList();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, vo.Doc, "");
        WriteObsolete(sb, vo.Deprecated, "");
        sb.Append("public sealed class ").Append(vo.Name).Append(" : ValueObject\n");
        sb.Append("{\n");

        // Properties (one per stored field, in declaration order).
        foreach (BoundField f in storedFields)
        {
            var m = (Member)f.Syntax;
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(f.Name)).Append(" { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Constructor: driven entirely from the lowered projection — ordered ctor params, default
        // dispositions, and the folded invariant guards (Commit 5). The condition rendering is migrated
        // to the bound expressions separately; field projection alone keeps output byte-identical.
        sb.Append('\n');
        WriteValueObjectConstructor(sb, vo.Name, bound, translator, typeMapper, index);

        // Derived (computed) properties after the constructor.
        foreach (BoundField f in bound.DerivedFields)
        {
            var m = (Member)f.Syntax;
            var csType = typeMapper.Map(m.Type);
            // Render the derived body from its LOWERED bound initializer (Commit 6): resolved types come
            // from the bound tree rather than being re-inferred by the translator.
            var body = translator.TranslateTopLevelBound(f.DerivedInitializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(f.Name)).Append('\n');
            sb.Append(Indent).Append(Indent).Append("=> ").Append(body).Append(";\n");
        }

        // A quantity (R9.2) gets explicit, unit-checked arithmetic instead of the
        // demand-driven scalar/additive heuristic (which is skipped for quantities to
        // avoid emitting a duplicate operator).
        if (vo.IsQuantity)
        {
            WriteQuantityOperators(sb, vo, bound, index);
        }
        else
        {
            // POLICY (usage-gated VO arithmetic): a non-quantity value object's +/* operators
            // are emitted ONLY when some expression in the model actually multiplies it by a
            // scalar (_scalarNeeds) or folds it with sum (_additiveNeeds). This is deliberate:
            // a generic value object has no inherent arithmetic, so emitting +/* unconditionally
            // would (a) be meaningless for non-numeric VOs and (b) bloat the output with operators
            // no one calls. Quantities (R9.2) are the exception — they always get unit-checked
            // arithmetic above. If a VO needs guaranteed operators, model it as a quantity.

            // Scalar arithmetic operators: emitted only when this value object is actually
            // multiplied by a scalar in a derived expression.
            if (emit.ScalarNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? scalarTypes))
            {
                IReadOnlyList<Member> numericFields = NumericFields(bound);
                if (numericFields.Count > 0)
                {
                    WriteScalarOperators(sb, vo, bound, numericFields, scalarTypes, typeMapper);
                }
            }

            // Additive operator for value objects that are summed (e.g. lines.sum(l => l.subtotal)).
            if (emit.AdditiveNeeds.Contains(vo.Name))
            {
                IReadOnlyList<Member> numericFields = NumericFields(bound);
                if (numericFields.Count > 0)
                {
                    WriteAdditiveOperator(sb, vo, bound, numericFields);
                }
            }
        }

        // A readable ToString for logs/tests/debugging (object.ToString would only
        // show the type name); enums already do this.
        WriteValueObjectToString(sb, vo.Name, storedFields);

        // Structural value equality: the components are the non-derived (stored) fields.
        WriteEqualityComponents(sb, storedFields);

        sb.Append("}\n");

        var contents = Assemble(emit, ns, sb.ToString(),
            UsesLinq(vo.Members, vo.Invariants) || SpecBodiesUseLinq(vo.Name, index),
            vo.Span, out var sourceMap);
        return new EmittedFile(PathFor(emit, ns, KindFolder.ValueObjects, $"{vo.Name}.cs"), contents, sourceMap);
    }

    /// <summary>
    /// Emits a deterministic, record-style <c>ToString()</c> over the non-derived
    /// fields (e.g. <c>Money { Amount = 10, Currency = EUR }</c>), so value objects are
    /// readable in logs and test output instead of falling back to the type name.
    /// </summary>
    private void WriteValueObjectToString(StringBuilder sb, string typeName, IReadOnlyList<BoundField> members)
    {
        sb.Append('\n');
        if (members.Count == 0)
        {
            sb.Append(Indent).Append("public override string ToString()\n");
            sb.Append(Indent).Append(Indent).Append("=> \"").Append(typeName).Append("\";\n");
            return;
        }
        sb.Append(Indent).Append("public override string ToString()\n");
        sb.Append(Indent).Append(Indent).Append("=> $\"").Append(typeName).Append(" {{ ");
        var firstField = true;
        foreach (var m in members)
        {
            if (!firstField)
            {
                sb.Append(", ");
            }

            firstField = false;
            var prop = CSharpNaming.ToPascalCase(m.Name);
            sb.Append(prop).Append(" = {").Append(prop).Append('}');
        }

        sb.Append(" }}\";\n");
    }

    /// <summary>
    /// Emits the <c>GetEqualityComponents()</c> override that drives the
    /// <see cref="ValueObject"/> base's structural equality: each non-derived field,
    /// in declaration order.
    /// </summary>
    private void WriteEqualityComponents(StringBuilder sb, IReadOnlyList<BoundField> members)
    {
        sb.Append('\n');
        sb.Append(Indent).Append("protected override IEnumerable<object?> GetEqualityComponents()\n");
        sb.Append(Indent).Append("{\n");
        if (members.Count == 0)
        {
            // No fields => no components; `yield break;` keeps this a valid iterator.
            sb.Append(Indent).Append(Indent).Append("yield break;\n");
        }
        else
        {
            foreach (BoundField f in members)
            {
                var prop = CSharpNaming.ToPascalCase(f.Name);
                // Collections must compare by element, not by reference: wrap them in
                // the base's structural helpers (ordered for lists, unordered for sets/maps).
                var component = f.CollectionShape switch
                {
                    CollectionShape.List => $"Ordered({prop})",
                    CollectionShape.Set or CollectionShape.Map => $"Unordered({prop})",
                    _ => prop
                };
                sb.Append(Indent).Append(Indent).Append("yield return ").Append(component).Append(";\n");
            }
        }
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Generates scalar multiply operators so value-object * scalar arithmetic
    /// compiles (e.g. <c>Money * int</c> for <c>subtotal = unitPrice * quantity</c>).
    /// Deliberate v0 codegen rule: scale every numeric field and carry the rest
    /// unchanged. The product is cast back to a narrower field type when needed
    /// (e.g. an <c>int</c> field multiplied by a <c>decimal</c> scalar).
    /// </summary>
    private void WriteScalarOperators(
        StringBuilder sb,
        ValueObjectDecl vo,
        BoundValueObject bound,
        IReadOnlyList<Member> numericFields,
        IReadOnlySet<string> scalarTypes,
        CSharpTypeMapper typeMapper)
    {
        // Constructor args must be passed in the SAME order the constructor declares its
        // parameters — the projection's CtorParams owns that order (defaulted/optional last).
        var ctorMembers = bound.CtorParams.Select(f => (Member)f.Syntax).ToList();
        var numericNames = new HashSet<string>(numericFields.Select(m => m.Name), StringComparer.Ordinal);

        // Deterministic order; only the scalar types actually used.
        foreach (var scalar in scalarTypes.OrderBy(s => s, StringComparer.Ordinal))
        {
            var args = string.Join(", ", ctorMembers.Select(m =>
            {
                var prop = $"left.{CSharpNaming.ToPascalCase(m.Name)}";
                if (!numericNames.Contains(m.Name))
                {
                    return prop;
                }

                var product = $"{prop} * right";
                // int field * decimal scalar yields decimal -> cast back to int.
                return typeMapper.Map(m.Type) == "int" && scalar == "decimal"
                    ? $"(int)({product})"
                    : product;
            }));

            sb.Append('\n').Append(Indent)
              .Append("public static ").Append(vo.Name).Append(" operator *(")
              .Append(vo.Name).Append(" left, ").Append(scalar).Append(" right)\n")
              .Append(Indent).Append(Indent).Append("=> new ")
              .Append(vo.Name).Append('(').Append(args).Append(");\n");
        }
    }

    /// <summary>
    /// Emits a quantity's unit-checked arithmetic (R9.2): <c>+</c>/<c>-</c> require the
    /// same unit (throwing <c>DomainInvariantViolationException</c> on a mismatch, since
    /// units are runtime enum values) and scalar <c>*</c>/<c>/</c> by <c>int</c>/<c>decimal</c>
    /// scale the amount and preserve the unit. Operators are emitted in a fixed order
    /// for byte-identical determinism.
    /// </summary>
    private void WriteQuantityOperators(StringBuilder sb, ValueObjectDecl vo, BoundValueObject bound, ModelIndex index)
    {
        var nonDerived = bound.StoredFields.Select(f => (Member)f.Syntax).ToList();
        Member? amount = nonDerived.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = nonDerived.FirstOrDefault(m => index.Classify(m.Type.Name) == TypeKind.Enum && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return; // a malformed quantity is already a validation error; emit no operators
        }

        var name = vo.Name;
        var amtProp = CSharpNaming.ToPascalCase(amount.Name);
        var unitProp = CSharpNaming.ToPascalCase(unit.Name);
        var ctorOrder = bound.CtorParams.Select(f => (Member)f.Syntax).ToList();

        // Build `new Name(...)` with the amount/unit values placed in constructor order.
        string Construct(string amtExpr, string unitExpr) =>
            $"new {name}(" + string.Join(", ", ctorOrder.Select(m =>
                ReferenceEquals(m, amount) ? amtExpr
                : ReferenceEquals(m, unit) ? unitExpr
                : "default!")) + ")";

        foreach (var (op, verb) in new[] { ("+", "add"), ("-", "subtract") })
        {
            sb.Append('\n').Append(Indent)
              .Append("public static ").Append(name).Append(" operator ").Append(op).Append('(')
              .Append(name).Append(" left, ").Append(name).Append(" right)\n");
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("if (left.").Append(unitProp)
              .Append(" != right.").Append(unitProp).Append(")\n");
            sb.Append(Indent).Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: nameof(").Append(name).Append("),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
              .Append("rule: \"cannot ").Append(verb).Append(" quantities of different units\");\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct($"left.{amtProp} {op} right.{amtProp}", $"left.{unitProp}")).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        // The amount is always Decimal, so scalar */÷ by int or decimal stays exact.
        foreach (var op in new[] { "*", "/" })
        {
            foreach (var scalar in new[] { "int", "decimal" })
            {
                sb.Append('\n').Append(Indent)
                  .Append("public static ").Append(name).Append(" operator ").Append(op).Append('(')
                  .Append(name).Append(" left, ").Append(scalar).Append(" right)\n")
                  .Append(Indent).Append(Indent).Append("=> ")
                  .Append(Construct($"left.{amtProp} {op} right", $"left.{unitProp}")).Append(";\n");
            }
        }
    }

    private static IReadOnlyList<Member> NumericFields(BoundValueObject bound) =>
        bound.StoredFields
            .Select(f => (Member)f.Syntax)
            .Where(m => m.Type.Name is "Int" or "Decimal")
            .ToList();

    /// <summary>
    /// Generates a structural <c>+</c> operator so a value object can be folded by
    /// <c>sum</c> (e.g. <c>lines.sum(l =&gt; l.subtotal)</c> over <c>Money</c>). Adds
    /// every numeric field pairwise and carries the rest from the left operand,
    /// mirroring the scalar-operator heuristic.
    /// </summary>
    private void WriteAdditiveOperator(StringBuilder sb, ValueObjectDecl vo, BoundValueObject bound, IReadOnlyList<Member> numericFields)
    {
        // Same ordering rule as the constructor (the projection's CtorParams: defaulted/optional last).
        var ctorMembers = bound.CtorParams.Select(f => (Member)f.Syntax).ToList();
        var numericNames = new HashSet<string>(numericFields.Select(m => m.Name), StringComparer.Ordinal);

        var args = string.Join(", ", ctorMembers.Select(m =>
        {
            var prop = CSharpNaming.ToPascalCase(m.Name);
            return numericNames.Contains(m.Name)
                ? $"left.{prop} + right.{prop}"
                : $"left.{prop}";
        }));

        // Non-numeric fields (e.g. a Money's Currency) are carried from the left operand.
        // The operands must agree on them, else the fold would silently coerce one
        // (EUR + USD -> EUR). Guard each, mirroring unit-checked quantity arithmetic.
        var carried = ctorMembers.Where(m => !numericNames.Contains(m.Name)).ToList();

        sb.Append('\n').Append(Indent)
          .Append("public static ").Append(vo.Name).Append(" operator +(")
          .Append(vo.Name).Append(" left, ").Append(vo.Name).Append(" right)");

        if (carried.Count == 0)
        {
            sb.Append('\n').Append(Indent).Append(Indent)
              .Append("=> new ").Append(vo.Name).Append('(').Append(args).Append(");\n");
            return;
        }

        sb.Append('\n').Append(Indent).Append("{\n");
        foreach (Member m in carried)
        {
            var prop = CSharpNaming.ToPascalCase(m.Name);
            sb.Append(Indent).Append(Indent).Append("if (!Equals(left.").Append(prop)
              .Append(", right.").Append(prop).Append("))\n");
            sb.Append(Indent).Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
              .Append("type: nameof(").Append(vo.Name).Append("),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
              .Append("rule: \"cannot combine ").Append(vo.Name).Append(" values with a different ")
              .Append(CSharpNaming.ToCamelCase(m.Name)).Append("\");\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
        }
        sb.Append(Indent).Append(Indent).Append("return new ").Append(vo.Name)
          .Append('(').Append(args).Append(");\n");
        sb.Append(Indent).Append("}\n");
    }

}
