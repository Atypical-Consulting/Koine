namespace Koine.Compiler.Ast.Bound;

/// <summary>
/// Transforms a resolved syntax subtree into the bound (resolved + lowered) tree. Built on the Commit-2
/// typed <see cref="KoineSyntaxVisitor{TResult}"/> and the Commit-3 binder; it reads resolution ONLY
/// via <see cref="SemanticModel.GetSymbolInfo"/> / <see cref="SemanticModel.GetTypeInfo"/> (it adds no
/// new resolution rules) and performs ONLY the desugarings the migrated value-object-invariant slice
/// needs. TARGET-AGNOSTIC.
///
/// <para>Lowering runs after validation (parse → build → validate → emit), so it raises no diagnostics
/// and assumes a well-formed, resolvable input: an unresolved reference simply yields
/// <see cref="ErrorSymbol.Instance"/> / <see cref="ErrorType.Instance"/> in the bound node, mirroring
/// the binder, never a throw.</para>
/// </summary>
internal sealed class Lowerer : KoineSyntaxVisitor<BoundNode>
{
    private readonly SemanticModel _model;   // GetSymbolInfo (Commit 3) + GetTypeInfo (TypeResolver)
    private readonly TypeScope _scope;       // the member scope for type resolution (mirrors the emitter)
    private readonly string? _context;       // the bounded context the scope resolves in (R13.2)

    public Lowerer(SemanticModel model, TypeScope scope, string? context)
    {
        _model = model;
        _scope = scope;
        _context = context;
    }

    /// <summary>Lowers an expression to its bound form (always a <see cref="BoundExpression"/>).</summary>
    public BoundExpression LowerExpr(Expr e) => (BoundExpression)Visit(e)!;

    /// <summary>
    /// Lowers a value-object invariant: binds + types the condition (via the visitor), and applies the
    /// C# message default (<c>?? SourceText(condition)</c>) ONCE, here. <c>Invariant</c> is a
    /// <see cref="KoineNode"/> but not an <see cref="Expr"/>, so this is a plain method, not a visitor
    /// override.
    /// </summary>
    public BoundInvariant LowerInvariant(Invariant inv) =>
        new(LowerExpr(inv.Condition), inv.Message ?? SourceText(inv.Condition)) { Syntax = inv };

    /// <summary>
    /// Lowers a value object to its canonical field projection plus its lowered invariants (Commit 5):
    /// classifies each member ONCE (ctor-param vs derived, default disposition, collection shape), resolves
    /// its type, and lowers a derived member's initializer body. The constructor ordering policy lives on
    /// the projection (<see cref="BoundValueObject.CtorParams"/>), so the emitter no longer re-derives any
    /// of this. Scoped exactly as the invariant lowering — the resolved types match what the emitter saw.
    /// </summary>
    public BoundValueObject LowerValueObject(ValueObjectDecl vo)
    {
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        var fields = vo.Members.Select(m => LowerField(m, memberNames)).ToList();
        var invariants = vo.Invariants.Select(LowerInvariant).ToList();
        return new BoundValueObject(fields, invariants) { Syntax = vo };
    }

    private BoundField LowerField(Member m, ISet<string> memberNames)
    {
        bool derived = MemberAnalysis.IsDerived(m, memberNames);
        return new BoundField(
            m.Name,
            derived ? FieldKind.Derived : FieldKind.CtorParam,
            derived ? DefaultKind.None : ClassifyDefault(m),
            ClassifyShape(m.Type),
            derived ? LowerExpr(m.Initializer!) : null)
        {
            Syntax = m,
            Type = KoineType.From(m.Type, _model.Index)
        };
    }

    /// <summary>
    /// The default-value disposition of a constructor field, mirroring the C# emitter's former
    /// <c>FormatParam</c>/<c>WriteEnumDefaultCoalesce</c> classification but named target-neutrally: an
    /// enum-typed initializer is not a compile-time constant (<see cref="DefaultKind.EnumDefault"/>); any
    /// other initializer is a constant default; an optional field with no initializer is omittable.
    /// </summary>
    private DefaultKind ClassifyDefault(Member m)
    {
        if (m.Initializer is null)
        {
            return m.Type.IsOptional ? DefaultKind.OptionalNull : DefaultKind.None;
        }

        return _model.Index.Classify(m.Type.Name) == TypeKind.Enum
            ? DefaultKind.EnumDefault
            : DefaultKind.ConstantDefault;
    }

    /// <summary>The collection shape of a member type, mirroring <c>ModelIndex</c>'s List/Set/Map names.</summary>
    private static CollectionShape ClassifyShape(TypeRef type) => type.Name switch
    {
        ModelIndex.ListTypeName => CollectionShape.List,
        ModelIndex.SetTypeName => CollectionShape.Set,
        ModelIndex.MapTypeName => CollectionShape.Map,
        _ => CollectionShape.None
    };

