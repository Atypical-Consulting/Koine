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
    public static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarOperatorNeeds(KoineModel model, ModelIndex index)
    {
        var needs = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

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

                var memberTypes = members.ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
                foreach (Member m in members)
                {
                    if (m.Initializer is not null)
                    {
                        ScanForScalarMul(m.Initializer, memberTypes, index, needs);
                    }
                }

                // Command bodies and state-rule guards can also use value-object arithmetic.
                if (type is EntityDecl entity)
                {
                    foreach ((Expr expr, IReadOnlyDictionary<string, TypeRef> scope) in CommandExpressions(entity, memberTypes))
                    {
                        ScanForScalarMul(expr, scope, index, needs);
                    }

                    foreach ((Expr expr, IReadOnlyDictionary<string, TypeRef> scope) in FactoryExpressions(entity, memberTypes))
                    {
                        ScanForScalarMul(expr, scope, index, needs);
                    }

                    foreach (Expr guard in StateGuards(entity))
                    {
                        ScanForScalarMul(guard, memberTypes, index, needs);
                    }
                }
            }
        }

        // Service operation bodies can use value-object * scalar arithmetic.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (ServiceDecl svc in ctx.Services)
            {
                foreach (OperationDecl op in svc.Operations)
                {
                    if (op.Body is not null)
                    {
                        var scope = op.Parameters.ToDictionary(p => p.Name, p => p.Type, StringComparer.Ordinal);
                        ScanForScalarMul(op.Body, scope, index, needs);
                    }
                }
            }
        }

        // Spec conditions over their target type's members can use value-object arithmetic.
        foreach (SpecDecl spec in AllSpecs(model))
        {
            var scope = SpecTargetMembers(spec.TargetType, index).ToDictionary(m => m.Name, m => m.Type, StringComparer.Ordinal);
            ScanForScalarMul(spec.Condition, scope, index, needs);
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

                var scope = TypeScope.FromMembers(members);
                foreach (Member m in members)
                {
                    if (m.Initializer is not null)
                    {
                        ScanForValueObjectSum(m.Initializer, scope, resolver, needs);
                    }
                }

                // Command bodies and state-rule guards can also fold value objects with sum.
                if (type is EntityDecl entity)
                {
                    foreach (CommandDecl cmd in entity.Commands)
                    {
                        TypeScope cmdScope = cmd.Parameters.Aggregate(scope, (s, p) => s.With(p.Name, p.Type));
                        foreach (CommandStmt stmt in cmd.Body)
                        {
                            if (stmt is RequiresClause req)
                            {
                                ScanForValueObjectSum(req.Condition, cmdScope, resolver, needs);
                            }
                            else if (stmt is Transition tr)
                            {
                                ScanForValueObjectSum(tr.Value, cmdScope, resolver, needs);
                            }
                            else if (stmt is EmitClause em)
                            {
                                foreach (EmitArg arg in em.Args)
                                {
                                    ScanForValueObjectSum(arg.Value, cmdScope, resolver, needs);
                                }
                            }
                        }
                    }
                    foreach (FactoryDecl factory in entity.Factories)
                    {
                        TypeScope factScope = factory.Parameters.Aggregate(scope, (s, p) => s.With(p.Name, p.Type));
                        foreach (CommandStmt stmt in factory.Body)
                        {
                            if (stmt is RequiresClause req)
                            {
                                ScanForValueObjectSum(req.Condition, factScope, resolver, needs);
                            }
                            else if (stmt is Initialization ini)
                            {
                                ScanForValueObjectSum(ini.Value, factScope, resolver, needs);
                            }
                            else if (stmt is EmitClause em)
                            {
                                foreach (EmitArg arg in em.Args)
                                {
                                    ScanForValueObjectSum(arg.Value, factScope, resolver, needs);
                                }
                            }
                        }
                    }
                    foreach (Expr guard in StateGuards(entity))
                    {
                        ScanForValueObjectSum(guard, scope, resolver, needs);
                    }
                }
            }
        }

        // Service operation bodies can also fold value objects with sum.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (ServiceDecl svc in ctx.Services)
            {
                foreach (OperationDecl op in svc.Operations)
                {
                    if (op.Body is not null)
                    {
                        var scope = new TypeScope(op.Parameters.Select(p => new KeyValuePair<string, TypeRef>(p.Name, p.Type)));
                        ScanForValueObjectSum(op.Body, scope, resolver, needs);
                    }
                }
            }
        }

        // Spec conditions (rendered over the target type's members) can fold value objects too.
        foreach (SpecDecl spec in AllSpecs(model))
        {
            ScanForValueObjectSum(spec.Condition, TypeScope.FromMembers(SpecTargetMembers(spec.TargetType, index)), resolver, needs);
        }

        return needs;
    }

    private static void ScanForValueObjectSum(Expr expr, TypeScope scope, TypeResolver resolver, HashSet<string> needs) =>
        new ValueObjectSumWalker(scope, resolver, needs).Visit(expr);

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
                TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(n.Target, _scope));
                if (element is not null)
                {
                    TypeRef? selector = _resolver.Infer(lambda.Body, _scope.With(lambda.Parameter, element));
                    if (_resolver.IsValueLike(selector))
                    {
                        _needs.Add(selector!.Name);
                    }
                }
            }

            base.VisitCall(n);
        }
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
    /// Every expression appearing in an entity's commands (requires conditions and
    /// transition values), paired with a member-type map extended by that command's
    /// parameters — for the operator-need scans.
    /// </summary>
    private static IEnumerable<(Expr Expr, IReadOnlyDictionary<string, TypeRef> Scope)> CommandExpressions(
        EntityDecl entity, IReadOnlyDictionary<string, TypeRef> memberTypes)
    {
        foreach (CommandDecl cmd in entity.Commands)
        {
            var scope = new Dictionary<string, TypeRef>(memberTypes, StringComparer.Ordinal);
            foreach (Param p in cmd.Parameters)
            {
                scope[p.Name] = p.Type;
            }

            foreach (CommandStmt stmt in cmd.Body)
            {
                if (stmt is RequiresClause req)
                {
                    yield return (req.Condition, scope);
                }
                else if (stmt is Transition tr)
                {
                    yield return (tr.Value, scope);
                }
                else if (stmt is EmitClause em)
                {
                    foreach (EmitArg arg in em.Args)
                    {
                        yield return (arg.Value, scope);
                    }
                }
            }
        }
    }

    /// <summary>
    /// Every expression in an entity's factories (requires conditions, initialization
    /// values, and emit payloads), paired with a member-type map extended by that
    /// factory's parameters — for the operator-need scans.
    /// </summary>
    private static IEnumerable<(Expr Expr, IReadOnlyDictionary<string, TypeRef> Scope)> FactoryExpressions(
        EntityDecl entity, IReadOnlyDictionary<string, TypeRef> memberTypes)
    {
        foreach (FactoryDecl factory in entity.Factories)
        {
            var scope = new Dictionary<string, TypeRef>(memberTypes, StringComparer.Ordinal);
            foreach (Param p in factory.Parameters)
            {
                scope[p.Name] = p.Type;
            }

            foreach (CommandStmt stmt in factory.Body)
            {
                if (stmt is RequiresClause req)
                {
                    yield return (req.Condition, scope);
                }
                else if (stmt is Initialization ini)
                {
                    yield return (ini.Value, scope);
                }
                else if (stmt is EmitClause em)
                {
                    foreach (EmitArg arg in em.Args)
                    {
                        yield return (arg.Value, scope);
                    }
                }
            }
        }
    }

    private static void ScanForScalarMul(
        Expr expr,
        IReadOnlyDictionary<string, TypeRef> memberTypes,
        ModelIndex index,
        Dictionary<string, HashSet<string>> needs) =>
        new ScalarMulWalker(memberTypes, index, needs).Visit(expr);

    /// <summary>
    /// Records, per value-object type, the scalar C# types it is multiplied by anywhere in an
    /// expression. The member-type scope is constant for the whole walk. Recurses into every
    /// node, so a multiplication nested under <c>??</c> or <c>let</c> is still found.
    /// </summary>
    private sealed class ScalarMulWalker : ExprWalker
    {
        private readonly IReadOnlyDictionary<string, TypeRef> _memberTypes;
        private readonly ModelIndex _index;
        private readonly Dictionary<string, HashSet<string>> _needs;

        public ScalarMulWalker(
            IReadOnlyDictionary<string, TypeRef> memberTypes,
            ModelIndex index,
            Dictionary<string, HashSet<string>> needs)
        {
            _memberTypes = memberTypes;
            _index = index;
            _needs = needs;
        }

        protected override void VisitBinary(BinaryExpr n)
        {
            if (n.Op == BinaryOp.Mul)
            {
                var (lValue, lScalar) = InferOperand(n.Left, _memberTypes, _index);
                var (rValue, rScalar) = InferOperand(n.Right, _memberTypes, _index);
                if (lValue is not null && rScalar is not null)
                {
                    Record(_needs, lValue, rScalar);
                }

                if (rValue is not null && lScalar is not null)
                {
                    Record(_needs, rValue, lScalar);
                }
            }

            base.VisitBinary(n);
        }
    }

    /// <summary>Shallowly infers whether an operand is a value object or a numeric scalar.</summary>
    private static (string? ValueObject, string? Scalar) InferOperand(
        Expr expr, IReadOnlyDictionary<string, TypeRef> memberTypes, ModelIndex index)
    {
        switch (expr)
        {
            case IdentifierExpr id when memberTypes.TryGetValue(id.Name, out TypeRef? t):
                if (index.Classify(t.Name) == TypeKind.Value)
                {
                    return (t.Name, null);
                }

                if (t.Name == "Int")
                {
                    return (null, "int");
                }

                if (t.Name == "Decimal")
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
