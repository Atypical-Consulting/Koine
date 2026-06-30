using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// Demand-driven analysis that decides which non-quantity value objects need generated
/// arithmetic operators (R9). A value object's <c>+</c>/<c>*</c> operators are emitted
/// ONLY where the model actually folds it with <c>sum</c> or multiplies it by a scalar,
/// so the C# emitter never emits operators no one calls.
///
/// <para>Pure and stateless: every method derives its result from the model alone, so the
/// scans are easy to test and reason about independently of the emitter's mutable wiring.</para>
/// </summary>
internal static class OperatorNeedsAnalyzer
{
    /// <summary>
    /// Scans every derived member initializer in the model for
    /// <c>value-object * scalar</c> multiplications and records, per value-object
    /// type, which scalar C# types ("int"/"decimal") it is multiplied by. Only
    /// those operators are generated, so we never emit spurious (or non-compiling)
    /// operators on value objects that are never multiplied.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarOperatorNeeds(KoineModel model, ModelIndex index) =>
        BuildScalarOpNeeds(model, index, BinaryOp.Mul);

    /// <summary>
    /// The division sibling of <see cref="BuildScalarOperatorNeeds"/>: scans the same sites for
    /// <c>value-object / scalar</c> and records, per value-object type, which scalar C# types
    /// ("int"/"decimal") it is divided by. Drives demand-driven <c>operator /</c> generation (#832) —
    /// the natural dual of scalar multiplication. Division is non-commutative, so only the
    /// value-object-on-the-left form is recorded; <c>scalar / value-object</c> would divide a scalar
    /// <i>by</i> the value object, which is not a value-object operator, so it is deliberately not
    /// recorded (its reversed-operand emission is a separate concern, out of scope here).
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarDivisionNeeds(KoineModel model, ModelIndex index) =>
        BuildScalarOpNeeds(model, index, BinaryOp.Div);

    /// <summary>
    /// Shared core for the scalar <c>*</c> / <c>/</c> demand analyses: walks every expression site
    /// (<see cref="ExpressionScanSites"/>) recording, per value-object type, the scalar C# types it is
    /// combined with under <paramref name="op"/>. Mul and Div run the identical site enumeration; only
    /// the operator (and division's left-only operand rule) differs, so the enumeration lives in one
    /// place — the same enumerator the additive/binary analyses use, so all the demand analyses scan one
    /// shared site list rather than two parallel copies (#836).
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarOpNeeds(KoineModel model, ModelIndex index, BinaryOp op)
    {
        var needs = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

        foreach ((Expr expr, TypeScope scope) in ExpressionScanSites(model, index))
        {
            new ScalarOpWalker(op, scope, index, needs).Visit(expr);
        }

        return needs.ToDictionary(kv => kv.Key, kv => (IReadOnlySet<string>)kv.Value, StringComparer.Ordinal);
    }

    /// <summary>
    /// Scans every member initializer for a value-object <c>sum</c> selector (e.g.
    /// <c>lines.sum(l =&gt; l.subtotal)</c> producing a <c>Money</c>) and records the
    /// value-object types that therefore need an additive operator.
    /// </summary>
    public static IReadOnlySet<string> BuildAdditiveOperatorNeeds(KoineModel model, ModelIndex index)
    {
        var resolver = new TypeResolver(index);
        var needs = new HashSet<string>(StringComparer.Ordinal);

        foreach ((Expr expr, TypeScope scope) in ExpressionScanSites(model, index))
        {
            ScanForValueObjectSum(expr, scope, resolver, needs);
        }

        return needs;
    }

    /// <summary>
    /// Scans every member initializer (and the other expression sites) for a plain
    /// <c>value-object <b>+</b>/<b>-</b> value-object</c> binary arithmetic — e.g.
    /// <c>combined: Money = base + base</c> — and records, per value-object type, which additive
    /// operators it participates in. This is the binary-operator sibling of
    /// <see cref="BuildAdditiveOperatorNeeds"/> (which only fires on a <c>sum(selector)</c> fold): a
    /// value object used directly in <c>+</c>/<c>-</c> needs an <c>add</c>/<c>subtract</c> method too,
    /// otherwise the lowered call site (<c>$vo-&gt;add(...)</c>) targets a method that was never
    /// generated. A guard-narrowed optional operand still infers as the same value type, so it is
    /// recorded here as well (its emission need is identical; only the call-site routing differs).
    /// Target-agnostic like the rest of this analyzer: the PHP emitter generates its <c>add</c>/<c>subtract</c>
    /// methods from this map, and the C# emitter consumes it (alongside <see cref="BuildAdditiveOperatorNeeds"/>)
    /// to demand-generate direct <c>operator +</c>/<c>operator -</c> for plain value objects (#833).
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlySet<BinaryOp>> BuildValueObjectArithmeticNeeds(KoineModel model, ModelIndex index)
    {
        var resolver = new TypeResolver(index);
        var needs = new Dictionary<string, HashSet<BinaryOp>>(StringComparer.Ordinal);

        foreach ((Expr expr, TypeScope scope) in ExpressionScanSites(model, index))
        {
            new ValueObjectArithmeticWalker(scope, resolver, index, needs).Visit(expr);
        }

        return needs.ToDictionary(kv => kv.Key, kv => (IReadOnlySet<BinaryOp>)kv.Value, StringComparer.Ordinal);
    }

