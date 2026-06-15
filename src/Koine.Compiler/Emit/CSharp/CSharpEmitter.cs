using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The C# backend. Turns a validated <see cref="KoineModel"/> into a set of C#
/// source files. All C#-specific decisions (naming, type mapping, expression
/// translation, codegen rules) live in this folder; the AST stays target-agnostic.
///
/// <para>Emission is deterministic (declaration order) so re-runs are byte-identical.
/// Every file ends with a single trailing newline; no timestamps are emitted.</para>
/// </summary>
public sealed class CSharpEmitter : IEmitter
{
    public string TargetName => "csharp";

    private const string Indent = "    ";

    // Value-object name -> scalar C# types ("int"/"decimal") it is multiplied by
    // in some derived expression. Drives scalar operator generation (see below).
    private IReadOnlyDictionary<string, IReadOnlySet<string>> _scalarNeeds =
        new Dictionary<string, IReadOnlySet<string>>();

    // Value-object names that are folded with `+` somewhere (e.g. `lines.sum(l => l.subtotal)`
    // over a Money field). Drives generation of an additive operator.
    private IReadOnlySet<string> _additiveNeeds = new HashSet<string>();

    // All context (namespace) names in the model. Every type in a context shares
    // the single namespace <Context>; aggregates are boundaries, not namespaces.
    private IReadOnlyList<string> _contextNames = Array.Empty<string>();

    public IReadOnlyList<EmittedFile> Emit(KoineModel model)
    {
        var index = new ModelIndex(model);
        var typeMapper = new CSharpTypeMapper(index);
        var enumMemberToType = BuildEnumMemberMap(model);
        _scalarNeeds = BuildScalarOperatorNeeds(model, index);
        _additiveNeeds = BuildAdditiveOperatorNeeds(model, index);
        _contextNames = model.Contexts.Select(c => c.Name).ToList();

        var files = new List<EmittedFile>();

        // 1. Runtime support, emitted once.
        files.Add(EmitRuntimeException());
        files.Add(EmitAggregateRootInterface());
        if (NeedsValueObjects(model))
            files.Add(EmitValueObjectBase());
        if (HasEvents(model))
            files.Add(EmitDomainEventInterface());

        // 2. Per-context user types. Aggregate-nested types are flattened into the
        //    context namespace; the aggregate boundary is marked via IAggregateRoot.
        foreach (var ctx in model.Contexts)
        {
            var idOwnership = BuildIdOwnership(ctx);

            foreach (var type in ctx.Types)
            {
                switch (type)
                {
                    case ValueObjectDecl vo:
                        files.Add(EmitValueObject(vo, ctx.Name, index, typeMapper, enumMemberToType));
                        break;
                    case EntityDecl entity:
                        EmitEntityAndId(files, entity, ctx.Name, isRoot: false, index, typeMapper, enumMemberToType);
                        break;
                    case EnumDecl @enum:
                        files.Add(EmitEnum(@enum, ctx.Name));
                        break;
                    case EventDecl @event:
                        files.Add(EmitEvent(@event, ctx.Name, index, typeMapper, enumMemberToType));
                        break;
                    case AggregateDecl agg:
                        EmitAggregate(files, agg, ctx.Name, index, typeMapper, enumMemberToType);
                        break;
                }
            }

            // Emit any ID value objects that are referenced but NOT owned by an
            // entity (e.g. ProductId).
            foreach (var idName in OrderedUnownedIds(ctx, index, idOwnership))
            {
                files.Add(EmitIdValueObject(idName, ctx.Name));
            }
        }

        return files;
    }

    // ----------------------------------------------------------------------
    // Aggregates
    // ----------------------------------------------------------------------

    private void EmitAggregate(
        List<EmittedFile> files,
        AggregateDecl agg,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        // Nested types live in the enclosing context namespace (ns), not a sub-namespace.
        foreach (var type in agg.Types)
        {
            switch (type)
            {
                case ValueObjectDecl vo:
                    files.Add(EmitValueObject(vo, ns, index, typeMapper, enumMemberToType));
                    break;
                case EntityDecl entity:
                    var isRoot = entity.Name == agg.RootName;
                    EmitEntityAndId(files, entity, ns, isRoot, index, typeMapper, enumMemberToType);
                    break;
                case EnumDecl @enum:
                    files.Add(EmitEnum(@enum, ns));
                    break;
                case EventDecl @event:
                    files.Add(EmitEvent(@event, ns, index, typeMapper, enumMemberToType));
                    break;
                case AggregateDecl nested:
                    // Nested aggregates are not part of v0 fixtures, but recurse safely.
                    EmitAggregate(files, nested, ns, index, typeMapper, enumMemberToType);
                    break;
            }
        }
    }

    // ----------------------------------------------------------------------
    // Value objects
    // ----------------------------------------------------------------------

    private EmittedFile EmitValueObject(
        ValueObjectDecl vo,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        var translator = new CSharpExpressionTranslator(index, vo.Members, enumMemberToType);

        var ctorParams = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, vo.Doc, "");
        sb.Append("public sealed class ").Append(vo.Name).Append(" : ValueObject\n");
        sb.Append("{\n");

        // Properties (one per member, in declaration order).
        foreach (var m in vo.Members)
        {
            if (MemberAnalysis.IsDerived(m, memberNames))
                continue; // derived emitted later as computed property
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Constructor.
        sb.Append('\n');
        WriteConstructor(sb, vo.Name, ctorParams, vo.Invariants, memberNames, translator, typeMapper, enumMemberToType, index);

        // Derived (computed) properties after the constructor.
        foreach (var m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" => ").Append(body).Append(";\n");
        }

        // Scalar arithmetic operators (v0 codegen rule): emitted only when this
        // value object is actually multiplied by a scalar in a derived expression.
        if (_scalarNeeds.TryGetValue(vo.Name, out var scalarTypes))
        {
            var numericFields = NumericFields(vo);
            if (numericFields.Count > 0)
                WriteScalarOperators(sb, vo, numericFields, scalarTypes, typeMapper);
        }

        // Additive operator for value objects that are summed (e.g. lines.sum(l => l.subtotal)).
        if (_additiveNeeds.Contains(vo.Name))
        {
            var numericFields = NumericFields(vo);
            if (numericFields.Count > 0)
                WriteAdditiveOperator(sb, vo, numericFields);
        }

