using System.Runtime.CompilerServices;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// Demand-driven analysis that decides which non-quantity value objects need generated
/// arithmetic operators (R9). A value object's <c>+</c>/<c>*</c> operators are emitted
/// ONLY where the model actually folds it with <c>sum</c> or multiplies it by a scalar,
/// so an emitter never emits operators no one calls.
///
/// <para>Pure and stateless: every method derives its result from the model alone, so the
/// scans are easy to test and reason about independently of the emitter's mutable wiring.</para>
///
/// <para><b>Shared across all five code emitters</b> (C#, TypeScript, Python, Php, Rust): it lives in
/// the <c>Koine.Emit.Common</c> assembly (issue #861), even though the namespace is still
/// <c>Koine.Compiler.Emit.CSharp</c> (kept unchanged so the extraction stays reference-only). It is not
/// a C#-only helper — a new code emitter should reuse it rather than re-deriving operator needs.</para>
/// </summary>
internal static class OperatorNeedsAnalyzer
{
    /// <summary>
    /// Records, per value-object type, which scalar C# types ("int"/"decimal") it is multiplied by in a
    /// <c>value-object * scalar</c> multiplication. Only those operators are generated, so we never emit
    /// spurious (or non-compiling) operators on value objects that are never multiplied. A thin
    /// projection over the single-pass <see cref="BuildOperatorNeeds"/>.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarOperatorNeeds(KoineModel model, ModelIndex index) =>
        ProjectScalarFactors(BuildOperatorNeeds(model, index), static n => n.MultiplyFactors);

    /// <summary>
    /// The division sibling of <see cref="BuildScalarOperatorNeeds"/>: records, per value-object type,
    /// which scalar C# types ("int"/"decimal") it is divided by. Drives demand-driven <c>operator /</c>
    /// generation (#832) — the natural dual of scalar multiplication. Division is non-commutative, so
    /// only the value-object-on-the-left form is recorded; <c>scalar / value-object</c> would divide a
    /// scalar <i>by</i> the value object, which is not a value-object operator, so it is deliberately not
    /// recorded (its reversed-operand emission is a separate concern, out of scope here). A thin
    /// projection over the single-pass <see cref="BuildOperatorNeeds"/>.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlySet<string>> BuildScalarDivisionNeeds(KoineModel model, ModelIndex index) =>
        ProjectScalarFactors(BuildOperatorNeeds(model, index), static n => n.DivideFactors);

    /// <summary>
    /// The value-object types folded by a <c>sum</c> selector (e.g. <c>lines.sum(l =&gt; l.subtotal)</c>
    /// producing a <c>Money</c>) and therefore needing an additive operator. A thin projection over the
    /// single-pass <see cref="BuildOperatorNeeds"/> (its <see cref="ValueObjectOperatorNeeds.IsSummable"/>
    /// flag).
    /// </summary>
    public static IReadOnlySet<string> BuildAdditiveOperatorNeeds(KoineModel model, ModelIndex index) =>
        BuildOperatorNeeds(model, index)
            .Where(kv => kv.Value.IsSummable)
            .Select(kv => kv.Key)
            .ToHashSet(StringComparer.Ordinal);

    /// <summary>
    /// Records, per value-object type, which additive operators it participates in via plain
    /// <c>value-object <b>+</b>/<b>-</b> value-object</c> binary arithmetic — e.g.
    /// <c>combined: Money = base + base</c>. This is the binary-operator sibling of
    /// <see cref="BuildAdditiveOperatorNeeds"/> (which only fires on a <c>sum(selector)</c> fold): a
    /// value object used directly in <c>+</c>/<c>-</c> needs an <c>add</c>/<c>subtract</c> method too,
    /// otherwise the lowered call site (<c>$vo-&gt;add(...)</c>) targets a method that was never
    /// generated. A guard-narrowed optional operand still infers as the same value type, so it is
    /// recorded here as well (its emission need is identical; only the call-site routing differs).
    /// Target-agnostic like the rest of this analyzer: the PHP emitter generates its <c>add</c>/<c>subtract</c>
    /// methods from this map, and the C# emitter consumes it (alongside <see cref="BuildAdditiveOperatorNeeds"/>)
    /// to demand-generate direct <c>operator +</c>/<c>operator -</c> for plain value objects (#833). A thin
    /// projection over the single-pass <see cref="BuildOperatorNeeds"/>.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlySet<BinaryOp>> BuildValueObjectArithmeticNeeds(KoineModel model, ModelIndex index) =>
        BuildOperatorNeeds(model, index)
            .Where(kv => kv.Value.BinaryOps.Count > 0)
            .ToDictionary(kv => kv.Key, kv => (IReadOnlySet<BinaryOp>)kv.Value.BinaryOps, StringComparer.Ordinal);