    /// <summary>
    /// Every expression the demand-driven value-object analyses scan, paired with the
    /// <see cref="TypeScope"/> it is resolved in: member initializers, invariant conditions, command
    /// and factory bodies, state-rule guards, service operation bodies, spec conditions, and
    /// read-model field projections. The <b>single</b> site enumerator — the scalar
    /// <c>*</c>/<c>/</c> analyses (<see cref="BuildScalarOpNeeds"/>), the <c>sum</c> fold
    /// (<see cref="BuildAdditiveOperatorNeeds"/>), and the plain binary <c>+</c>/<c>-</c> analysis
    /// (<see cref="BuildValueObjectArithmeticNeeds"/>) all walk it, so the site list lives in one place
    /// and cannot drift between passes (#836).
    /// </summary>
    private static IEnumerable<(Expr Expr, TypeScope Scope)> ExpressionScanSites(KoineModel model, ModelIndex index)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                IReadOnlyList<Member>? members = type switch
                {
                    ValueObjectDecl v => v.Members,
                    EntityDecl e => e.Members,
                    EventDecl ev => ev.Members,
                    _ => null
                };
                if (members is null)
                {
                    continue;
                }

                var scope = TypeScope.FromMembers(members, index);
                foreach (Member m in members)
                {
                    if (m.Initializer is not null)
                    {
                        yield return (m.Initializer, scope);
                    }
                }

                // Invariant conditions over the type's members can also use value-object arithmetic.
                foreach (Invariant inv in Invariants(type))
                {
                    yield return (inv.Condition, scope);
                }