        // Structural value equality: the components are the non-derived fields.
        WriteEqualityComponents(sb, ctorParams);

        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{vo.Name}.cs",
            Assemble(ns, sb.ToString(), UsesLinq(vo.Members, vo.Invariants)));
    }

    /// <summary>
    /// Emits the <c>GetEqualityComponents()</c> override that drives the
    /// <see cref="ValueObject"/> base's structural equality: each non-derived field,
    /// in declaration order.
    /// </summary>
    private void WriteEqualityComponents(StringBuilder sb, IReadOnlyList<Member> members)
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
            foreach (var m in members)
            {
                var prop = CSharpNaming.ToPascalCase(m.Name);
                // Collections must compare by element, not by reference: wrap them in
                // the base's structural helpers (ordered for lists, unordered for sets/maps).
                var component =
                    CSharpTypeMapper.IsList(m.Type) ? $"Ordered({prop})"
                    : CSharpTypeMapper.IsSet(m.Type) || CSharpTypeMapper.IsMap(m.Type) ? $"Unordered({prop})"
                    : prop;
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
        IReadOnlyList<Member> numericFields,
        IReadOnlySet<string> scalarTypes,
        CSharpTypeMapper typeMapper)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        // Constructor args must be passed in the SAME order the constructor declares
        // its parameters (OrderCtorParams moves defaulted/optional fields last).
        var ctorMembers = OrderCtorParams(vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames))).ToList();
        var numericNames = new HashSet<string>(numericFields.Select(m => m.Name), StringComparer.Ordinal);

        // Deterministic order; only the scalar types actually used.
        foreach (var scalar in scalarTypes.OrderBy(s => s, StringComparer.Ordinal))
        {
            var args = string.Join(", ", ctorMembers.Select(m =>
            {
                var prop = $"left.{CSharpNaming.ToPascalCase(m.Name)}";
                if (!numericNames.Contains(m.Name))
                    return prop;
                var product = $"{prop} * right";
                // int field * decimal scalar yields decimal -> cast back to int.
                return typeMapper.Map(m.Type) == "int" && scalar == "decimal"
                    ? $"(int)({product})"
                    : product;
            }));

            sb.Append('\n').Append(Indent)
              .Append("public static ").Append(vo.Name).Append(" operator *(")
              .Append(vo.Name).Append(" left, ").Append(scalar).Append(" right) => new ")
              .Append(vo.Name).Append('(').Append(args).Append(");\n");
        }
    }

    private static IReadOnlyList<Member> NumericFields(ValueObjectDecl vo)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        return vo.Members
            .Where(m => !MemberAnalysis.IsDerived(m, memberNames))
            .Where(m => m.Type.Name is "Int" or "Decimal")
            .ToList();
    }

    /// <summary>
    /// Generates a structural <c>+</c> operator so a value object can be folded by
    /// <c>sum</c> (e.g. <c>lines.sum(l =&gt; l.subtotal)</c> over <c>Money</c>). Adds
    /// every numeric field pairwise and carries the rest from the left operand,
    /// mirroring the scalar-operator heuristic.
    /// </summary>
    private void WriteAdditiveOperator(StringBuilder sb, ValueObjectDecl vo, IReadOnlyList<Member> numericFields)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        // Same ordering rule as the constructor (defaulted/optional fields last).
        var ctorMembers = OrderCtorParams(vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames))).ToList();
        var numericNames = new HashSet<string>(numericFields.Select(m => m.Name), StringComparer.Ordinal);

        var args = string.Join(", ", ctorMembers.Select(m =>
        {
            var prop = CSharpNaming.ToPascalCase(m.Name);
            return numericNames.Contains(m.Name)
                ? $"left.{prop} + right.{prop}"
                : $"left.{prop}";
        }));

        sb.Append('\n').Append(Indent)
          .Append("public static ").Append(vo.Name).Append(" operator +(")
          .Append(vo.Name).Append(" left, ").Append(vo.Name).Append(" right) => new ")
          .Append(vo.Name).Append('(').Append(args).Append(");\n");
    }

    /// <summary>
    /// Scans every member initializer for a value-object <c>sum</c> selector (e.g.
    /// <c>lines.sum(l =&gt; l.subtotal)</c> producing a <c>Money</c>) and records the
    /// value-object types that therefore need an additive operator.
    /// </summary>
    private static IReadOnlySet<string> BuildAdditiveOperatorNeeds(KoineModel model, ModelIndex index)
    {
        var resolver = new TypeResolver(index);
        var needs = new HashSet<string>(StringComparer.Ordinal);

        foreach (var ctx in model.Contexts)
        foreach (var type in AllTypeDecls(ctx))
        {
            IReadOnlyList<Member>? members = type switch
            {
                ValueObjectDecl v => v.Members,
                EntityDecl e => e.Members,
                EventDecl ev => ev.Members,
                _ => null
            };
            if (members is null) continue;

            var scope = TypeScope.FromMembers(members);
            foreach (var m in members)
                if (m.Initializer is not null)
                    ScanForValueObjectSum(m.Initializer, scope, resolver, needs);

            // Command bodies and state-rule guards can also fold value objects with sum.
            if (type is EntityDecl entity)
            {
                foreach (var cmd in entity.Commands)
                {
                    var cmdScope = cmd.Parameters.Aggregate(scope, (s, p) => s.With(p.Name, p.Type));
                    foreach (var stmt in cmd.Body)
                    {
                        if (stmt is RequiresClause req) ScanForValueObjectSum(req.Condition, cmdScope, resolver, needs);
                        else if (stmt is Transition tr) ScanForValueObjectSum(tr.Value, cmdScope, resolver, needs);
                        else if (stmt is EmitClause em)
                            foreach (var arg in em.Args) ScanForValueObjectSum(arg.Value, cmdScope, resolver, needs);
                    }
                }
                foreach (var guard in StateGuards(entity))
                    ScanForValueObjectSum(guard, scope, resolver, needs);
            }
        }

        return needs;
    }

    private static void ScanForValueObjectSum(Expr expr, TypeScope scope, TypeResolver resolver, HashSet<string> needs)
    {
        switch (expr)
        {
            case CallExpr call:
                if (call.Method == "sum" && call.Args is [LambdaExpr lambda])
                {
                    var element = TypeResolver.ElementOf(resolver.Infer(call.Target, scope));
                    if (element is not null)
                    {
                        var selector = resolver.Infer(lambda.Body, scope.With(lambda.Parameter, element));
                        if (resolver.IsValueLike(selector))
                            needs.Add(selector!.Name);
                    }
                }
                ScanForValueObjectSum(call.Target, scope, resolver, needs);
                foreach (var arg in call.Args) ScanForValueObjectSum(arg, scope, resolver, needs);
                break;
            case LambdaExpr l: ScanForValueObjectSum(l.Body, scope, resolver, needs); break;
            case BinaryExpr b:
                ScanForValueObjectSum(b.Left, scope, resolver, needs);
                ScanForValueObjectSum(b.Right, scope, resolver, needs);
                break;
            case UnaryExpr u: ScanForValueObjectSum(u.Operand, scope, resolver, needs); break;
            case MemberAccessExpr ma: ScanForValueObjectSum(ma.Target, scope, resolver, needs); break;
            case ConditionalExpr c:
                ScanForValueObjectSum(c.Condition, scope, resolver, needs);
                ScanForValueObjectSum(c.Then, scope, resolver, needs);
                ScanForValueObjectSum(c.Else, scope, resolver, needs);
                break;
            case GuardExpr g:
                ScanForValueObjectSum(g.Body, scope, resolver, needs);
                ScanForValueObjectSum(g.Condition, scope, resolver, needs);
                break;
            case MatchExpr mt: ScanForValueObjectSum(mt.Target, scope, resolver, needs); break;
        }
    }

    /// <summary>
    /// Scans every derived member initializer in the model for
    /// <c>value-object * scalar</c> multiplications and records, per value-object
    /// type, which scalar C# types ("int"/"decimal") it is multiplied by. Only
    /// those operators are generated, so we never emit spurious (or non-compiling)
    /// operators on value objects that are never multiplied.
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarOperatorNeeds(KoineModel model, ModelIndex index)
    {
        var needs = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        foreach (var ctx in model.Contexts)
        foreach (var type in AllTypeDecls(ctx))
        {
            IReadOnlyList<Member>? members = type switch
            {
                ValueObjectDecl v => v.Members,
                EntityDecl e => e.Members,
                EventDecl ev => ev.Members,
                _ => null
            };
            if (members is null) continue;

            var memberTypes = members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
            foreach (var m in members)
                if (m.Initializer is not null)
                    ScanForScalarMul(m.Initializer, memberTypes, index, needs);

            // Command bodies and state-rule guards can also use value-object arithmetic.
            if (type is EntityDecl entity)
            {
                foreach (var (expr, scope) in CommandExpressions(entity, memberTypes))
                    ScanForScalarMul(expr, scope, index, needs);
                foreach (var guard in StateGuards(entity))
                    ScanForScalarMul(guard, memberTypes, index, needs);
            }
        }

        return needs.ToDictionary(kv => kv.Key, kv => (IReadOnlySet<string>)kv.Value, StringComparer.Ordinal);
    }

    /// <summary>
    /// Every expression appearing in an entity's commands (requires conditions and
    /// transition values), paired with a member-type map extended by that command's
    /// parameters — for the operator-need scans.
    /// </summary>
    /// <summary>The guard expressions of an entity's state-machine rules.</summary>
    private static IEnumerable<Expr> StateGuards(EntityDecl entity) =>
        entity.States.SelectMany(s => s.Rules).Where(r => r.Guard is not null).Select(r => r.Guard!);

    private static IEnumerable<(Expr Expr, IReadOnlyDictionary<string, TypeRef> Scope)> CommandExpressions(
        EntityDecl entity, IReadOnlyDictionary<string, TypeRef> memberTypes)
    {
        foreach (var cmd in entity.Commands)
        {
            var scope = new Dictionary<string, TypeRef>(memberTypes, StringComparer.Ordinal);
            foreach (var p in cmd.Parameters) scope[p.Name] = p.Type;

            foreach (var stmt in cmd.Body)
            {
                if (stmt is RequiresClause req) yield return (req.Condition, scope);
                else if (stmt is Transition tr) yield return (tr.Value, scope);
                else if (stmt is EmitClause em)
                    foreach (var arg in em.Args) yield return (arg.Value, scope);
            }
        }
    }

    private static void ScanForScalarMul(
        Expr expr,
        IReadOnlyDictionary<string, TypeRef> memberTypes,
        ModelIndex index,
        Dictionary<string, HashSet<string>> needs)
    {
        switch (expr)
        {
            case BinaryExpr b:
                if (b.Op == BinaryOp.Mul)
                {
                    var (lValue, lScalar) = InferOperand(b.Left, memberTypes, index);
                    var (rValue, rScalar) = InferOperand(b.Right, memberTypes, index);
                    if (lValue is not null && rScalar is not null) Record(needs, lValue, rScalar);
                    if (rValue is not null && lScalar is not null) Record(needs, rValue, lScalar);
                }
                ScanForScalarMul(b.Left, memberTypes, index, needs);
                ScanForScalarMul(b.Right, memberTypes, index, needs);
                break;
            case UnaryExpr u: ScanForScalarMul(u.Operand, memberTypes, index, needs); break;
            case MemberAccessExpr ma: ScanForScalarMul(ma.Target, memberTypes, index, needs); break;
            case CallExpr call:
                ScanForScalarMul(call.Target, memberTypes, index, needs);
                foreach (var arg in call.Args) ScanForScalarMul(arg, memberTypes, index, needs);
                break;
            case LambdaExpr lam: ScanForScalarMul(lam.Body, memberTypes, index, needs); break;
            case ConditionalExpr c:
                ScanForScalarMul(c.Condition, memberTypes, index, needs);
                ScanForScalarMul(c.Then, memberTypes, index, needs);
                ScanForScalarMul(c.Else, memberTypes, index, needs);
                break;
            case MatchExpr mt: ScanForScalarMul(mt.Target, memberTypes, index, needs); break;
            case GuardExpr g:
                ScanForScalarMul(g.Body, memberTypes, index, needs);
                ScanForScalarMul(g.Condition, memberTypes, index, needs);
                break;
        }
    }

    /// <summary>Shallowly infers whether an operand is a value object or a numeric scalar.</summary>
    private static (string? ValueObject, string? Scalar) InferOperand(
        Expr expr, IReadOnlyDictionary<string, TypeRef> memberTypes, ModelIndex index)
    {
        switch (expr)
        {
            case IdentifierExpr id when memberTypes.TryGetValue(id.Name, out var t):
                if (index.Classify(t.Name) == TypeKind.Value) return (t.Name, null);
                if (t.Name == "Int") return (null, "int");
                if (t.Name == "Decimal") return (null, "decimal");
                return (null, null);
            case LiteralExpr lit when lit.Kind == LiteralKind.Int: return (null, "int");
            case LiteralExpr lit when lit.Kind == LiteralKind.Decimal: return (null, "decimal");
            default: return (null, null);
        }
    }

    private static void Record(Dictionary<string, HashSet<string>> needs, string vo, string scalar)
    {
        if (!needs.TryGetValue(vo, out var set))
            needs[vo] = set = new HashSet<string>(StringComparer.Ordinal);
        set.Add(scalar);
    }

    // ----------------------------------------------------------------------
    // Entities + generated ID
    // ----------------------------------------------------------------------

    private void EmitEntityAndId(
        List<EmittedFile> files,
        EntityDecl entity,
        string ns,
        bool isRoot,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        files.Add(EmitEntity(entity, ns, isRoot, index, typeMapper, enumMemberToType));
        // The entity's own ID value object lives in the same namespace.
        files.Add(EmitIdValueObject(entity.IdentityName, ns));
    }

    private EmittedFile EmitEntity(
        EntityDecl entity,
        string ns,
        bool isRoot,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        // The translator also resolves the synthetic `id` (the entity's identity) so
        // command/emit expressions can reference it; it renders as the `Id` property.
        var scopeMembers = entity.Members
            .Append(new Member("id", new TypeRef(entity.IdentityName), null))
            .ToList();
        var translator = new CSharpExpressionTranslator(index, scopeMembers, enumMemberToType);

        var sb = new StringBuilder();

        WriteXmlDoc(sb, entity.Doc, "");
        sb.Append("public sealed class ").Append(entity.Name);
        if (isRoot)
            sb.Append(" : IAggregateRoot");
        sb.Append('\n');
        sb.Append("{\n");

        // Identity property first.
        sb.Append(Indent).Append("public ").Append(entity.IdentityName).Append(" Id { get; }\n");

        // Non-derived member properties. A field mutated by a command gains a
        // private setter; all others stay get-only.
        var ctorMembers = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var mutated = MutatedFields(entity);

        foreach (var m in ctorMembers)
        {
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name))
              .Append(mutated.Contains(m.Name) ? " { get; private set; }" : " { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Constructor: identity param first, then members.
        sb.Append('\n');
        WriteEntityConstructor(sb, entity, ctorMembers, memberNames, translator, typeMapper, enumMemberToType, index);

        // Derived (computed) properties.
        foreach (var m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" => ").Append(body).Append(";\n");
        }

        // Domain-event recording (when any command emits events).
        var hasEmits = entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any();
        if (hasEmits)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("private readonly List<IDomainEvent> _domainEvents = new();\n");
            sb.Append(Indent).Append("public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents;\n");
            sb.Append(Indent).Append("public void ClearDomainEvents() => _domainEvents.Clear();\n");
        }

        // Commands: intention-revealing state-changing methods.
        foreach (var cmd in entity.Commands)
            WriteCommand(sb, entity, cmd, translator, typeMapper, index);

        // Identity-based equality.
        sb.Append('\n');
        sb.Append(Indent).Append("public bool Equals(").Append(entity.Name)
          .Append("? other) => other is not null && Id.Equals(other.Id);\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj) => Equals(obj as ")
          .Append(entity.Name).Append(");\n");
        sb.Append(Indent).Append("public override int GetHashCode() => Id.GetHashCode();\n");

        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{entity.Name}.cs",
            Assemble(ns, sb.ToString(), EntityUsesLinq(entity)));
    }

    private EmittedFile EmitIdValueObject(string idName, string ns)
    {
        var sb = new StringBuilder();

        sb.Append("/// <summary>A strongly-typed identity value object.</summary>\n");
        sb.Append("public sealed class ").Append(idName).Append(" : ValueObject\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public Guid Value { get; }\n\n");
        sb.Append(Indent).Append("public ").Append(idName).Append("(Guid value) => Value = value;\n\n");
        sb.Append(Indent).Append("public static ").Append(idName).Append(" New() => new(Guid.NewGuid());\n\n");
        sb.Append(Indent).Append("protected override IEnumerable<object?> GetEqualityComponents()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("yield return Value;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{idName}.cs", Assemble(ns, sb.ToString(), usesLinq: false));
    }

    // ----------------------------------------------------------------------
    // Enums
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits an enum as a self-contained "smart enum": a sealed class with one
    /// static readonly instance per member, <c>Name</c>/<c>Value</c>, an <c>All</c>
    /// list, <c>FromName</c>/<c>FromValue</c> lookups, value equality and
    /// <c>==</c>/<c>!=</c>. No external dependency; members are referenced exactly
    /// like enum members (<c>OrderStatus.Cancelled</c>).
    /// </summary>
    private EmittedFile EmitEnum(EnumDecl @enum, string ns)
    {
        var name = @enum.Name;
        var sb = new StringBuilder();

        WriteXmlDoc(sb, @enum.Doc ?? "A type-safe smart enum: static instances with value equality.", "");
        sb.Append("public sealed class ").Append(name).Append(" : IEquatable<").Append(name).Append(">\n{\n");

        // One static readonly instance per member, in declaration order.
        for (var i = 0; i < @enum.Members.Count; i++)
            sb.Append(Indent).Append("public static readonly ").Append(name).Append(' ')
              .Append(@enum.Members[i]).Append(" = new(\"").Append(@enum.Members[i]).Append("\", ")
              .Append(i).Append(");\n");

        sb.Append('\n');
        sb.Append(Indent).Append("public string Name { get; }\n");
        sb.Append(Indent).Append("public int Value { get; }\n\n");

        sb.Append(Indent).Append("private ").Append(name).Append("(string name, int value)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("Name = name;\n");
        sb.Append(Indent).Append(Indent).Append("Value = value;\n");
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("public static IReadOnlyList<").Append(name).Append("> All { get; } = new[] { ")
          .Append(string.Join(", ", @enum.Members)).Append(" };\n\n");

        sb.Append(Indent).Append("public static ").Append(name).Append(" FromName(string name) =>\n");
        sb.Append(Indent).Append(Indent).Append("All.FirstOrDefault(e => e.Name == name)\n");
        sb.Append(Indent).Append(Indent).Append("?? throw new ArgumentOutOfRangeException(nameof(name), $\"No ")
          .Append(name).Append(" with name '{name}'.\");\n\n");

        sb.Append(Indent).Append("public static ").Append(name).Append(" FromValue(int value) =>\n");
        sb.Append(Indent).Append(Indent).Append("All.FirstOrDefault(e => e.Value == value)\n");
        sb.Append(Indent).Append(Indent).Append("?? throw new ArgumentOutOfRangeException(nameof(value), $\"No ")
          .Append(name).Append(" with value {value}.\");\n\n");

        sb.Append(Indent).Append("public override string ToString() => Name;\n");
        sb.Append(Indent).Append("public bool Equals(").Append(name).Append("? other) => other is not null && Value == other.Value;\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj) => Equals(obj as ").Append(name).Append(");\n");
        sb.Append(Indent).Append("public override int GetHashCode() => Value;\n");
        sb.Append(Indent).Append("public static bool operator ==(").Append(name).Append("? left, ").Append(name)
          .Append("? right) => left is null ? right is null : left.Equals(right);\n");
        sb.Append(Indent).Append("public static bool operator !=(").Append(name).Append("? left, ").Append(name)
          .Append("? right) => !(left == right);\n");

        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(ns)}/{name}.cs", Assemble(ns, sb.ToString(), usesLinq: true));
    }

    // ----------------------------------------------------------------------
    // Domain events
    // ----------------------------------------------------------------------

    private static bool HasEvents(KoineModel model) =>
        model.Contexts.SelectMany(AllTypeDecls).Any(t => t is EventDecl);

    /// <summary>
    /// True when the model emits at least one value object: an explicit
    /// <c>value</c> type, or an entity (whose strongly-typed ID is a value object).
    /// Gates emission of the <see cref="ValueObject"/> base class.
    /// </summary>
    private static bool NeedsValueObjects(KoineModel model) =>
        model.Contexts.SelectMany(AllTypeDecls).Any(t => t is ValueObjectDecl or EntityDecl);

    /// <summary>
    /// Emits a domain event as an immutable <c>sealed record</c> implementing
    /// <c>IDomainEvent</c>, with get-only fields, value equality, and an
    /// <c>OccurredOn</c> timestamp defaulted at construction.
    /// </summary>
    private EmittedFile EmitEvent(
        EventDecl ev,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var translator = new CSharpExpressionTranslator(index, ev.Members, enumMemberToType);
        var ctorMembers = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = ev.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, ev.Doc, "");
        sb.Append("public sealed record ").Append(ev.Name).Append(" : IDomainEvent\n{\n");

        foreach (var m in ctorMembers)
        {
            var csType = typeMapper.Map(m.Type, out var comment);
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Occurrence metadata, defaulted at construction (part of value equality).
        sb.Append(Indent).Append("public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;\n");

        sb.Append('\n');
        WriteConstructor(sb, ev.Name, ctorMembers, Array.Empty<Invariant>(), memberNames, translator, typeMapper, enumMemberToType, index);

        foreach (var m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" => ").Append(body).Append(";\n");
        }

        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(ns)}/{ev.Name}.cs",
            Assemble(ns, sb.ToString(), UsesLinq(ev.Members, Array.Empty<Invariant>())));
    }

    // ----------------------------------------------------------------------
    // Constructors + invariants
    // ----------------------------------------------------------------------

    private void WriteConstructor(
        StringBuilder sb,
        string typeName,
        IReadOnlyList<Member> ctorMembers,
        IReadOnlyList<Invariant> invariants,
        ISet<string> memberNames,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType,
        ModelIndex index)
    {
        sb.Append(Indent).Append("public ").Append(typeName).Append('(');
        sb.Append(string.Join(", ", OrderCtorParams(ctorMembers).Select(m => FormatParam(m, typeMapper, translator, index))));
        sb.Append(")\n");
        sb.Append(Indent).Append("{\n");

        WriteEnumDefaultCoalesce(sb, ctorMembers, translator, index);
        WriteInvariantGuards(sb, typeName, invariants, translator);
        if (invariants.Count > 0 && ctorMembers.Count > 0)
            sb.Append('\n');

        foreach (var m in ctorMembers)
            WriteAssignment(sb, m, typeMapper);

        sb.Append(Indent).Append("}\n");
    }

    private void WriteEntityConstructor(
        StringBuilder sb,
        EntityDecl entity,
        IReadOnlyList<Member> ctorMembers,
        ISet<string> memberNames,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType,
        ModelIndex index)
    {
        var allParams = new List<string> { $"{entity.IdentityName} id" };
        allParams.AddRange(OrderCtorParams(ctorMembers).Select(m => FormatParam(m, typeMapper, translator, index)));

        sb.Append(Indent).Append("public ").Append(entity.Name).Append('(')
          .Append(string.Join(", ", allParams)).Append(")\n");
        sb.Append(Indent).Append("{\n");

        WriteEnumDefaultCoalesce(sb, ctorMembers, translator, index);
        WriteInvariantGuards(sb, entity.Name, entity.Invariants, translator);
        if (entity.Invariants.Count > 0)
            sb.Append('\n');

        sb.Append(Indent).Append(Indent).Append("Id = id;\n");
        foreach (var m in ctorMembers)
            WriteAssignment(sb, m, typeMapper);

        sb.Append(Indent).Append("}\n");
    }

    private string FormatParam(Member m, CSharpTypeMapper typeMapper, CSharpExpressionTranslator translator, ModelIndex index)
    {
        var csType = typeMapper.Map(m.Type);
        var paramName = CSharpNaming.ToCamelCase(m.Name);
        var param = $"{csType} {paramName}";

        // DEFAULT-valued members keep a C# default value.
        if (m.Initializer is not null)
        {
            // A smart-enum value is NOT a compile-time constant, so an enum-typed
            // default can't be a parameter default; the param becomes nullable and
            // the body coalesces to the real default (see WriteAssignment).
            if (index.Classify(m.Type.Name) == TypeKind.Enum)
            {
                var nullableType = csType.EndsWith('?') ? csType : csType + "?";
                return $"{nullableType} {paramName} = null";
            }

            var def = translator.Translate(m.Initializer, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            param += $" = {def}";
        }
        else if (m.Type.IsOptional)
        {
            // An optional field with no initializer defaults to null (omittable).
            param += " = null";
        }
        return param;
    }

    private void WriteAssignment(StringBuilder sb, Member m, CSharpTypeMapper typeMapper)
    {
        var prop = CSharpNaming.ToPascalCase(m.Name);
        var param = CSharpNaming.ToCamelCase(m.Name);
        sb.Append(Indent).Append(Indent).Append(prop).Append(" = ")
          .Append(CopyExpression(m.Type, param, typeMapper)).Append(";\n");
    }

    /// <summary>
    /// Emits <c>param ??= Enum.Default;</c> for each enum-typed defaulted member, so
    /// the (nullable) parameter holds its real default before invariant guards and
    /// assignments run. A smart-enum value can't be a compile-time parameter default.
    /// </summary>
    private void WriteEnumDefaultCoalesce(StringBuilder sb, IReadOnlyList<Member> ctorMembers,
        CSharpExpressionTranslator translator, ModelIndex index)
    {
        var any = false;
        foreach (var m in ctorMembers)
        {
            if (m.Initializer is null || index.Classify(m.Type.Name) != TypeKind.Enum)
                continue;
            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToCamelCase(m.Name))
              .Append(" ??= ").Append(EnumDefaultValue(m, translator, index)).Append(";\n");
            any = true;
        }
        if (any)
            sb.Append('\n');
    }

    /// <summary>The qualified C# default value for an enum-typed defaulted member.</summary>
    private static string EnumDefaultValue(Member m, CSharpExpressionTranslator translator, ModelIndex index) =>
        m.Initializer is IdentifierExpr enumDefault
            ? $"{m.Type.Name}.{enumDefault.Name}"
            : translator.Translate(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, m.Type.Name);

    /// <summary>
    /// The right-hand side that assigns a parameter to its property, defensively
    /// copying mutable collections. An optional collection is copied only when
    /// non-null.
    /// </summary>
    private static string CopyExpression(TypeRef type, string param, CSharpTypeMapper typeMapper)
    {
        string? ctor = null;
        if (CSharpTypeMapper.IsList(type))
            ctor = $"new List<{typeMapper.Map(type.Element ?? ObjectType)}>";
        else if (CSharpTypeMapper.IsSet(type))
            ctor = $"new HashSet<{typeMapper.Map(type.Element ?? ObjectType)}>";
        else if (CSharpTypeMapper.IsMap(type))
            ctor = $"new Dictionary<{typeMapper.Map(type.Element ?? ObjectType)}, {typeMapper.Map(type.Value ?? ObjectType)}>";

        if (ctor is null)
            return param; // scalar: direct assignment

        var copy = $"{ctor}({param})";
        return type.IsOptional ? $"{param} is null ? null : {copy}" : copy;
    }

    private static readonly TypeRef ObjectType = new("object");

    /// <summary>
    /// Orders constructor parameters so those with a C# default value (constant
    /// defaults and optional <c>= null</c> fields) come last, as C# requires.
    /// Within each group declaration order is preserved (stable sort).
    /// </summary>
    private static IEnumerable<Member> OrderCtorParams(IEnumerable<Member> members) =>
        members.OrderBy(m => HasCtorDefault(m) ? 1 : 0);

    private static bool HasCtorDefault(Member m) => m.Initializer is not null || m.Type.IsOptional;

    private void WriteInvariantGuards(
        StringBuilder sb,
        string typeName,
        IReadOnlyList<Invariant> invariants,
        CSharpExpressionTranslator translator,
        CSharpExpressionTranslator.NameMode mode = CSharpExpressionTranslator.NameMode.Parameter)
    {
        var first = true;
        foreach (var inv in invariants)
        {
            if (!first)
                sb.Append('\n');
            first = false;
            WriteGuard(sb, typeName, inv.Condition, inv.Message ?? SynthesizeMessage(inv.Condition), translator, mode);
        }
    }

    /// <summary>
    /// Emits a single throwing guard: <c>if (!(cond)) throw DomainInvariantViolationException(...)</c>.
    /// Shared by constructor invariants (Parameter mode), command <c>requires</c>
    /// preconditions, and post-transition invariant re-checks (Property mode).
    /// </summary>
    private void WriteGuard(
        StringBuilder sb,
        string typeName,
        Expr condition,
        string rule,
        CSharpExpressionTranslator translator,
        CSharpExpressionTranslator.NameMode mode)
    {
        var ruleLiteral = "\"" + rule.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

        if (condition is GuardExpr guard)
        {
            var cond = translator.TranslateTopLevel(guard.Condition, mode);
            var body = translator.TranslateTopLevel(guard.Body, mode);
            sb.Append(Indent).Append(Indent)
              .Append("if (").Append(cond).Append(" && !(").Append(body).Append("))\n");
        }
        else if (condition is MatchExpr)
        {
            // raw matches /pat/  ->  if (!Regex.IsMatch(raw, @"pat"))
            var cond = translator.Translate(condition, mode);
            sb.Append(Indent).Append(Indent).Append("if (!").Append(cond).Append(")\n");
        }
        else
        {
            var cond = translator.TranslateTopLevel(condition, mode);
            sb.Append(Indent).Append(Indent).Append("if (!(").Append(cond).Append("))\n");
        }

        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("type: nameof(").Append(typeName).Append("),\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("rule: ").Append(ruleLiteral).Append(");\n");
    }

    /// <summary>The member names mutated by at least one command transition (get <c>private set</c>).</summary>
    private static ISet<string> MutatedFields(EntityDecl entity) =>
        new HashSet<string>(
            entity.Commands
                .SelectMany(c => c.Body)
                .OfType<Transition>()
                .Select(t => t.Field),
            StringComparer.Ordinal);

    /// <summary>Emits a command as a public method: preconditions, transitions, then an invariant re-check.</summary>
    private void WriteCommand(
        StringBuilder sb,
        EntityDecl entity,
        CommandDecl cmd,
        CSharpExpressionTranslator translator,
        CSharpTypeMapper typeMapper,
        ModelIndex index)
    {
        var memberTypes = entity.Members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
        var paramList = string.Join(", ", cmd.Parameters.Select(p =>
            $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));

        sb.Append('\n');
        WriteXmlDoc(sb, cmd.Doc, Indent);
        sb.Append(Indent).Append("public void ").Append(CSharpNaming.ToPascalCase(cmd.Name))
          .Append('(').Append(paramList).Append(")\n");
        sb.Append(Indent).Append("{\n");

        // Command parameters are locals inside the body (members render as properties).
        foreach (var p in cmd.Parameters) translator.PushLocal(p.Name);

        var requires = cmd.Body.OfType<RequiresClause>().ToList();
        var transitions = cmd.Body.OfType<Transition>().ToList();
        var emits = cmd.Body.OfType<EmitClause>().ToList();

        // 1. Preconditions — checked before any mutation.
        var firstGuard = true;
        foreach (var req in requires)
        {
            if (!firstGuard) sb.Append('\n');
            firstGuard = false;
            WriteGuard(sb, entity.Name, req.Condition, req.Message ?? SynthesizeMessage(req.Condition),
                translator, CSharpExpressionTranslator.NameMode.Property);
        }

        // 2. State transitions.
        if (requires.Count > 0 && transitions.Count > 0) sb.Append('\n');
        foreach (var tr in transitions)
        {
            var expectedEnum = memberTypes.TryGetValue(tr.Field, out var ft) && index.Classify(ft.Name) == TypeKind.Enum
                ? ft.Name : null;

            // A state machine on this field guards the (literal) target's reachability.
            if (expectedEnum is not null)
                WriteStateMachineGuard(sb, entity, tr, expectedEnum, translator, index, cmd.Parameters);

            var value = translator.TranslateTopLevel(tr.Value, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
            sb.Append(Indent).Append(Indent).Append(CSharpNaming.ToPascalCase(tr.Field))
              .Append(" = ").Append(value).Append(";\n");
        }

        // Translate the emit statements while parameters are still in scope (their
        // payloads may reference parameters); they are written AFTER the re-check so
        // an invalid post-state throws before any event is recorded.
        var emitStatements = emits.Select(e => BuildEmitStatement(e, translator, index)).ToList();

        // Parameters leave scope BEFORE the re-check: entity invariants reference
        // only entity state, which must render as the just-assigned properties (not
        // a parameter that happens to share a field's name).
        foreach (var p in cmd.Parameters) translator.PopLocal(p.Name);

        // 3. Re-check every entity invariant after the state change.
        if (transitions.Count > 0 && entity.Invariants.Count > 0)
        {
            sb.Append('\n');
            WriteInvariantGuards(sb, entity.Name, entity.Invariants, translator,
                CSharpExpressionTranslator.NameMode.Property);
        }

        // 4. Record domain events (only reached if preconditions + re-check pass).
        if (emitStatements.Count > 0)
        {
            sb.Append('\n');
            foreach (var stmt in emitStatements)
                sb.Append(Indent).Append(Indent).Append(stmt).Append('\n');
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits a reachability guard for a state-machine-governed transition with a
    /// literal target: the current state must be a source that can reach the target
    /// (optionally satisfying that rule's guard), else throw.
    /// </summary>
    private void WriteStateMachineGuard(
        StringBuilder sb, EntityDecl entity, Transition tr, string enumType,
        CSharpExpressionTranslator translator, ModelIndex index, IReadOnlyList<Param> commandParams)
    {
        var states = entity.States.FirstOrDefault(s => s.Field == tr.Field);
        if (states is null || tr.Value is not IdentifierExpr stateRef
            || !index.EnumsDeclaring(stateRef.Name).Contains(enumType))
            return; // no state machine, or a dynamic (non-literal) target

        var sources = states.Rules.Where(r => r.To.Contains(stateRef.Name)).ToList();
        if (sources.Count == 0)
            return; // unreachable target — already a semantic error (KOI0703)

        var prop = CSharpNaming.ToPascalCase(tr.Field);

        // A state-rule guard is validated against entity members only, so it must
        // render with command parameters out of scope: a parameter sharing a member's
        // name would otherwise shadow it (and be read instead of the persisted state).
        foreach (var p in commandParams) translator.PopLocal(p.Name);
        var conditions = sources.Select(r =>
        {
            var c = $"{prop} == {enumType}.{r.From}";
            if (r.Guard is not null)
                // Translate (not TranslateTopLevel) so a binary guard keeps its parentheses:
                // an OR guard must bind below the && that joins it to the source check.
                c = $"{c} && {translator.Translate(r.Guard, CSharpExpressionTranslator.NameMode.Property)}";
            return $"({c})";
        }).ToList();
        foreach (var p in commandParams) translator.PushLocal(p.Name);

        sb.Append(Indent).Append(Indent).Append("if (!(").Append(string.Join(" || ", conditions)).Append("))\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: nameof(").Append(entity.Name).Append("),\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent)
          .Append("rule: \"illegal transition of ").Append(tr.Field).Append(" to ").Append(stateRef.Name).Append("\");\n");
    }

    /// <summary>Builds the <c>_domainEvents.Add(new EventName(...));</c> statement for an emit.</summary>
    private string BuildEmitStatement(EmitClause emit, CSharpExpressionTranslator translator, ModelIndex index)
    {
        if (!index.TryGetDecl(emit.EventName, out var decl) || decl is not EventDecl ev)
            return $"/* unknown event '{emit.EventName}' */";

        var eventMemberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        // Match the constructor's parameter order (OrderCtorParams moves defaulted/
        // optional fields last), not the declaration order, so positional args bind.
        var ctorFields = OrderCtorParams(ev.Members.Where(m => !MemberAnalysis.IsDerived(m, eventMemberNames))).ToList();
        var argByField = emit.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);

        var args = ctorFields.Select(f =>
        {
            if (!argByField.TryGetValue(f.Name, out var value))
                return "default!"; // validator guarantees presence; defensive
            var expectedEnum = index.Classify(f.Type.Name) == TypeKind.Enum ? f.Type.Name : null;
            return translator.TranslateTopLevel(value, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
        });

        return $"_domainEvents.Add(new {ev.Name}({string.Join(", ", args)}));";
    }

    /// <summary>Synthesizes a readable rule message from an unmessaged invariant.</summary>
    private static string SynthesizeMessage(Expr condition) => SourceText(condition);

    private static string SourceText(Expr expr) => expr switch
    {
        IdentifierExpr id => id.Name,
        LiteralExpr lit => lit.Kind == LiteralKind.String ? $"\"{lit.Text}\"" : lit.Text,
        MemberAccessExpr ma => $"{SourceText(ma.Target)}.{ma.MemberName}",
        CallExpr c => $"{SourceText(c.Target)}.{c.Method}({string.Join(", ", c.Args.Select(SourceText))})",
        LambdaExpr l => $"{l.Parameter} => {SourceText(l.Body)}",
        ConditionalExpr cd => $"if {SourceText(cd.Condition)} then {SourceText(cd.Then)} else {SourceText(cd.Else)}",
        UnaryExpr u => (u.Op == UnaryOp.Not ? "not " : "-") + SourceText(u.Operand),
        BinaryExpr b => $"{SourceText(b.Left)} {SourceOp(b.Op)} {SourceText(b.Right)}",
        MatchExpr m => $"{SourceText(m.Target)} matches /{m.Pattern}/",
        GuardExpr g => $"{SourceText(g.Body)} when {SourceText(g.Condition)}",
        _ => "invariant"
    };

    private static string SourceOp(BinaryOp op) => op switch
    {
        BinaryOp.Or => "or",
        BinaryOp.And => "and",
        BinaryOp.Eq => "==",
        BinaryOp.Neq => "!=",
        BinaryOp.Lt => "<",
        BinaryOp.Le => "<=",
        BinaryOp.Gt => ">",
        BinaryOp.Ge => ">=",
        BinaryOp.Add => "+",
        BinaryOp.Sub => "-",
        BinaryOp.Mul => "*",
        BinaryOp.Div => "/",
        _ => "?"
    };

    // ----------------------------------------------------------------------
    // Runtime support
    // ----------------------------------------------------------------------

    private const string RuntimeNamespace = "Koine.Runtime";

    private EmittedFile EmitRuntimeException()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Thrown when a domain invariant or illegal state transition is violated.</summary>\n");
        sb.Append("public sealed class DomainInvariantViolationException : Exception\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public string TypeName { get; }\n");
        sb.Append(Indent).Append("public string Rule { get; }\n\n");
        sb.Append(Indent).Append("public DomainInvariantViolationException(string type, string rule)\n");
        sb.Append(Indent).Append(Indent)
          .Append(": base($\"Invariant violated on {type}: {rule}\") { TypeName = type; Rule = rule; }\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/DomainInvariantViolationException.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    private EmittedFile EmitAggregateRootInterface()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Marks an entity as the consistency boundary (root) of an aggregate.</summary>\n");
        sb.Append("public interface IAggregateRoot { }\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IAggregateRoot.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    private EmittedFile EmitDomainEventInterface()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>A fact that happened in the domain, recorded by an aggregate.</summary>\n");
        sb.Append("public interface IDomainEvent\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("DateTimeOffset OccurredOn { get; }\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IDomainEvent.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the canonical DDD <c>ValueObject</c> base class: structural equality
    /// driven by each derived type's <c>GetEqualityComponents()</c>. Value objects
    /// are immutable classes (not records) so every instance is funneled through a
    /// guarded constructor and can never exist in an invalid state.
    /// </summary>
    private EmittedFile EmitValueObjectBase()
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Base class for value objects: equality by component value, not reference.</summary>\n");
        sb.Append("public abstract class ValueObject\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("/// <summary>The values that define this value object's identity, in order.</summary>\n");
        sb.Append(Indent).Append("protected abstract IEnumerable<object?> GetEqualityComponents();\n\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("if (obj is null || obj.GetType() != GetType())\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return false;\n");
        sb.Append(Indent).Append(Indent).Append("return GetEqualityComponents().SequenceEqual(((ValueObject)obj).GetEqualityComponents());\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("var hash = new HashCode();\n");
        sb.Append(Indent).Append(Indent).Append("foreach (var component in GetEqualityComponents())\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("hash.Add(component);\n");
        sb.Append(Indent).Append(Indent).Append("return hash.ToHashCode();\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("public static bool operator ==(ValueObject? left, ValueObject? right) =>\n");
        sb.Append(Indent).Append(Indent).Append("left is null ? right is null : left.Equals(right);\n\n");
        sb.Append(Indent).Append("public static bool operator !=(ValueObject? left, ValueObject? right) => !(left == right);\n\n");
        // Collection-typed fields must contribute by their CONTENT, not the wrapper
        // reference. Lists compare order-sensitively; sets and maps order-insensitively.
        sb.Append(Indent).Append("/// <summary>Wraps an ordered collection (list) as a by-element equality component.</summary>\n");
        sb.Append(Indent).Append("protected static object? Ordered(System.Collections.IEnumerable? items) =>\n");
        sb.Append(Indent).Append(Indent).Append("items is null ? null : new SequenceComponent(items, ordered: true);\n\n");
        sb.Append(Indent).Append("/// <summary>Wraps an unordered collection (set/map) as a by-element equality component.</summary>\n");
        sb.Append(Indent).Append("protected static object? Unordered(System.Collections.IEnumerable? items) =>\n");
        sb.Append(Indent).Append(Indent).Append("items is null ? null : new SequenceComponent(items, ordered: false);\n\n");
        sb.Append(Indent).Append("private sealed class SequenceComponent\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("private readonly List<object?> _items = new();\n");
        sb.Append(Indent).Append(Indent).Append("private readonly bool _ordered;\n\n");
        sb.Append(Indent).Append(Indent).Append("public SequenceComponent(System.Collections.IEnumerable items, bool ordered)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("_ordered = ordered;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in items) _items.Add(item);\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (obj is not SequenceComponent other || _items.Count != other._items.Count)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return false;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return _ordered\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("? _items.SequenceEqual(other._items)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append(": _items.All(x => _items.Count(i => Equals(i, x)) == other._items.Count(i => Equals(i, x)));\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (_ordered)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("var hash = new HashCode();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in _items) hash.Add(item);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return hash.ToHashCode();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var acc = 0;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in _items) acc ^= item?.GetHashCode() ?? 0;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return acc;\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/ValueObject.cs",
            Assemble(RuntimeNamespace, sb.ToString(), usesLinq: true));
    }

    // ----------------------------------------------------------------------
    // File header (using block + namespace)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Wraps an emitted type body with the canonical generated-file preamble: an
    /// <c>&lt;auto-generated/&gt;</c> marker (so IDE/style analyzers skip the file),
    /// only the <c>using</c> directives the body actually needs, and the namespace.
    /// Usings are derived by scanning the body rather than a fixed block, so files
    /// carry no unused imports. LINQ is passed in because <c>.Count</c> (a property)
    /// and <c>.Count()</c> (a LINQ call) are not distinguishable by a token scan.
    /// </summary>
    private string Assemble(string ns, string body, bool usesLinq)
    {
        var usings = new List<string>();
        void Need(bool condition, string ns2) { if (condition && !usings.Contains(ns2)) usings.Add(ns2); }

        Need(body.Contains("Guid") || body.Contains("DateTimeOffset")
             || body.Contains("IEquatable") || body.Contains("new HashCode(")
             || body.Contains(": Exception") || body.Contains("ArgumentOutOfRangeException")
             || body.Contains("ArgumentNullException") || body.Contains("InvalidOperationException"), "System");
        Need(body.Contains("IEnumerable<") || body.Contains("IReadOnlyList<") || body.Contains("List<")
             || body.Contains("IReadOnlySet<") || body.Contains("HashSet<")
             || body.Contains("IReadOnlyDictionary<") || body.Contains("Dictionary<"), "System.Collections.Generic");
        Need(usesLinq, "System.Linq");
        Need(body.Contains("Regex"), "System.Text.RegularExpressions");
        Need(ns != "Koine.Runtime"
             && (body.Contains("ValueObject") || body.Contains("IAggregateRoot")
                 || body.Contains("IDomainEvent") || body.Contains("DomainInvariantViolationException")), "Koine.Runtime");

        // Other contexts are separate namespaces. Foreign-context types are emitted
        // unqualified, so the import must always be present for a cross-context
        // reference to resolve; an unused one is silenced by the <auto-generated/> header.
        // The context-agnostic runtime files never reference user contexts.
        if (ns != "Koine.Runtime")
            foreach (var other in _contextNames)
                Need(other != ns, other);

        var sb = new StringBuilder();
        sb.Append("// <auto-generated/>\n");
        // Generated files opt out of the project's nullable context, so re-enable it
        // explicitly — our signatures use nullable annotations (e.g. string?, object?).
        sb.Append("#nullable enable\n\n");
        foreach (var u in usings.OrderBy(UsingSortKey, StringComparer.Ordinal).ThenBy(u => u, StringComparer.Ordinal))
            sb.Append("using ").Append(u).Append(";\n");
        if (usings.Count > 0)
            sb.Append('\n');
        sb.Append("namespace ").Append(ns).Append(";\n\n");
        sb.Append(body);
        return sb.ToString();
    }

    // System and System.* sort before everything else, mirroring the default
    // "System directives first" using-ordering.
    private static string UsingSortKey(string ns) =>
        ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal) ? "0" + ns : "1" + ns;

    /// <summary>The declared enum type of an enum-typed member (hint for qualifying bare members), else null.</summary>
    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;

    /// <summary>True when any emitted expression for an entity (incl. commands) uses a LINQ-backed op.</summary>
    private static bool EntityUsesLinq(EntityDecl e) =>
        UsesLinq(e.Members, e.Invariants)
        || e.Commands.SelectMany(c => c.Body).Any(s => s switch
        {
            RequiresClause r => ExprUsesLinq(r.Condition),
            Transition t => ExprUsesLinq(t.Value),
            EmitClause em => em.Args.Any(a => ExprUsesLinq(a.Value)),
            _ => false
        })
        || e.States.SelectMany(s => s.Rules).Any(r => r.Guard is not null && ExprUsesLinq(r.Guard));

    /// <summary>True when any emitted expression for the type uses a LINQ-backed op.</summary>
    private static bool UsesLinq(IEnumerable<Member> members, IEnumerable<Invariant> invariants) =>
        members.Any(m => m.Initializer is not null && ExprUsesLinq(m.Initializer))
        || invariants.Any(inv => ExprUsesLinq(inv.Condition));

    private static bool ExprUsesLinq(Expr expr) => expr switch
    {
        CallExpr c => BuiltinOps.TakesLambda(c.Method) || c.Method == "contains"
                      || ExprUsesLinq(c.Target) || c.Args.Any(ExprUsesLinq),
        LambdaExpr l => ExprUsesLinq(l.Body),
        BinaryExpr b => ExprUsesLinq(b.Left) || ExprUsesLinq(b.Right),
        UnaryExpr u => ExprUsesLinq(u.Operand),
        MemberAccessExpr ma => ExprUsesLinq(ma.Target),
        ConditionalExpr cd => ExprUsesLinq(cd.Condition) || ExprUsesLinq(cd.Then) || ExprUsesLinq(cd.Else),
        GuardExpr g => ExprUsesLinq(g.Body) || ExprUsesLinq(g.Condition),
        MatchExpr m => ExprUsesLinq(m.Target),
        _ => false
    };

    /// <summary>Renders a target-agnostic doc string as a C# XML <c>&lt;summary&gt;</c>.</summary>
    private static void WriteXmlDoc(StringBuilder sb, string? doc, string indent)
    {
        if (string.IsNullOrEmpty(doc))
            return;

        var lines = doc.Split('\n');
        if (lines.Length == 1)
        {
            sb.Append(indent).Append("/// <summary>").Append(EscapeXml(lines[0])).Append("</summary>\n");
            return;
        }

        sb.Append(indent).Append("/// <summary>\n");
        foreach (var line in lines)
            sb.Append(indent).Append("/// ").Append(EscapeXml(line)).Append('\n');
        sb.Append(indent).Append("/// </summary>\n");
    }

    private static string EscapeXml(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

    private static void AppendComment(StringBuilder sb, string? comment)
    {
        if (!string.IsNullOrEmpty(comment))
            sb.Append("  // ").Append(comment);
    }

    /// <summary>Maps a namespace to its emit folder path.</summary>
    private static string FolderFor(string ns) => ns.Replace('.', '/');

    // ----------------------------------------------------------------------
    // ID ownership
    // ----------------------------------------------------------------------

    /// <summary>Map from an owned ID type name to the entity declaration that owns it.</summary>
    private static Dictionary<string, EntityDecl> BuildIdOwnership(ContextNode ctx)
    {
        var owned = new Dictionary<string, EntityDecl>(StringComparer.Ordinal);
        foreach (var e in AllEntities(ctx))
            owned[e.IdentityName] = e;
        return owned;
    }

    /// <summary>
    /// ID names referenced anywhere in the context that are not owned by an entity
    /// nor otherwise declared, in deterministic (sorted) order.
    /// </summary>
    private static IEnumerable<string> OrderedUnownedIds(
        ContextNode ctx,
        ModelIndex index,
        IReadOnlyDictionary<string, EntityDecl> owned)
    {
        var seen = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var idName in index.IdTypeNames)
        {
            if (owned.ContainsKey(idName))
                continue;
            // Only emit it if it is referenced within this context.
            if (IsReferencedInContext(ctx, idName))
                seen.Add(idName);
        }
        return seen;
    }

    private static bool IsReferencedInContext(ContextNode ctx, string idName)
    {
        foreach (var t in AllTypeDecls(ctx))
        {
            IReadOnlyList<Member>? members = t switch
            {
                ValueObjectDecl v => v.Members,
                EntityDecl e => e.Members,
                _ => null
            };
            if (members is null) continue;
            foreach (var m in members)
                if (TypeRefMentions(m.Type, idName))
                    return true;
        }
        return false;
    }

    private static bool TypeRefMentions(TypeRef type, string name)
    {
        if (type.Name == name) return true;
        return (type.Element is not null && TypeRefMentions(type.Element, name))
            || (type.Value is not null && TypeRefMentions(type.Value, name));
    }

    private static IEnumerable<EntityDecl> AllEntities(ContextNode ctx)
    {
        foreach (var t in AllTypeDecls(ctx))
            if (t is EntityDecl e)
                yield return e;
    }

    private static IEnumerable<TypeDecl> AllTypeDecls(ContextNode ctx)
    {
        foreach (var t in ctx.Types)
        {
            yield return t;
            if (t is AggregateDecl agg)
                foreach (var nested in agg.Types)
                    yield return nested;
        }
    }

    // ----------------------------------------------------------------------
    // Enum member map
    // ----------------------------------------------------------------------

    /// <summary>
    /// Maps every enum member name to its owning enum type name so identifiers
    /// like <c>Draft</c> render as <c>OrderStatus.Draft</c>.
    /// </summary>
    private static Dictionary<string, string> BuildEnumMemberMap(KoineModel model)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var ctx in model.Contexts)
            foreach (var t in AllTypeDecls(ctx))
                if (t is EnumDecl e)
                    foreach (var member in e.Members)
                        map[member] = e.Name; // last writer wins; v0 assumes unique members
        return map;
    }
}