    /// <summary>
    /// The whole per-value-object need model — the single-pass output the four scalar / additive /
    /// binary projection methods derive from — exposed directly for an emitter that needs more than one
    /// signal at once. The PHP emitter consumes it so the "does this value object need an <c>add</c>?"
    /// decision (the union of the <c>sum</c>-fold and binary <c>+</c> demands, see
    /// <see cref="ValueObjectOperatorNeeds.NeedsAdd"/>) lives in the analyzer rather than being
    /// re-combined from <see cref="BuildAdditiveOperatorNeeds"/> and
    /// <see cref="BuildValueObjectArithmeticNeeds"/> in the emitter (#836). Internal because it surfaces
    /// the internal <see cref="ValueObjectOperatorNeeds"/> record.
    /// </summary>
    internal static IReadOnlyDictionary<string, ValueObjectOperatorNeeds> BuildValueObjectOperatorNeeds(KoineModel model, ModelIndex index) =>
        BuildOperatorNeeds(model, index);

    /// <summary>
    /// Per-<see cref="KoineModel"/>, per-<see cref="ModelIndex"/> cache for <see cref="BuildOperatorNeeds"/>
    /// keyed by reference identity (both are immutable per compile — <see cref="KoineModel"/> is a record
    /// over <see cref="IReadOnlyList{T}"/> contexts, <see cref="ModelIndex"/> is built once and treated
    /// read-only by every consumer). Without this, every public <c>Build*</c> caller (the C#, TypeScript,
    /// Python, and Rust emitters each call several of them per emit) would re-run the full single pass —
    /// the exact "each re-walking the model" cost the single-pass design was meant to retire (#836).
    /// <see cref="ConditionalWeakTable{TKey,TValue}"/> uses reference identity for its keys regardless of
    /// any value-equality a key type defines, so this is safe even though <see cref="KoineModel"/> is a
    /// record.
    /// </summary>
    private static readonly ConditionalWeakTable<KoineModel, Dictionary<ModelIndex, IReadOnlyDictionary<string, ValueObjectOperatorNeeds>>> OperatorNeedsCache = new();

    /// <summary>
    /// The single demand-driven pass: walks every expression site (<see cref="ExpressionScanSites"/>)
    /// <b>once</b>, running the scalar-multiply, scalar-divide, <c>sum</c>-fold, and plain-binary
    /// walkers per <c>(Expr, TypeScope)</c> site and merging their signals into one
    /// <see cref="ValueObjectOperatorNeeds"/> per value-object name. The public <c>Build*</c> methods are
    /// thin projections over this map, so they share one site enumeration and one per-VO need model
    /// rather than each re-walking the model (#836) — memoized per (model, index) via
    /// <see cref="OperatorNeedsCache"/> so that sharing holds across separate <c>Build*</c> calls too, not
    /// just within one.
    /// </summary>
    private static IReadOnlyDictionary<string, ValueObjectOperatorNeeds> BuildOperatorNeeds(KoineModel model, ModelIndex index)
    {
        Dictionary<ModelIndex, IReadOnlyDictionary<string, ValueObjectOperatorNeeds>> byIndex =
            OperatorNeedsCache.GetValue(model, static _ => new Dictionary<ModelIndex, IReadOnlyDictionary<string, ValueObjectOperatorNeeds>>());

        if (byIndex.TryGetValue(index, out IReadOnlyDictionary<string, ValueObjectOperatorNeeds>? cached))
        {
            return cached;
        }

        IReadOnlyDictionary<string, ValueObjectOperatorNeeds> needs = ComputeOperatorNeeds(model, index);
        byIndex[index] = needs;
        return needs;
    }

    private static IReadOnlyDictionary<string, ValueObjectOperatorNeeds> ComputeOperatorNeeds(KoineModel model, ModelIndex index)
    {
        var resolver = new TypeResolver(index);
        var multiply = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var divide = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var binary = new Dictionary<string, HashSet<BinaryOp>>(StringComparer.Ordinal);
        var summable = new HashSet<string>(StringComparer.Ordinal);

        foreach ((Expr expr, TypeScope scope) in ExpressionScanSites(model, index))
        {
            new ScalarOpWalker(BinaryOp.Mul, scope, index, multiply).Visit(expr);
            new ScalarOpWalker(BinaryOp.Div, scope, index, divide).Visit(expr);
            new ValueObjectSumWalker(scope, resolver, summable).Visit(expr);
            new ValueObjectArithmeticWalker(scope, resolver, index, binary).Visit(expr);
        }

        var needs = new Dictionary<string, ValueObjectOperatorNeeds>(StringComparer.Ordinal);
        ValueObjectOperatorNeeds Entry(string vo)
        {
            if (!needs.TryGetValue(vo, out ValueObjectOperatorNeeds? n))
            {
                needs[vo] = n = new ValueObjectOperatorNeeds();
            }

            return n;
        }

        foreach ((string vo, HashSet<string> factors) in multiply)
        {
            Entry(vo).UnionMultiplyFactors(factors);
        }

        foreach ((string vo, HashSet<string> factors) in divide)
        {
            Entry(vo).UnionDivideFactors(factors);
        }

        foreach ((string vo, HashSet<BinaryOp> ops) in binary)
        {
            Entry(vo).UnionBinaryOps(ops);
        }

        foreach (string vo in summable)
        {
            Entry(vo).MarkSummable();
        }

        return needs;
    }