    private KoineType TypeOf(Expr e) => _model.GetTypeInfo(e, _scope, _context);

    public override BoundNode VisitBinaryExpr(BinaryExpr n) =>
        new BoundBinary(n.Op, LowerExpr(n.Left), LowerExpr(n.Right)) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitUnaryExpr(UnaryExpr n) =>
        new BoundUnary(n.Op, LowerExpr(n.Operand)) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitIdentifierExpr(IdentifierExpr n) =>
        new BoundReference(_model.GetSymbolInfo(n)) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitLiteralExpr(LiteralExpr n) =>
        new BoundLiteral(n.Kind, n.Text) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitMemberAccessExpr(MemberAccessExpr n) =>
        new BoundMemberAccess(LowerExpr(n.Target), n.MemberName, _model.GetSymbolInfo(n))
        { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitCallExpr(CallExpr n) =>
        new BoundCall(LowerExpr(n.Target), n.Method, n.Args.Select(LowerExpr).ToList())
        { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitConditionalExpr(ConditionalExpr n) =>
        new BoundConditional(LowerExpr(n.Condition), LowerExpr(n.Then), LowerExpr(n.Else))
        { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitCoalesceExpr(CoalesceExpr n) =>
        new BoundCoalesce(LowerExpr(n.Left), LowerExpr(n.Right)) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitMatchExpr(MatchExpr n) =>
        new BoundMatch(LowerExpr(n.Target), n.Pattern) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitGuardExpr(GuardExpr n) =>
        new BoundGuard(LowerExpr(n.Body), LowerExpr(n.Condition)) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitLambdaExpr(LambdaExpr n) =>
        new BoundLambda(n.Parameter, LowerExpr(n.Body)) { Syntax = n, Type = TypeOf(n) };

    public override BoundNode VisitLetExpr(LetExpr n) =>
        new BoundLet(
            n.Bindings.Select(b => new BoundLetBinding(b.Name, LowerExpr(b.Value)) { Syntax = b }).ToList(),
            LowerExpr(n.Body))
        { Syntax = n, Type = TypeOf(n) };

    // ----------------------------------------------------------------------
    // The Koine-source round-trip, relocated VERBATIM from CSharpEmitter (it is target-agnostic:
    // it renders KOINE source syntax via an ExprVisitor<string>, no C# in it). Provides the C#
    // invariant message default. The relocation is byte-for-byte — any reformatting would change
    // synthesized invariant messages and break snapshots.
    // ----------------------------------------------------------------------

    /// <summary>Synthesizes a readable rule message from an unmessaged invariant (the C# message default).</summary>
    internal static string SourceText(Expr expr) => SourceTextVisitor.Instance.Visit(expr);

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

    /// <summary>
    /// Renders an expression back to Koine source syntax, for synthesizing a readable rule message
    /// from an unmessaged invariant. Exhaustive (<see cref="ExprVisitor{T}"/>) so every node — including
    /// <c>??</c> and <c>let … in …</c> — round-trips rather than collapsing to a generic placeholder.
    /// </summary>
    private sealed class SourceTextVisitor : ExprVisitor<string>
    {
        public static readonly SourceTextVisitor Instance = new();

        private SourceTextVisitor() { }

        protected override string VisitIdentifier(IdentifierExpr n) => n.Name;

        protected override string VisitLiteral(LiteralExpr n) =>
            n.Kind == LiteralKind.String ? $"\"{n.Text}\"" : n.Text;

        protected override string VisitMemberAccess(MemberAccessExpr n) => $"{Visit(n.Target)}.{n.MemberName}";

        protected override string VisitCall(CallExpr n) =>
            $"{Visit(n.Target)}.{n.Method}({string.Join(", ", n.Args.Select(Visit))})";

        protected override string VisitLambda(LambdaExpr n) => $"{n.Parameter} => {Visit(n.Body)}";

        protected override string VisitConditional(ConditionalExpr n) =>
            $"if {Visit(n.Condition)} then {Visit(n.Then)} else {Visit(n.Else)}";

        protected override string VisitCoalesce(CoalesceExpr n) => $"{Visit(n.Left)} ?? {Visit(n.Right)}";

        protected override string VisitUnary(UnaryExpr n) => (n.Op == UnaryOp.Not ? "not " : "-") + Visit(n.Operand);

        protected override string VisitBinary(BinaryExpr n) => $"{Visit(n.Left)} {SourceOp(n.Op)} {Visit(n.Right)}";

        protected override string VisitMatch(MatchExpr n) => $"{Visit(n.Target)} matches /{n.Pattern}/";

        protected override string VisitGuard(GuardExpr n) => $"{Visit(n.Body)} when {Visit(n.Condition)}";

        protected override string VisitLet(LetExpr n) =>
            $"let {string.Join(", ", n.Bindings.Select(b => $"{b.Name} = {Visit(b.Value)}"))} in {Visit(n.Body)}";
    }
}
