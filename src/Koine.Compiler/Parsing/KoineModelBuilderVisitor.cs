using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Parsing;

/// <summary>
/// Walks the ANTLR parse tree and builds the target-agnostic <see cref="KoineModel"/>.
/// The precedence-layered expression rules are collapsed into the flat
/// <see cref="Expr"/> hierarchy.
/// </summary>
public sealed class KoineModelBuilderVisitor : KoineParserBaseVisitor<object?>
{
    private readonly CommonTokenStream? _tokens;

    /// <param name="tokens">
    /// The token stream the parse tree came from, used to attach preceding
    /// <c>///</c> doc comments to declarations. May be <c>null</c> (docs ignored).
    /// </param>
    public KoineModelBuilderVisitor(CommonTokenStream? tokens = null) => _tokens = tokens;

    /// <summary>Builds the semantic model from a parsed program.</summary>
    public KoineModel BuildModel(KoineParser.ProgramContext context)
    {
        var contexts = context.contextDecl()
            .Select(BuildContext)
            .ToList();

        return new KoineModel(contexts) { Span = SpanOf(context) };
    }

    // ------------------------------------------------------------------------
    // Declarations
    // ------------------------------------------------------------------------

    private ContextNode BuildContext(KoineParser.ContextDeclContext ctx)
    {
        var types = ctx.typeDecl()
            .Select(BuildTypeDecl)
            .ToList();

        return new ContextNode(ctx.Identifier().GetText(), types) { Span = SpanOf(ctx), Doc = DocFor(ctx) };
    }

    private TypeDecl BuildTypeDecl(KoineParser.TypeDeclContext ctx)
    {
        if (ctx.valueDecl() is { } value)
            return BuildValue(value);
        if (ctx.entityDecl() is { } entity)
            return BuildEntity(entity);
        if (ctx.aggregateDecl() is { } aggregate)
            return BuildAggregate(aggregate);
        if (ctx.enumDecl() is { } @enum)
            return BuildEnum(@enum);
        if (ctx.eventDecl() is { } @event)
            return BuildEvent(@event);

        throw new InvalidOperationException("Unknown type declaration.");
    }