    /// <summary>
    /// Projects one scalar factor set (multiply or divide) out of the per-VO need model, keeping only
    /// value objects that actually carry a factor under that operator — so the result is byte-identical
    /// to the pre-unification per-operator map (which only ever held keys it recorded a factor for).
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlySet<string>> ProjectScalarFactors(
        IReadOnlyDictionary<string, ValueObjectOperatorNeeds> needs,
        Func<ValueObjectOperatorNeeds, IReadOnlySet<string>> select) =>
        needs.Where(kv => select(kv.Value).Count > 0)
             .ToDictionary(kv => kv.Key, kv => select(kv.Value), StringComparer.Ordinal);

    /// <summary>
    /// The per-value-object operator demand accumulated by <see cref="BuildOperatorNeeds"/> in one pass:
    /// the scalar C# types it is multiplied / divided by, the plain binary additive operators it
    /// participates in, and whether it is folded by <c>sum</c>. One record replaces the separate per-pass
    /// maps the analyzer used to build, so "which operators does this value object need?" is answered in
    /// one place (#836). Exposed (via <see cref="BuildValueObjectOperatorNeeds"/>) to the PHP emitter,
    /// which needs more than one signal at once.
    /// </summary>
    internal sealed class ValueObjectOperatorNeeds
    {
        private readonly HashSet<string> _multiplyFactors = new(StringComparer.Ordinal);
        private readonly HashSet<string> _divideFactors = new(StringComparer.Ordinal);
        private readonly HashSet<BinaryOp> _binaryOps = new();

        /// <summary>Scalar C# types ("int"/"decimal") this value object is multiplied by.</summary>
        public IReadOnlySet<string> MultiplyFactors => _multiplyFactors;

        /// <summary>Scalar C# types ("int"/"decimal") this value object is divided by.</summary>
        public IReadOnlySet<string> DivideFactors => _divideFactors;

        /// <summary>The plain binary additive operators (<c>+</c>/<c>-</c>) this value object participates in.</summary>
        public IReadOnlySet<BinaryOp> BinaryOps => _binaryOps;

        /// <summary>Whether this value object is folded by a <c>sum(selector)</c> (set only by that fold).</summary>
        public bool IsSummable { get; private set; }

        /// <summary>
        /// Whether this value object needs an <c>add</c> operation at all — the union of the <c>sum</c>-fold
        /// demand (<see cref="IsSummable"/>) and a plain binary <c>+</c> demand. Computed here, in the
        /// analyzer, so an emitter asks the question once instead of re-combining the sum-fold and binary
        /// maps itself. <see cref="IsSummable"/> stays a separate flag because it also selects the
        /// <c>add</c>'s <i>shape</i> (a <c>Summable</c>-typed parameter vs a concrete <c>self</c>), not
        /// merely whether one is emitted (#836).
        /// </summary>
        public bool NeedsAdd => IsSummable || BinaryOps.Contains(BinaryOp.Add);

        /// <summary>
        /// Mutators are internal and exposed only as named operations (not a writable property/collection)
        /// because <see cref="BuildOperatorNeeds"/> now caches and shares each instance across every
        /// <c>Build*</c> caller within a compile — a writable public surface would let one consumer
        /// corrupt the result every other consumer of the same cached instance sees.
        /// </summary>
        internal void UnionMultiplyFactors(IEnumerable<string> factors) => _multiplyFactors.UnionWith(factors);

        internal void UnionDivideFactors(IEnumerable<string> factors) => _divideFactors.UnionWith(factors);

        internal void UnionBinaryOps(IEnumerable<BinaryOp> ops) => _binaryOps.UnionWith(ops);

        internal void MarkSummable() => IsSummable = true;
    }

    /// <summary>
    /// Every expression the demand-driven value-object analyses scan, paired with the
    /// <see cref="TypeScope"/> it is resolved in: member initializers, invariant conditions, command
    /// and factory bodies, state-rule guards, service operation bodies, spec conditions, and
    /// read-model field projections. The <b>single</b> site enumerator — the scalar
    /// <c>*</c>/<c>/</c> analyses (<see cref="BuildScalarOperatorNeeds"/>, <see cref="BuildScalarDivisionNeeds"/>),
    /// the <c>sum</c> fold (<see cref="BuildAdditiveOperatorNeeds"/>), and the plain binary <c>+</c>/<c>-</c>
    /// analysis (<see cref="BuildValueObjectArithmeticNeeds"/>) all walk it, so the site list lives in one
    /// place and cannot drift between passes (#836).
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