                // Command bodies and state-rule guards can also use value-object arithmetic.
                if (type is EntityDecl entity)
                {
                    foreach (CommandDecl cmd in entity.Commands)
                    {
                        TypeScope cmdScope = cmd.Parameters.Aggregate(scope, (s, p) => s.WithRef(p.Name, p.Type, index));
                        foreach (CommandStmt stmt in cmd.Body)
                        {
                            if (stmt is RequiresClause req)
                            {
                                yield return (req.Condition, cmdScope);
                            }
                            else if (stmt is Transition tr)
                            {
                                yield return (tr.Value, cmdScope);
                            }
                            else if (stmt is EmitClause em)
                            {
                                foreach (EmitArg arg in em.Args)
                                {
                                    yield return (arg.Value, cmdScope);
                                }
                            }
                        }
                    }
                    foreach (FactoryDecl factory in entity.Factories)
                    {
                        TypeScope factScope = factory.Parameters.Aggregate(scope, (s, p) => s.WithRef(p.Name, p.Type, index));
                        foreach (CommandStmt stmt in factory.Body)
                        {
                            if (stmt is RequiresClause req)
                            {
                                yield return (req.Condition, factScope);
                            }
                            else if (stmt is Initialization ini)
                            {
                                yield return (ini.Value, factScope);
                            }
                            else if (stmt is EmitClause em)
                            {
                                foreach (EmitArg arg in em.Args)
                                {
                                    yield return (arg.Value, factScope);
                                }
                            }
                        }
                    }
                    foreach (Expr guard in StateGuards(entity))
                    {
                        yield return (guard, scope);
                    }
                }
            }
        }

        // Service operation bodies can also use value-object arithmetic.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (ServiceDecl svc in ctx.Services)
            {
                foreach (OperationDecl op in svc.Operations)
                {
                    if (op.Body is not null)
                    {
                        yield return (op.Body, TypeScope.FromParams(op.Parameters, index));
                    }
                }
            }
        }

        // Spec conditions (rendered over the target type's members) can use value-object arithmetic too.
        foreach (SpecDecl spec in AllSpecs(model))
        {
            yield return (spec.Condition, TypeScope.FromMembers(SpecTargetMembers(spec.TargetType, index), index));
        }

        // Read-model derived-field projections (over the source type's members) can use value-object arithmetic too.
        foreach ((ReadModelDecl rm, string context) in AllReadModels(model))
        {
            TypeScope scope = TypeScope.FromMembers(ReadModelSourceMembers(context, rm.SourceType, index), index);
            foreach (ReadModelField f in rm.Fields)
            {
                if (f.Projection is not null)
                {
                    yield return (f.Projection, scope);
                }
            }
        }
    }

    private static void ScanForValueObjectSum(Expr expr, TypeScope scope, TypeResolver resolver, HashSet<string> needs) =>
        new ValueObjectSumWalker(scope, resolver, needs).Visit(expr);

    /// <summary>
    /// Records, per value-object type, which additive operators (<see cref="BinaryOp.Add"/> /
    /// <see cref="BinaryOp.Sub"/>) it appears as an operand of in plain binary arithmetic. The scope is
    /// constant for the whole walk; the operand's type is resolved at each binary node. Recurses into
    /// every node, so an arithmetic op nested under <c>??</c>, <c>let</c>, or a guard is still found.
    /// </summary>
    private sealed class ValueObjectArithmeticWalker : ExprWalker
    {
        private readonly TypeScope _scope;
        private readonly TypeResolver _resolver;
        private readonly ModelIndex _index;
        private readonly Dictionary<string, HashSet<BinaryOp>> _needs;

        public ValueObjectArithmeticWalker(
            TypeScope scope, TypeResolver resolver, ModelIndex index, Dictionary<string, HashSet<BinaryOp>> needs)
        {
            _scope = scope;
            _resolver = resolver;
            _index = index;
            _needs = needs;
        }

        protected override void VisitBinary(BinaryExpr n)
        {
            if (n.Op is BinaryOp.Add or BinaryOp.Sub)
            {
                RecordValueObjectOperand(n.Left, n.Op);
                RecordValueObjectOperand(n.Right, n.Op);
            }

            base.VisitBinary(n);
        }

        // A value-object operand of `+`/`-` needs the matching arithmetic method generated on its class.
        // The same predicate the emitter routes on (`Classify == Value`) is used here so the recorded
        // need and the lowered call site agree exactly. Optionality is intentionally ignored — a
        // guard-narrowed optional operand infers as the same value type and needs the method just as much.
        private void RecordValueObjectOperand(Expr operand, BinaryOp op)
        {
            if (_resolver.TypeOf(operand, _scope).Name is { } name && _index.Classify(name) == TypeKind.Value)
            {
                if (!_needs.TryGetValue(name, out HashSet<BinaryOp>? set))
                {
                    _needs[name] = set = new HashSet<BinaryOp>();
                }

                set.Add(op);
            }
        }
    }

    /// <summary>
    /// Records the value-object type folded by any <c>sum(selector)</c> in an expression. The
    /// scope is constant for the whole walk; the element type is bound transiently only to infer
    /// the selector's type at each <c>sum</c>. Recurses into every node, so a <c>sum</c> nested
    /// under <c>??</c> or <c>let</c> is still found.
    /// </summary>
    private sealed class ValueObjectSumWalker : ExprWalker
    {
        private readonly TypeScope _scope;
        private readonly TypeResolver _resolver;
        private readonly HashSet<string> _needs;

        public ValueObjectSumWalker(TypeScope scope, TypeResolver resolver, HashSet<string> needs)
        {
            _scope = scope;
            _resolver = resolver;
            _needs = needs;
        }

        protected override void VisitCall(CallExpr n)
        {
            if (n.Method == "sum" && n.Args is [LambdaExpr lambda])
            {
                if (_resolver.TypeOf(n.Target, _scope).SequenceElement is { } element)
                {
                    KoineType selector = _resolver.TypeOf(lambda.Body, _scope.With(lambda.Parameter, element));
                    if (selector.IsValueLike)
                    {
                        _needs.Add(selector.Name!);
                    }
                }
            }

            base.VisitCall(n);
        }
    }

    /// <summary>The invariant conditions declared on a type (value objects and entities carry them).</summary>
    private static IReadOnlyList<Invariant> Invariants(TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Invariants,
        EntityDecl e => e.Invariants,
        _ => Array.Empty<Invariant>()
    };

    /// <summary>Every read model declared in the model, paired with its declaring context name.</summary>
    private static IEnumerable<(ReadModelDecl ReadModel, string Context)> AllReadModels(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl t in ctx.AllTypeDecls())
            {
                if (t is ReadModelDecl rm)
                {
                    yield return (rm, ctx.Name);
                }
            }
        }
    }

    /// <summary>
    /// The members a read model projects from, mirroring the C# emitter's
    /// <c>ReadModelSourceMembers</c>: entities add the synthetic <c>id</c> unless they already
    /// declare one, and the source type is resolved in the read model's own context first (R13.2).
    /// </summary>
    private static IReadOnlyList<Member> ReadModelSourceMembers(string context, string sourceType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(context, sourceType, out TypeDecl decl) && !index.TryGetDecl(sourceType, out decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Any(m => string.Equals(m.Name, "id", StringComparison.OrdinalIgnoreCase))
                ? e.Members
                : e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }

    /// <summary>Every spec declared in the model (context- and aggregate-scoped).</summary>
    private static IEnumerable<SpecDecl> AllSpecs(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (SpecDecl s in ctx.Specs)
            {
                yield return s;
            }

            foreach (TypeDecl t in ctx.Types)
            {
                if (t is AggregateDecl agg)
                {
                    foreach (SpecDecl s in agg.Specs)
                    {
                        yield return s;
                    }
                }
            }
        }
    }

    /// <summary>The guard expressions of an entity's state-machine rules.</summary>
    private static IEnumerable<Expr> StateGuards(EntityDecl entity) =>
        entity.States.SelectMany(s => s.Rules).Where(r => r.Guard is not null).Select(r => r.Guard!);

    /// <summary>
    /// Records, per value-object type, the scalar C# types it is combined with under a single binary
    /// operator (<see cref="BinaryOp.Mul"/> or <see cref="BinaryOp.Div"/>) anywhere in an expression.
    /// The member-type scope is constant for the whole walk. Recurses into every node, so an operation
    /// nested under <c>??</c> or <c>let</c> is still found.
    ///
    /// <para>Multiplication is commutative, so both <c>value-object * scalar</c> and
    /// <c>scalar * value-object</c> record the same need. Division is not: only
    /// <c>value-object / scalar</c> (the value object on the left) is a meaningful "scale down" and is
    /// recorded; <c>scalar / value-object</c> would divide a scalar <i>by</i> the value object, which is
    /// not a value-object operator, so it is deliberately not recorded here.</para>
    /// </summary>
    private sealed class ScalarOpWalker : ExprWalker
    {
        private readonly BinaryOp _op;
        private readonly TypeScope _scope;
        private readonly ModelIndex _index;
        private readonly Dictionary<string, HashSet<string>> _needs;

        public ScalarOpWalker(
            BinaryOp op,
            TypeScope scope,
            ModelIndex index,
            Dictionary<string, HashSet<string>> needs)
        {
            _op = op;
            _scope = scope;
            _index = index;
            _needs = needs;
        }

        protected override void VisitBinary(BinaryExpr n)
        {
            if (n.Op == _op)
            {
                var (lValue, lScalar) = InferOperand(n.Left, _scope, _index);
                var (rValue, rScalar) = InferOperand(n.Right, _scope, _index);

                // Canonical order `value-object op scalar` is recorded for both `*` and `/`.
                if (lValue is not null && rScalar is not null)
                {
                    Record(_needs, lValue, rScalar);
                }

                // Reversed order `scalar op value-object` only makes sense for the commutative `*`
                // (same product); `scalar / value-object` is not division of the value object.
                if (_op == BinaryOp.Mul && rValue is not null && lScalar is not null)
                {
                    Record(_needs, rValue, lScalar);
                }
            }

            base.VisitBinary(n);
        }
    }

    /// <summary>
    /// Shallowly infers whether an operand is a value object or a numeric scalar. The operand's type is
    /// read straight from the lexical <see cref="TypeScope"/> by name (identifiers) — deliberately
    /// shallow, NOT the full <see cref="TypeResolver.TypeOf"/>: only a bare identifier or a numeric
    /// literal is classified, matching the original member-type-map inference exactly. A collection or
    /// otherwise un-named scope entry (whose <see cref="KoineType.Name"/> is <c>null</c>) is neither a
    /// value object nor a scalar, so it falls through unrecorded — as before.
    /// </summary>
    private static (string? ValueObject, string? Scalar) InferOperand(
        Expr expr, TypeScope scope, ModelIndex index)
    {
        switch (expr)
        {
            case IdentifierExpr id when scope.TryGet(id.Name, out KoineType t) && t.Name is { } typeName:
                if (index.Classify(typeName) == TypeKind.Value)
                {
                    return (typeName, null);
                }

                if (typeName == "Int")
                {
                    return (null, "int");
                }

                if (typeName == "Decimal")
                {
                    return (null, "decimal");
                }

                return (null, null);
            case LiteralExpr lit when lit.Kind == LiteralKind.Int:
                return (null, "int");
            case LiteralExpr lit when lit.Kind == LiteralKind.Decimal:
                return (null, "decimal");
            default:
                return (null, null);
        }
    }

    private static void Record(Dictionary<string, HashSet<string>> needs, string vo, string scalar)
    {
        if (!needs.TryGetValue(vo, out HashSet<string>? set))
        {
            needs[vo] = set = new HashSet<string>(StringComparer.Ordinal);
        }

        set.Add(scalar);
    }

    /// <summary>The members in scope for a spec on <paramref name="typeName"/> (entities add a synthetic <c>id</c>).</summary>
    private static IReadOnlyList<Member> SpecTargetMembers(string typeName, ModelIndex index)
    {
        if (!index.TryGetDecl(typeName, out TypeDecl decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }
}