    private ValueObjectDecl BuildValue(KoineParser.ValueDeclContext ctx)
    {
        var members = ctx.member().Select(BuildMember).ToList();
        var invariants = ctx.invariant().Select(BuildInvariant).ToList();

        return new ValueObjectDecl(ctx.Identifier().GetText(), members, invariants)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private EntityDecl BuildEntity(KoineParser.EntityDeclContext ctx)
    {
        var members = ctx.member().Select(BuildMember).ToList();
        var invariants = ctx.invariant().Select(BuildInvariant).ToList();
        var states = ctx.statesDecl().Select(BuildStates).ToList();
        var commands = ctx.commandDecl().Select(BuildCommand).ToList();
        var factories = ctx.factoryDecl().Select(BuildFactory).ToList();

        var name = ctx.Identifier(0).GetText();
        var identityName = ctx.Identifier(1).GetText();

        return new EntityDecl(name, identityName, members, invariants, commands, states, factories)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private static StatesDecl BuildStates(KoineParser.StatesDeclContext ctx)
    {
        var rules = ctx.stateRule().Select(BuildStateRule).ToList();
        return new StatesDecl(ctx.softName().GetText(), rules) { Span = SpanOf(ctx) };
    }

    private static StateRule BuildStateRule(KoineParser.StateRuleContext ctx)
    {
        var ids = ctx.Identifier();
        var from = ids[0].GetText();
        var to = ids.Skip(1).Select(id => id.GetText()).ToList();
        var guard = ctx.expression() is { } g ? BuildExpression(g) : null;
        return new StateRule(from, to, guard) { Span = SpanOf(ctx) };
    }

    private CommandDecl BuildCommand(KoineParser.CommandDeclContext ctx)
    {
        var parameters = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        var body = ctx.commandStmt().Select(BuildCommandStmt).ToList();

        return new CommandDecl(ctx.Identifier().GetText(), parameters, body)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private static Param BuildParam(KoineParser.ParamContext ctx) =>
        new(ctx.softName().GetText(), BuildTypeRef(ctx.typeRef())) { Span = SpanOf(ctx) };

    private FactoryDecl BuildFactory(KoineParser.FactoryDeclContext ctx)
    {
        var parameters = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        var body = ctx.factoryStmt().Select(BuildFactoryStmt).ToList();

        return new FactoryDecl(ctx.Identifier().GetText(), parameters, body)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private static CommandStmt BuildFactoryStmt(KoineParser.FactoryStmtContext ctx)
    {
        if (ctx.requiresClause() is { } req)
        {
            var message = req.StringLiteral() is { } str
                ? UnescapeString(StripQuotes(str.GetText()))
                : null;
            return new RequiresClause(BuildExpression(req.expression()), message) { Span = SpanOf(req) };
        }

        if (ctx.emitClause() is { } emit)
        {
            var args = emit.emitArgList() is { } al
                ? al.emitArg().Select(a =>
                    new EmitArg(a.softName().GetText(), BuildExpression(a.expression())) { Span = SpanOf(a) }).ToList()
                : new List<EmitArg>();
            return new EmitClause(emit.Identifier().GetText(), args) { Span = SpanOf(emit) };
        }

        var init = ctx.initialization();
        return new Initialization(init.softName().GetText(), BuildExpression(init.expression()))
        {
            Span = SpanOf(init)
        };
    }

    private static CommandStmt BuildCommandStmt(KoineParser.CommandStmtContext ctx)
    {
        if (ctx.requiresClause() is { } req)
        {
            var message = req.StringLiteral() is { } str
                ? UnescapeString(StripQuotes(str.GetText()))
                : null;
            return new RequiresClause(BuildExpression(req.expression()), message) { Span = SpanOf(req) };
        }

        if (ctx.emitClause() is { } emit)
        {
            var args = emit.emitArgList() is { } al
                ? al.emitArg().Select(a =>
                    new EmitArg(a.softName().GetText(), BuildExpression(a.expression())) { Span = SpanOf(a) }).ToList()
                : new List<EmitArg>();
            return new EmitClause(emit.Identifier().GetText(), args) { Span = SpanOf(emit) };
        }

        var transition = ctx.transition();
        return new Transition(transition.softName().GetText(), BuildExpression(transition.expression()))
        {
            Span = SpanOf(transition)
        };
    }

    private AggregateDecl BuildAggregate(KoineParser.AggregateDeclContext ctx)
    {
        var types = ctx.typeDecl().Select(BuildTypeDecl).ToList();

        var name = ctx.Identifier(0).GetText();
        var rootName = ctx.Identifier(1).GetText();

        return new AggregateDecl(name, rootName, types) { Span = SpanOf(ctx), Doc = DocFor(ctx) };
    }

    private EnumDecl BuildEnum(KoineParser.EnumDeclContext ctx)
    {
        var members = ctx.Identifier()
            .Skip(1) // first Identifier is the enum name
            .Select(id => id.GetText())
            .ToList();

        return new EnumDecl(ctx.Identifier(0).GetText(), members) { Span = SpanOf(ctx), Doc = DocFor(ctx) };
    }

    private EventDecl BuildEvent(KoineParser.EventDeclContext ctx)
    {
        var members = ctx.member().Select(BuildMember).ToList();
        return new EventDecl(ctx.Identifier().GetText(), members) { Span = SpanOf(ctx), Doc = DocFor(ctx) };
    }

    private Member BuildMember(KoineParser.MemberContext ctx)
    {
        var type = BuildTypeRef(ctx.typeRef());
        var initializer = ctx.expression() is { } expr ? BuildExpression(expr) : null;

        return new Member(ctx.softName().GetText(), type, initializer)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    /// <summary>
    /// Gathers the <c>///</c> doc-comment lines immediately preceding a declaration
    /// (on the DOC channel), strips the leading <c>///</c> and one optional space,
    /// and joins multiple lines with <c>\n</c>. Returns <c>null</c> when absent.
    /// </summary>
    private string? DocFor(ParserRuleContext ctx)
    {
        if (_tokens is null)
            return null;

        var hidden = _tokens.GetHiddenTokensToLeft(ctx.Start.TokenIndex, KoineLexer.DOC);
        if (hidden is null || hidden.Count == 0)
            return null;

        // Only a contiguous run of `///` lines sitting on their OWN lines directly
        // above the declaration is its doc. This excludes a `///` trailing the
        // previous declaration's line, and a doc separated by a blank line.
        var previousVisibleLine = PreviousVisibleLine(ctx.Start.TokenIndex);
        var lines = new List<string>();
        var expectedLine = ctx.Start.Line - 1;

        for (var i = hidden.Count - 1; i >= 0; i--)
        {
            var t = hidden[i];
            if (t.Type != KoineLexer.DocComment) continue;
            if (t.Line != expectedLine) break;            // not adjacent (gap / blank line)
            if (t.Line == previousVisibleLine) break;     // trailing comment on prior code
            lines.Add(StripDocPrefix(t.Text));
            expectedLine = t.Line - 1;
        }

        if (lines.Count == 0)
            return null;

        lines.Reverse();
        return string.Join("\n", lines);
    }

    /// <summary>The line of the nearest preceding default-channel (visible) token, or -1.</summary>
    private int PreviousVisibleLine(int tokenIndex)
    {
        for (var i = tokenIndex - 1; i >= 0; i--)
        {
            var t = _tokens!.Get(i);
            if (t.Channel == TokenConstants.DefaultChannel)
                return t.Line;
        }
        return -1;
    }

    private static string StripDocPrefix(string text)
    {
        var body = text.Length >= 3 ? text[3..] : string.Empty; // drop leading "///"
        return body.StartsWith(' ') ? body[1..].TrimEnd() : body.TrimEnd();
    }

    private static TypeRef BuildTypeRef(KoineParser.TypeRefContext ctx)
    {
        var args = ctx.typeRef();
        var element = args.Length > 0 ? BuildTypeRef(args[0]) : null;
        var value = args.Length > 1 ? BuildTypeRef(args[1]) : null;
        var isOptional = ctx.QUESTION() is not null;
        return new TypeRef(ctx.typeName().GetText(), element, value, isOptional) { Span = SpanOf(ctx) };
    }

    private Invariant BuildInvariant(KoineParser.InvariantContext ctx)
    {
        var condition = BuildExpression(ctx.expression());
        var message = ctx.StringLiteral() is { } str
            ? UnescapeString(StripQuotes(str.GetText()))
            : null;

        return new Invariant(condition, message) { Span = SpanOf(ctx), Doc = DocFor(ctx) };
    }

    // ------------------------------------------------------------------------
    // Expressions
    // ------------------------------------------------------------------------

    private static Expr BuildExpression(KoineParser.ExpressionContext ctx) =>
        BuildGuard(ctx.guardExpr());

    private static Expr BuildGuard(KoineParser.GuardExprContext ctx)
    {
        var body = BuildCond(ctx.condExpr(0));

        if (ctx.WHEN() is null)
            return body;

        var condition = BuildCond(ctx.condExpr(1));
        return new GuardExpr(body, condition) { Span = SpanOf(ctx) };
    }

    private static Expr BuildCond(KoineParser.CondExprContext ctx)
    {
        if (ctx.IF() is null)
            return BuildCoalesce(ctx.coalesceExpr());

        var condition = BuildCond(ctx.condExpr(0));
        var then = BuildCond(ctx.condExpr(1));
        var @else = BuildCond(ctx.condExpr(2));
        return new ConditionalExpr(condition, then, @else) { Span = SpanOf(ctx) };
    }

    private static Expr BuildCoalesce(KoineParser.CoalesceExprContext ctx)
    {
        var operands = ctx.orExpr();
        var result = BuildOr(operands[0]);

        for (var i = 1; i < operands.Length; i++)
            result = new CoalesceExpr(result, BuildOr(operands[i])) { Span = SpanOf(ctx) };

        return result;
    }

    private static Expr BuildOr(KoineParser.OrExprContext ctx)
    {
        var operands = ctx.andExpr();
        var result = BuildAnd(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            var right = BuildAnd(operands[i]);
            result = new BinaryExpr(BinaryOp.Or, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private static Expr BuildAnd(KoineParser.AndExprContext ctx)
    {
        var operands = ctx.equalityExpr();
        var result = BuildEquality(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            var right = BuildEquality(operands[i]);
            result = new BinaryExpr(BinaryOp.And, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private static Expr BuildEquality(KoineParser.EqualityExprContext ctx)
    {
        var operands = ctx.relationalExpr();
        var result = BuildRelational(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            var op = OperatorAt(ctx, i - 1);
            var right = BuildRelational(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private static Expr BuildRelational(KoineParser.RelationalExprContext ctx)
    {
        var operands = ctx.matchExpr();
        var result = BuildMatch(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            var op = OperatorAt(ctx, i - 1);
            var right = BuildMatch(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private static Expr BuildMatch(KoineParser.MatchExprContext ctx)
    {
        var target = BuildAdditive(ctx.additiveExpr());

        if (ctx.MATCHES() is null)
            return target;

        var pattern = StripSlashes(ctx.Regex().GetText());
        return new MatchExpr(target, pattern) { Span = SpanOf(ctx) };
    }

    private static Expr BuildAdditive(KoineParser.AdditiveExprContext ctx)
    {
        var operands = ctx.multiplicativeExpr();
        var result = BuildMultiplicative(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            var op = OperatorAt(ctx, i - 1);
            var right = BuildMultiplicative(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private static Expr BuildMultiplicative(KoineParser.MultiplicativeExprContext ctx)
    {
        var operands = ctx.unaryExpr();
        var result = BuildUnary(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            var op = OperatorAt(ctx, i - 1);
            var right = BuildUnary(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private static Expr BuildUnary(KoineParser.UnaryExprContext ctx)
    {
        if (ctx.NOT() is not null)
            return new UnaryExpr(UnaryOp.Not, BuildUnary(ctx.unaryExpr())) { Span = SpanOf(ctx) };

        if (ctx.MINUS() is not null)
            return new UnaryExpr(UnaryOp.Negate, BuildUnary(ctx.unaryExpr())) { Span = SpanOf(ctx) };

        return BuildPostfix(ctx.postfixExpr());
    }

    private static Expr BuildPostfix(KoineParser.PostfixExprContext ctx)
    {
        var result = BuildPrimary(ctx.primary());

        // Walk the trailing `.member` / `.method(args)` chain in source order.
        var children = ctx.children;
        var i = 1; // index 0 is the primary
        while (i < children.Count)
        {
            // children[i] is DOT; the member/method name follows it.
            var name = children[i + 1].GetText();
            i += 2;

            if (i < children.Count
                && children[i] is Antlr4.Runtime.Tree.ITerminalNode lp
                && lp.Symbol.Type == KoineLexer.LPAREN)
            {
                i++; // consume '('
                IReadOnlyList<Expr> args = Array.Empty<Expr>();
                if (children[i] is KoineParser.ArgListContext argList)
                {
                    args = BuildArgList(argList);
                    i++;
                }
                i++; // consume ')'
                result = new CallExpr(result, name, args) { Span = SpanOf(ctx) };
            }
            else
            {
                result = new MemberAccessExpr(result, name) { Span = SpanOf(ctx) };
            }
        }

        return result;
    }

    private static IReadOnlyList<Expr> BuildArgList(KoineParser.ArgListContext ctx) =>
        ctx.argument().Select(BuildArgument).ToList();

    private static Expr BuildArgument(KoineParser.ArgumentContext ctx) =>
        ctx.lambda() is { } lambda
            ? BuildLambda(lambda)
            : BuildExpression(ctx.expression());

    private static Expr BuildLambda(KoineParser.LambdaContext ctx) =>
        new LambdaExpr(ctx.softName().GetText(), BuildExpression(ctx.expression()))
        {
            Span = SpanOf(ctx)
        };

    private static Expr BuildPrimary(KoineParser.PrimaryContext ctx)
    {
        if (ctx.literal() is { } literal)
            return BuildLiteral(literal);

        if (ctx.exprName() is { } identifier)
            return new IdentifierExpr(identifier.GetText()) { Span = SpanOf(ctx) };

        // Parenthesized expression.
        return BuildExpression(ctx.expression());
    }

    private static Expr BuildLiteral(KoineParser.LiteralContext ctx)
    {
        if (ctx.IntLiteral() is { } intLit)
            return new LiteralExpr(LiteralKind.Int, intLit.GetText()) { Span = SpanOf(ctx) };

        if (ctx.DecimalLiteral() is { } decLit)
            return new LiteralExpr(LiteralKind.Decimal, decLit.GetText()) { Span = SpanOf(ctx) };

        if (ctx.BoolLiteral() is { } boolLit)
            return new LiteralExpr(LiteralKind.Bool, boolLit.GetText()) { Span = SpanOf(ctx) };

        // String literal: inner content, unescaped, no surrounding quotes.
        var text = UnescapeString(StripQuotes(ctx.StringLiteral().GetText()));
        return new LiteralExpr(LiteralKind.String, text) { Span = SpanOf(ctx) };
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private static SourceSpan SpanOf(ParserRuleContext ctx) =>
        new(ctx.Start.Line, ctx.Start.Column + 1);

    /// <summary>
    /// Picks the n-th binary operator (0-based) among a rule's child terminals,
    /// mapping its source text to the corresponding <see cref="BinaryOp"/>.
    /// </summary>
    private static BinaryOp OperatorAt(ParserRuleContext ctx, int index)
    {
        var seen = 0;
        for (var i = 0; i < ctx.ChildCount; i++)
        {
            if (ctx.GetChild(i) is Antlr4.Runtime.Tree.ITerminalNode terminal
                && TryMapOperator(terminal.GetText(), out var op))
            {
                if (seen == index)
                    return op;
                seen++;
            }
        }

        throw new InvalidOperationException($"No binary operator at index {index}.");
    }

    private static bool TryMapOperator(string text, out BinaryOp op)
    {
        switch (text)
        {
            case "||": op = BinaryOp.Or; return true;
            case "&&": op = BinaryOp.And; return true;
            case "==": op = BinaryOp.Eq; return true;
            case "!=": op = BinaryOp.Neq; return true;
            case "<": op = BinaryOp.Lt; return true;
            case "<=": op = BinaryOp.Le; return true;
            case ">": op = BinaryOp.Gt; return true;
            case ">=": op = BinaryOp.Ge; return true;
            case "+": op = BinaryOp.Add; return true;
            case "-": op = BinaryOp.Sub; return true;
            case "*": op = BinaryOp.Mul; return true;
            case "/": op = BinaryOp.Div; return true;
            default: op = default; return false;
        }
    }

    private static string StripQuotes(string text) =>
        text.Length >= 2 ? text[1..^1] : text;

    private static string StripSlashes(string text) =>
        text.Length >= 2 ? text[1..^1] : text;

    /// <summary>
    /// Decodes the escape sequences the lexer's <c>StringLiteral</c> rule permits,
    /// in a single left-to-right pass. Recognizes <c>\" \\ \n \t \r \0 \b \f \v</c>;
    /// any other escape is passed through with its character (e.g. <c>\d</c> -> <c>d</c>).
    /// </summary>
    private static string UnescapeString(string text)
    {
        if (text.IndexOf('\\') < 0)
            return text;

        var sb = new System.Text.StringBuilder(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c != '\\' || i + 1 >= text.Length)
            {
                sb.Append(c);
                continue;
            }

            var next = text[++i];
            sb.Append(next switch
            {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                '0' => '\0',
                'b' => '\b',
                'f' => '\f',
                'v' => '\v',
                _ => next // \" \\ and any other escape: keep the literal char
            });
        }

        return sb.ToString();
    }
}
