using Antlr4.Runtime;
using Antlr4.Runtime.Tree;
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
    private readonly string? _file;

    /// <param name="tokens">
    /// The token stream the parse tree came from, used to attach preceding
    /// <c>///</c> doc comments to declarations. May be <c>null</c> (docs ignored).
    /// </param>
    /// <param name="file">The originating source file, stamped onto every node's span (R13.1).</param>
    public KoineModelBuilderVisitor(CommonTokenStream? tokens = null, string? file = null)
    {
        _tokens = tokens;
        _file = file;
    }

    /// <summary>Builds the semantic model from a parsed program.</summary>
    public KoineModel BuildModel(KoineParser.ProgramContext context)
    {
        KoineParser.ProgramMemberContext[]? members = context.programMember();
        var contexts = members
            .Select(m => m.contextDecl())
            .Where(c => c is not null)
            .Select(BuildContext!)
            .ToList();

        // Relations from every contextmap block in this unit, concatenated (R14.1).
        var relations = members
            .Select(m => m.contextMapDecl())
            .Where(m => m is not null)
            .SelectMany(m => m!.relationDecl())
            .Select(BuildRelation)
            .ToList();
        ContextMapNode? map = relations.Count == 0 ? null : new ContextMapNode(relations) { Span = SpanOf(context) };

        return new KoineModel(contexts, map) { Span = SpanOf(context) };
    }

    // ------------------------------------------------------------------------
    // Declarations
    // ------------------------------------------------------------------------

    private ContextNode BuildContext(KoineParser.ContextDeclContext ctx)
    {
        var types = new List<TypeDecl>();
        var specs = new List<SpecDecl>();
        var services = new List<ServiceDecl>();
        var policies = new List<PolicyDecl>();
        var imports = new List<ImportDecl>();
        var moduleNames = new List<string>();
        var publishes = new List<PublishDecl>();
        var subscribes = new List<SubscribeDecl>();

        foreach (KoineParser.ContextMemberContext? member in ctx.contextMember())
        {
            if (member.typeDecl() is { } t)
            {
                types.Add(BuildTypeDecl(t));
            }
            else if (member.specDecl() is { } s)
            {
                specs.Add(BuildSpec(s));
            }
            else if (member.serviceDecl() is { } sv)
            {
                services.Add(BuildService(sv));
            }
            else if (member.policyDecl() is { } p)
            {
                policies.Add(BuildPolicy(p));
            }
            else if (member.readmodelDecl() is { } rm)
            {
                types.Add(BuildReadModel(rm));
            }
            else if (member.queryDecl() is { } q)
            {
                types.Add(BuildQuery(q));
            }
            else if (member.importDecl() is { } i)
            {
                imports.Add(BuildImport(i));
            }
            else if (member.moduleDecl() is { } m)
            {
                FlattenModule(m, Array.Empty<string>(), types, moduleNames);
            }
            else if (member.publishDecl() is { } pub)
            {
                publishes.Add(BuildPublish(pub));
            }
            else if (member.subscribeDecl() is { } sub)
            {
                subscribes.Add(BuildSubscribe(sub));
            }
        }

        // `int.TryParse`, not `Parse`: an absurd literal (e.g. `version 99999999999999999999`,
        // syntactically a valid IntLiteral) must not crash the compiler — treat it as unstamped.
        var version = ctx.IntLiteral() is { } v && int.TryParse(v.GetText(), out var parsed)
            ? parsed
            : (int?)null;

        return new ContextNode(
            ctx.Identifier().GetText(), types, specs, services, policies, imports, moduleNames, publishes, subscribes)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Version = version
        };
    }

    /// <summary>
    /// Reads the <c>@since(n)</c> / <c>@deprecated("reason")</c> evolution annotations preceding
    /// a type or field declaration (R15.1). Unknown annotation names are ignored.
    /// </summary>
    private (int? Since, string? Deprecated) ReadAnnotations(IEnumerable<KoineParser.AnnotationContext> annotations)
    {
        int? since = null;
        string? deprecated = null;
        foreach (KoineParser.AnnotationContext a in annotations)
        {
            switch (a.Identifier().GetText())
            {
                case "since" when a.IntLiteral() is { } iv && int.TryParse(iv.GetText(), out var sv):
                    since = sv;
                    break;
                case "deprecated" when a.StringLiteral() is { } sv:
                    deprecated = UnescapeString(StripQuotes(sv.GetText()));
                    break;
            }
        }
        return (since, deprecated);
    }

    // ---- Context map & integration-event wiring (R14) ----------------------

    private ContextRelation BuildRelation(KoineParser.RelationDeclContext ctx)
    {
        KoineParser.TypeNameContext[]? names = ctx.typeName();
        ContextRelationKind kind = BuildRelationKind(ctx.relationRole());
        var bidirectional = ctx.relationArrow().BIARROW() is not null;
        List<string> sharedTypes = ctx.sharedKernelBlock() is { } sk
            ? sk.typeName().Select(t => t.GetText()).ToList()
            : new List<string>();
        List<AclMapping> aclMappings = ctx.aclBlock() is { } acl
            ? acl.aclMapping().Select(BuildAclMapping).ToList()
            : new List<AclMapping>();

        return new ContextRelation(
            names[0].GetText(), names[1].GetText(), kind, bidirectional, sharedTypes, aclMappings)
        {
            Span = SpanOf(ctx)
        };
    }

    private static ContextRelationKind BuildRelationKind(KoineParser.RelationRoleContext ctx)
    {
        if (ctx.PARTNERSHIP() is not null)
        {
            return ContextRelationKind.Partnership;
        }

        if (ctx.SHARED_KERNEL() is not null)
        {
            return ContextRelationKind.SharedKernel;
        }

        if (ctx.CUSTOMER_SUPPLIER() is not null)
        {
            return ContextRelationKind.CustomerSupplier;
        }

        if (ctx.CONFORMIST() is not null)
        {
            return ContextRelationKind.Conformist;
        }

        if (ctx.ANTI_CORRUPTION() is not null)
        {
            return ContextRelationKind.AntiCorruptionLayer;
        }

        if (ctx.OPEN_HOST() is not null)
        {
            return ContextRelationKind.OpenHost;
        }

        return ContextRelationKind.PublishedLanguage;
    }

    private AclMapping BuildAclMapping(KoineParser.AclMappingContext ctx)
    {
        KoineParser.QualifiedTypeContext? from = ctx.qualifiedType(0);
        KoineParser.QualifiedTypeContext? to = ctx.qualifiedType(1);
        return new AclMapping(
            from.typeName(0).GetText(), from.typeName(1).GetText(),
            to.typeName(0).GetText(), to.typeName(1).GetText())
        {
            Span = SpanOf(ctx)
        };
    }

    private PublishDecl BuildPublish(KoineParser.PublishDeclContext ctx) =>
        new(ctx.typeName().GetText()) { Span = SpanOf(ctx) };

    private SubscribeDecl BuildSubscribe(KoineParser.SubscribeDeclContext ctx)
    {
        KoineParser.TypeNameContext[]? names = ctx.typeName();
        return new SubscribeDecl(names[0].GetText(), names[1].GetText()) { Span = SpanOf(ctx) };
    }

    private ImportDecl BuildImport(KoineParser.ImportDeclContext ctx)
    {
        KoineParser.TypeNameContext[]? names = ctx.typeName();
        var isWildcard = ctx.STAR() is not null;
        List<string> imported = isWildcard
            ? new List<string>()
            : names.Skip(1).Select(t => t.GetText()).ToList();
        return new ImportDecl(names[0].GetText(), imported, isWildcard) { Span = SpanOf(ctx) };
    }

    /// <summary>
    /// Flattens a (possibly nested) module's types into the context's type list, stamping
    /// each with its module path, and records the module names for collision checks (R13.3).
    /// </summary>
    private void FlattenModule(
        KoineParser.ModuleDeclContext ctx, IReadOnlyList<string> parentPath,
        List<TypeDecl> types, List<string> moduleNames)
    {
        var name = ctx.Identifier().GetText();
        moduleNames.Add(name);
        var path = parentPath.Append(name).ToList();

        foreach (KoineParser.ModuleMemberContext? member in ctx.moduleMember())
        {
            if (member.typeDecl() is { } t)
            {
                types.Add(WithModulePath(BuildTypeDecl(t), path));
            }
            else if (member.moduleDecl() is { } nested)
            {
                FlattenModule(nested, path, types, moduleNames);
            }
        }
    }

    /// <summary>Stamps a module path onto a declaration (and recursively onto an aggregate's nested types).</summary>
    private static TypeDecl WithModulePath(TypeDecl decl, IReadOnlyList<string> path) => decl switch
    {
        AggregateDecl agg => agg with
        {
            ModulePath = path,
            Types = agg.Types.Select(n => WithModulePath(n, path)).ToList()
        },
        _ => decl with { ModulePath = path }
    };

    private SpecDecl BuildSpec(KoineParser.SpecDeclContext ctx) =>
        new(ctx.Identifier().GetText(), ctx.typeName().GetText(), BuildExpression(ctx.expression()))
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };

    private ServiceDecl BuildService(KoineParser.ServiceDeclContext ctx)
    {
        var operations = new List<OperationDecl>();
        var useCases = new List<UseCaseDecl>();
        foreach (KoineParser.ServiceMemberContext? member in ctx.serviceMember())
        {
            if (member.operationDecl() is { } op)
            {
                operations.Add(BuildOperation(op));
            }
            else if (member.usecaseDecl() is { } uc)
            {
                useCases.Add(BuildUseCase(uc));
            }
        }
        return new ServiceDecl(ctx.Identifier().GetText(), operations, useCases) { Span = SpanOf(ctx), Doc = DocFor(ctx) };
    }

    private UseCaseDecl BuildUseCase(KoineParser.UsecaseDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        TypeRef? returnType = ctx.typeRef() is { } tr ? BuildTypeRef(tr) : null;
        return new UseCaseDecl(ctx.Identifier().GetText(), parameters, returnType)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private ReadModelDecl BuildReadModel(KoineParser.ReadmodelDeclContext ctx)
    {
        var fields = ctx.readmodelField().Select(f =>
        {
            TypeRef? type = f.typeRef() is { } tr ? BuildTypeRef(tr) : null;
            Expr? projection = f.expression() is { } e ? BuildExpression(e) : null;
            return new ReadModelField(f.softName().GetText(), type, projection) { Span = SpanOf(f) };
        }).ToList();
        return new ReadModelDecl(ctx.Identifier().GetText(), ctx.typeName().GetText(), fields)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private QueryDecl BuildQuery(KoineParser.QueryDeclContext ctx)
    {
        List<Param> criteria = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        return new QueryDecl(ctx.Identifier().GetText(), criteria, BuildTypeRef(ctx.typeRef()))
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private OperationDecl BuildOperation(KoineParser.OperationDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        Expr? body = ctx.expression() is { } e ? BuildExpression(e) : null;
        return new OperationDecl(ctx.Identifier().GetText(), parameters, BuildTypeRef(ctx.typeRef()), body)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private PolicyDecl BuildPolicy(KoineParser.PolicyDeclContext ctx)
    {
        KoineParser.PolicyReactionContext? reactionCtx = ctx.policyReaction();
        List<PolicyArg> args = reactionCtx.policyArgList() is { } al
            ? al.policyArg().Select(a =>
                new PolicyArg(a.softName().GetText(), BuildExpression(a.expression())) { Span = SpanOf(a) }).ToList()
            : new List<PolicyArg>();
        var reaction = new PolicyReaction(reactionCtx.typeName().GetText(), reactionCtx.softName().GetText(), args)
        {
            Span = SpanOf(reactionCtx)
        };
        // `when <Identifier>` is the event; the policy's own name is Identifier(0).
        return new PolicyDecl(ctx.Identifier(0).GetText(), ctx.Identifier(1).GetText(), reaction)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private TypeDecl BuildTypeDecl(KoineParser.TypeDeclContext ctx)
    {
        if (ctx.valueDecl() is { } value)
        {
            return BuildValue(value);
        }

        if (ctx.quantityDecl() is { } quantity)
        {
            return BuildQuantity(quantity);
        }

        if (ctx.entityDecl() is { } entity)
        {
            return BuildEntity(entity);
        }

        if (ctx.aggregateDecl() is { } aggregate)
        {
            return BuildAggregate(aggregate);
        }

        if (ctx.enumDecl() is { } @enum)
        {
            return BuildEnum(@enum);
        }

        if (ctx.eventDecl() is { } @event)
        {
            return BuildEvent(@event);
        }

        if (ctx.integrationEventDecl() is { } integrationEvent)
        {
            return BuildIntegrationEvent(integrationEvent);
        }

        throw new InvalidOperationException("Unknown type declaration.");
    }

    private ValueObjectDecl BuildValue(KoineParser.ValueDeclContext ctx)
    {
        var members = ctx.member().Select(BuildMember).ToList();
        var invariants = ctx.invariant().Select(BuildInvariant).ToList();
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new ValueObjectDecl(ctx.Identifier().GetText(), members, invariants)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private ValueObjectDecl BuildQuantity(KoineParser.QuantityDeclContext ctx)
    {
        var members = ctx.member().Select(BuildMember).ToList();
        var invariants = ctx.invariant().Select(BuildInvariant).ToList();
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new ValueObjectDecl(ctx.Identifier().GetText(), members, invariants, IsQuantity: true)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
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
        (IdentityStrategy strategy, var backing) = BuildIdentityStrategy(ctx.identityStrategy());
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new EntityDecl(name, identityName, members, invariants, commands, states, factories, strategy, backing)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    /// <summary>Reads the optional <c>as guid|sequence|natural(T)</c> identity strategy (R11.1).</summary>
    private (IdentityStrategy Strategy, string? Backing) BuildIdentityStrategy(
        KoineParser.IdentityStrategyContext? ctx)
    {
        if (ctx is null || ctx.GUID() is not null)
        {
            return (IdentityStrategy.Guid, null);
        }

        if (ctx.SEQUENCE() is not null)
        {
            return (IdentityStrategy.Sequence, null);
        }

        // natural(T): the wrapped primitive's name.
        return (IdentityStrategy.Natural, ctx.typeName().GetText());
    }

    private StatesDecl BuildStates(KoineParser.StatesDeclContext ctx)
    {
        var rules = ctx.stateRule().Select(BuildStateRule).ToList();
        return new StatesDecl(ctx.softName().GetText(), rules) { Span = SpanOf(ctx) };
    }

    private StateRule BuildStateRule(KoineParser.StateRuleContext ctx)
    {
        ITerminalNode[]? ids = ctx.Identifier();
        var from = ids[0].GetText();
        var to = ids.Skip(1).Select(id => id.GetText()).ToList();
        Expr? guard = ctx.expression() is { } g ? BuildExpression(g) : null;
        return new StateRule(from, to, guard) { Span = SpanOf(ctx) };
    }

    private CommandDecl BuildCommand(KoineParser.CommandDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        var body = ctx.commandStmt().Select(BuildCommandStmt).ToList();
        TypeRef? returnType = ctx.typeRef() is { } tr ? BuildTypeRef(tr) : null;

        return new CommandDecl(ctx.Identifier().GetText(), parameters, body, returnType)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private Param BuildParam(KoineParser.ParamContext ctx) =>
        new(ctx.softName().GetText(), BuildTypeRef(ctx.typeRef())) { Span = SpanOf(ctx) };

    private FactoryDecl BuildFactory(KoineParser.FactoryDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        var body = ctx.factoryStmt().Select(BuildFactoryStmt).ToList();

        return new FactoryDecl(ctx.Identifier().GetText(), parameters, body)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx)
        };
    }

    private CommandStmt BuildFactoryStmt(KoineParser.FactoryStmtContext ctx)
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
            List<EmitArg> args = emit.emitArgList() is { } al
                ? al.emitArg().Select(a =>
                    new EmitArg(a.softName().GetText(), BuildExpression(a.expression())) { Span = SpanOf(a) }).ToList()
                : new List<EmitArg>();
            return new EmitClause(emit.Identifier().GetText(), args) { Span = SpanOf(emit) };
        }

        KoineParser.InitializationContext? init = ctx.initialization();
        return new Initialization(init.softName().GetText(), BuildExpression(init.expression()))
        {
            Span = SpanOf(init)
        };
    }

    private CommandStmt BuildCommandStmt(KoineParser.CommandStmtContext ctx)
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
            List<EmitArg> args = emit.emitArgList() is { } al
                ? al.emitArg().Select(a =>
                    new EmitArg(a.softName().GetText(), BuildExpression(a.expression())) { Span = SpanOf(a) }).ToList()
                : new List<EmitArg>();
            return new EmitClause(emit.Identifier().GetText(), args) { Span = SpanOf(emit) };
        }

        if (ctx.resultClause() is { } res)
        {
            return new ResultClause(BuildExpression(res.expression())) { Span = SpanOf(res) };
        }

        KoineParser.TransitionContext? transition = ctx.transition();
        return new Transition(transition.softName().GetText(), BuildExpression(transition.expression()))
        {
            Span = SpanOf(transition)
        };
    }

    private AggregateDecl BuildAggregate(KoineParser.AggregateDeclContext ctx)
    {
        var types = new List<TypeDecl>();
        var specs = new List<SpecDecl>();
        RepositoryDecl? repository = null;
        foreach (KoineParser.AggregateMemberContext? member in ctx.aggregateMember())
        {
            if (member.typeDecl() is { } t)
            {
                types.Add(BuildTypeDecl(t));
            }
            else if (member.specDecl() is { } s)
            {
                specs.Add(BuildSpec(s));
            }
            else if (member.repositoryDecl() is { } r)
            {
                repository = BuildRepository(r);
            }
        }

        var name = ctx.Identifier(0).GetText();
        var rootName = ctx.Identifier(1).GetText();
        var versioned = ctx.VERSIONED() is not null;
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new AggregateDecl(name, rootName, types, specs, versioned, repository)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private RepositoryDecl BuildRepository(KoineParser.RepositoryDeclContext ctx)
    {
        List<string>? operations = ctx.operationsClause() is { } ops
            ? ops.Identifier().Select(i => i.GetText()).ToList()
            : null;
        var finders = ctx.finderDecl().Select(BuildFinder).ToList();
        return new RepositoryDecl(operations, finders) { Span = SpanOf(ctx) };
    }

    private FinderDecl BuildFinder(KoineParser.FinderDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();
        return new FinderDecl(ctx.Identifier().GetText(), parameters, BuildTypeRef(ctx.typeRef()))
        {
            Span = SpanOf(ctx)
        };
    }

    private EnumDecl BuildEnum(KoineParser.EnumDeclContext ctx)
    {
        List<Param> signature = ctx.paramList() is { } pl
            ? pl.param().Select(BuildParam).ToList()
            : new List<Param>();

        var members = ctx.enumMember()
            .Select(m => new EnumMember(
                m.Identifier().GetText(),
                m.expression().Select(BuildExpression).ToList())
            { Span = SpanOf(m) })
            .ToList();

        var (since, deprecated) = ReadAnnotations(ctx.annotation());
        return new EnumDecl(ctx.Identifier().GetText(), members, signature)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private EventDecl BuildEvent(KoineParser.EventDeclContext ctx)
    {
        var members = ctx.member().Select(BuildMember).ToList();
        var (since, deprecated) = ReadAnnotations(ctx.annotation());
        return new EventDecl(ctx.Identifier().GetText(), members)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private IntegrationEventDecl BuildIntegrationEvent(KoineParser.IntegrationEventDeclContext ctx)
    {
        var members = ctx.member().Select(BuildMember).ToList();
        var (since, deprecated) = ReadAnnotations(ctx.annotation());
        return new IntegrationEventDecl(ctx.Identifier().GetText(), members)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private Member BuildMember(KoineParser.MemberContext ctx)
    {
        TypeRef type = BuildTypeRef(ctx.typeRef());
        Expr? initializer = ctx.expression() is { } expr ? BuildExpression(expr) : null;
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new Member(ctx.softName().GetText(), type, initializer)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            Since = since,
            Deprecated = deprecated
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
        {
            return null;
        }

        IList<IToken>? hidden = _tokens.GetHiddenTokensToLeft(ctx.Start.TokenIndex, KoineLexer.DOC);
        if (hidden is null || hidden.Count == 0)
        {
            return null;
        }

        // Only a contiguous run of `///` lines sitting on their OWN lines directly
        // above the declaration is its doc. This excludes a `///` trailing the
        // previous declaration's line, and a doc separated by a blank line.
        var previousVisibleLine = PreviousVisibleLine(ctx.Start.TokenIndex);
        var lines = new List<string>();
        var expectedLine = ctx.Start.Line - 1;

        for (var i = hidden.Count - 1; i >= 0; i--)
        {
            IToken t = hidden[i];
            if (t.Type != KoineLexer.DocComment)
            {
                continue;
            }

            if (t.Line != expectedLine)
            {
                break;            // not adjacent (gap / blank line)
            }

            if (t.Line == previousVisibleLine)
            {
                break;     // trailing comment on prior code
            }

            lines.Add(StripDocPrefix(t.Text));
            expectedLine = t.Line - 1;
        }

        if (lines.Count == 0)
        {
            return null;
        }

        lines.Reverse();
        return string.Join("\n", lines);
    }

    /// <summary>The line of the nearest preceding default-channel (visible) token, or -1.</summary>
    private int PreviousVisibleLine(int tokenIndex)
    {
        for (var i = tokenIndex - 1; i >= 0; i--)
        {
            IToken? t = _tokens!.Get(i);
            if (t.Channel == TokenConstants.DefaultChannel)
            {
                return t.Line;
            }
        }
        return -1;
    }

    private string StripDocPrefix(string text)
    {
        var body = text.Length >= 3 ? text[3..] : string.Empty; // drop leading "///"
        return body.StartsWith(' ') ? body[1..].TrimEnd() : body.TrimEnd();
    }

    private TypeRef BuildTypeRef(KoineParser.TypeRefContext ctx)
    {
        KoineParser.TypeRefContext[]? args = ctx.typeRef();
        TypeRef? element = args.Length > 0 ? BuildTypeRef(args[0]) : null;
        TypeRef? value = args.Length > 1 ? BuildTypeRef(args[1]) : null;
        var isOptional = ctx.QUESTION() is not null;

        // `(typeName DOT)? typeName`: a leading qualifier names the owning context (R13.2).
        KoineParser.TypeNameContext[]? names = ctx.typeName();
        var hasQualifier = names.Length == 2;
        var qualifier = hasQualifier ? names[0].GetText() : null;
        var name = names[hasQualifier ? 1 : 0].GetText();

        return new TypeRef(name, element, value, isOptional, qualifier) { Span = SpanOf(ctx) };
    }

    private Invariant BuildInvariant(KoineParser.InvariantContext ctx)
    {
        Expr condition = BuildExpression(ctx.expression());
        var message = ctx.StringLiteral() is { } str
            ? UnescapeString(StripQuotes(str.GetText()))
            : null;

        return new Invariant(condition, message) { Span = SpanOf(ctx), Doc = DocFor(ctx) };
    }

    // ------------------------------------------------------------------------
    // Expressions
    // ------------------------------------------------------------------------

    private Expr BuildExpression(KoineParser.ExpressionContext ctx) =>
        BuildLet(ctx.letExpr());

    private Expr BuildLet(KoineParser.LetExprContext ctx)
    {
        // No `let` keyword => the plain `guardExpr` fall-through (every existing expression).
        if (ctx.LET() is null)
        {
            return BuildGuard(ctx.guardExpr());
        }

        var bindings = ctx.letBinding()
            .Select(b => new LetBinding(b.softName().GetText(), BuildExpression(b.expression())))
            .ToList();
        Expr body = BuildLet(ctx.letExpr());
        return new LetExpr(bindings, body) { Span = SpanOf(ctx) };
    }

    private Expr BuildGuard(KoineParser.GuardExprContext ctx)
    {
        Expr body = BuildCond(ctx.condExpr(0));

        if (ctx.WHEN() is null)
        {
            return body;
        }

        Expr condition = BuildCond(ctx.condExpr(1));
        return new GuardExpr(body, condition) { Span = SpanOf(ctx) };
    }

    private Expr BuildCond(KoineParser.CondExprContext ctx)
    {
        if (ctx.IF() is null)
        {
            return BuildCoalesce(ctx.coalesceExpr());
        }

        Expr condition = BuildCond(ctx.condExpr(0));
        Expr then = BuildCond(ctx.condExpr(1));
        Expr @else = BuildCond(ctx.condExpr(2));
        return new ConditionalExpr(condition, then, @else) { Span = SpanOf(ctx) };
    }

    private Expr BuildCoalesce(KoineParser.CoalesceExprContext ctx)
    {
        KoineParser.OrExprContext[]? operands = ctx.orExpr();
        Expr result = BuildOr(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            result = new CoalesceExpr(result, BuildOr(operands[i])) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private Expr BuildOr(KoineParser.OrExprContext ctx)
    {
        KoineParser.AndExprContext[]? operands = ctx.andExpr();
        Expr result = BuildAnd(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            Expr right = BuildAnd(operands[i]);
            result = new BinaryExpr(BinaryOp.Or, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private Expr BuildAnd(KoineParser.AndExprContext ctx)
    {
        KoineParser.EqualityExprContext[]? operands = ctx.equalityExpr();
        Expr result = BuildEquality(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            Expr right = BuildEquality(operands[i]);
            result = new BinaryExpr(BinaryOp.And, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private Expr BuildEquality(KoineParser.EqualityExprContext ctx)
    {
        KoineParser.RelationalExprContext[]? operands = ctx.relationalExpr();
        Expr result = BuildRelational(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            BinaryOp op = OperatorAt(ctx, i - 1);
            Expr right = BuildRelational(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private Expr BuildRelational(KoineParser.RelationalExprContext ctx)
    {
        KoineParser.MatchExprContext[]? operands = ctx.matchExpr();
        Expr result = BuildMatch(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            BinaryOp op = OperatorAt(ctx, i - 1);
            Expr right = BuildMatch(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private Expr BuildMatch(KoineParser.MatchExprContext ctx)
    {
        Expr target = BuildAdditive(ctx.additiveExpr());

        if (ctx.MATCHES() is null)
        {
            return target;
        }

        var pattern = StripSlashes(ctx.Regex().GetText());
        return new MatchExpr(target, pattern) { Span = SpanOf(ctx) };
    }

    private Expr BuildAdditive(KoineParser.AdditiveExprContext ctx)
    {
        KoineParser.MultiplicativeExprContext[]? operands = ctx.multiplicativeExpr();
        Expr result = BuildMultiplicative(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            BinaryOp op = OperatorAt(ctx, i - 1);
            Expr right = BuildMultiplicative(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private Expr BuildMultiplicative(KoineParser.MultiplicativeExprContext ctx)
    {
        KoineParser.UnaryExprContext[]? operands = ctx.unaryExpr();
        Expr result = BuildUnary(operands[0]);

        for (var i = 1; i < operands.Length; i++)
        {
            BinaryOp op = OperatorAt(ctx, i - 1);
            Expr right = BuildUnary(operands[i]);
            result = new BinaryExpr(op, result, right) { Span = SpanOf(ctx) };
        }

        return result;
    }

    private Expr BuildUnary(KoineParser.UnaryExprContext ctx)
    {
        if (ctx.NOT() is not null)
        {
            return new UnaryExpr(UnaryOp.Not, BuildUnary(ctx.unaryExpr())) { Span = SpanOf(ctx) };
        }

        if (ctx.MINUS() is not null)
        {
            return new UnaryExpr(UnaryOp.Negate, BuildUnary(ctx.unaryExpr())) { Span = SpanOf(ctx) };
        }

        return BuildPostfix(ctx.postfixExpr());
    }

    private Expr BuildPostfix(KoineParser.PostfixExprContext ctx)
    {
        Expr result = BuildPrimary(ctx.primary());

        // Walk the trailing `.member` / `.method(args)` chain in source order.
        IList<IParseTree>? children = ctx.children;
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

    private IReadOnlyList<Expr> BuildArgList(KoineParser.ArgListContext ctx) =>
        ctx.argument().Select(BuildArgument).ToList();

    private Expr BuildArgument(KoineParser.ArgumentContext ctx) =>
        ctx.lambda() is { } lambda
            ? BuildLambda(lambda)
            : BuildExpression(ctx.expression());

    private Expr BuildLambda(KoineParser.LambdaContext ctx) =>
        new LambdaExpr(ctx.softName().GetText(), BuildExpression(ctx.expression()))
        {
            Span = SpanOf(ctx)
        };

    private Expr BuildPrimary(KoineParser.PrimaryContext ctx)
    {
        if (ctx.literal() is { } literal)
        {
            return BuildLiteral(literal);
        }

        if (ctx.exprName() is { } identifier)
        {
            return new IdentifierExpr(identifier.GetText()) { Span = SpanOf(ctx) };
        }

        // Parenthesized expression.
        return BuildExpression(ctx.expression());
    }

    private Expr BuildLiteral(KoineParser.LiteralContext ctx)
    {
        if (ctx.IntLiteral() is { } intLit)
        {
            return new LiteralExpr(LiteralKind.Int, intLit.GetText()) { Span = SpanOf(ctx) };
        }

        if (ctx.DecimalLiteral() is { } decLit)
        {
            return new LiteralExpr(LiteralKind.Decimal, decLit.GetText()) { Span = SpanOf(ctx) };
        }

        if (ctx.BoolLiteral() is { } boolLit)
        {
            return new LiteralExpr(LiteralKind.Bool, boolLit.GetText()) { Span = SpanOf(ctx) };
        }

        // String literal: inner content, unescaped, no surrounding quotes.
        var text = UnescapeString(StripQuotes(ctx.StringLiteral().GetText()));
        return new LiteralExpr(LiteralKind.String, text) { Span = SpanOf(ctx) };
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private SourceSpan SpanOf(ParserRuleContext ctx) =>
        new(ctx.Start.Line, ctx.Start.Column + 1, _file);

    /// <summary>
    /// Picks the n-th binary operator (0-based) among a rule's child terminals,
    /// mapping its source text to the corresponding <see cref="BinaryOp"/>.
    /// </summary>
    private BinaryOp OperatorAt(ParserRuleContext ctx, int index)
    {
        var seen = 0;
        for (var i = 0; i < ctx.ChildCount; i++)
        {
            if (ctx.GetChild(i) is Antlr4.Runtime.Tree.ITerminalNode terminal
                && TryMapOperator(terminal.GetText(), out BinaryOp op))
            {
                if (seen == index)
                {
                    return op;
                }

                seen++;
            }
        }

        throw new InvalidOperationException($"No binary operator at index {index}.");
    }

    private bool TryMapOperator(string text, out BinaryOp op)
    {
        switch (text)
        {
            case "||":
                op = BinaryOp.Or;
                return true;
            case "&&":
                op = BinaryOp.And;
                return true;
            case "==":
                op = BinaryOp.Eq;
                return true;
            case "!=":
                op = BinaryOp.Neq;
                return true;
            case "<":
                op = BinaryOp.Lt;
                return true;
            case "<=":
                op = BinaryOp.Le;
                return true;
            case ">":
                op = BinaryOp.Gt;
                return true;
            case ">=":
                op = BinaryOp.Ge;
                return true;
            case "+":
                op = BinaryOp.Add;
                return true;
            case "-":
                op = BinaryOp.Sub;
                return true;
            case "*":
                op = BinaryOp.Mul;
                return true;
            case "/":
                op = BinaryOp.Div;
                return true;
            default:
                op = default;
                return false;
        }
    }

    private string StripQuotes(string text) =>
        text.Length >= 2 ? text[1..^1] : text;

    private string StripSlashes(string text) =>
        text.Length >= 2 ? text[1..^1] : text;

    /// <summary>
    /// Decodes the escape sequences the lexer's <c>StringLiteral</c> rule permits,
    /// in a single left-to-right pass. Recognizes <c>\" \\ \n \t \r \0 \b \f \v</c>;
    /// any other escape is passed through with its character (e.g. <c>\d</c> -> <c>d</c>).
    /// </summary>
    private string UnescapeString(string text)
    {
        if (text.IndexOf('\\') < 0)
        {
            return text;
        }

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
