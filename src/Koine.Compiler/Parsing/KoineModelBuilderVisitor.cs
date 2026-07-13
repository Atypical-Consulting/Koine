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
        var contexts = new List<ContextNode>(members.Length);
        foreach (KoineParser.ProgramMemberContext m in members)
        {
            if (m.contextDecl() is { } c)
            {
                contexts.Add(BuildContext(c));
            }
        }

        // Relations from every contextmap block in this unit, concatenated (R14.1).
        var relations = new List<ContextRelation>();
        foreach (KoineParser.ProgramMemberContext m in members)
        {
            if (m.contextMapDecl() is { } cm)
            {
                foreach (KoineParser.RelationDeclContext r in cm.relationDecl())
                {
                    relations.Add(BuildRelation(r));
                }
            }
        }
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
            NameOf(ctx.Identifier()), types, specs, services, policies, imports, moduleNames, publishes, subscribes)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
            Version = version,
            Errors = HarvestErrors(ctx)
        };
    }

    /// <summary>
    /// Walks the ANTLR error-recovery subtree under a context and surfaces every recovery point
    /// as a target-agnostic <see cref="ErrorNode"/> marker, instead of silently dropping it
    /// (resilient syntax). Two cases are collected:
    /// <list type="bullet">
    /// <item>each <see cref="IErrorNode"/> terminal for a skipped/unexpected token → a marker over
    /// that token's source range;</item>
    /// <item>each ANTLR-synthesized <b>missing</b> token (single-token insertion during recovery,
    /// detected by its zero/negative geometry — <c>StartIndex &gt; StopIndex</c>) → a marker with
    /// <see cref="KoineNode.IsMissing"/> set and a zero-length span at the insertion point.</item>
    /// </list>
    /// </summary>
    private IReadOnlyList<ErrorNode> HarvestErrors(IParseTree node)
    {
        var errors = new List<ErrorNode>();
        CollectErrors(node, errors);
        return errors.Count == 0 ? [] : errors;
    }

    private void CollectErrors(IParseTree node, List<ErrorNode> sink)
    {
        if (node is IErrorNode errorNode)
        {
            IToken token = errorNode.Symbol;

            // An ANTLR-inserted phantom token (single-token insertion) has no backing source text.
            // ANTLR renders such a token's Text as the synthesized "<missing '...'>" form (and gives
            // it zero/negative geometry, StartIndex > StopIndex). A genuinely skipped or unexpected
            // token carries its real source text and geometry. Detect the phantom by either signal.
            var missing = token.StartIndex > token.StopIndex
                || (token.Text is { } txt && txt.StartsWith("<missing", StringComparison.Ordinal));
            if (missing)
            {
                // Zero-length point span at the insertion point; the phantom occupies no source.
                var point = TokenGeometry.SpanOf(token, _file) with { Length = 0, EndLine = token.Line, EndColumn = token.Column + 1 };
                sink.Add(new ErrorNode(token.Text ?? string.Empty) { Span = point, IsMissing = true });
            }
            else
            {
                sink.Add(new ErrorNode(token.Text ?? string.Empty)
                {
                    Span = TokenGeometry.SpanOf(token, _file),
                    LeafText = token.Text
                });
            }

            return;
        }

        for (var i = 0; i < node.ChildCount; i++)
        {
            CollectErrors(node.GetChild(i), sink);
        }
    }

    /// <summary>
    /// Reads the <c>@since(n)</c> / <c>@deprecated("reason")</c> evolution annotations preceding
    /// a type or field declaration (R15.1). Unknown annotation names are ignored.
    /// </summary>
    private (int? Since, string? Deprecated) ReadAnnotations(IReadOnlyList<KoineParser.AnnotationContext> annotations)
    {
        int? since = null;
        string? deprecated = null;
        for (var i = 0; i < annotations.Count; i++)
        {
            KoineParser.AnnotationContext a = annotations[i];
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
        var bidirectional = ctx.relationArrow()?.BIARROW() is not null;
        List<string> sharedTypes = ctx.sharedKernelBlock() is { } sk
            ? Map(sk.typeName(), static t => t.GetText())
            : new List<string>();
        List<AclMapping> aclMappings = ctx.aclBlock() is { } acl
            ? Map(acl.aclMapping(), BuildAclMapping)
            : new List<AclMapping>();

        // On a recovered (error) parse a half-typed relation can be missing one or both type names
        // (e.g. `contextmap { A }`); fall back to an empty name rather than indexing past the end.
        // The syntax error is already reported by the error listener.
        var source = names.Length > 0 ? names[0].GetText() : string.Empty;
        var target = names.Length > 1 ? names[1].GetText() : string.Empty;

        return new ContextRelation(
            source, target, kind, bidirectional, sharedTypes, aclMappings)
        {
            Span = SpanOf(ctx)
        };
    }

    private static ContextRelationKind BuildRelationKind(KoineParser.RelationRoleContext? ctx)
    {
        // On a recovered (error) parse the role after `:` can be missing entirely; default to the
        // grammar's fall-through kind rather than dereferencing null.
        if (ctx is null)
        {
            return ContextRelationKind.PublishedLanguage;
        }

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
        // On a recovered (error) parse a half-typed mapping can be missing its `-> Z.W` (or a type
        // half), so `qualifiedType`/`typeName` children can be null; fall back to an empty name rather
        // than dereferencing null, mirroring BuildTypeRef. The syntax error is reported elsewhere.
        return new AclMapping(
            from?.typeName(0)?.GetText() ?? string.Empty, from?.typeName(1)?.GetText() ?? string.Empty,
            to?.typeName(0)?.GetText() ?? string.Empty, to?.typeName(1)?.GetText() ?? string.Empty)
        {
            Span = SpanOf(ctx)
        };
    }

    private PublishDecl BuildPublish(KoineParser.PublishDeclContext ctx) =>
        // On a recovered (error) parse a half-typed `publishes` can be missing its event name, so the
        // singular `typeName()` accessor can be null; fall back to an empty name rather than
        // dereferencing null. The syntax error is already reported by the error listener.
        new(ctx.typeName()?.GetText() ?? string.Empty) { Span = SpanOf(ctx) };

    private SubscribeDecl BuildSubscribe(KoineParser.SubscribeDeclContext ctx)
    {
        KoineParser.TypeNameContext[]? names = ctx.typeName();
        // On a recovered (error) parse a half-typed `subscribes Foo` (or `subscribes` alone) yields
        // fewer than two type names; fall back to an empty name rather than indexing past the end,
        // mirroring the #595 BuildRelation fix. The syntax error is reported elsewhere.
        var from = names.Length > 0 ? names[0].GetText() : string.Empty;
        var @event = names.Length > 1 ? names[1].GetText() : string.Empty;
        return new SubscribeDecl(from, @event) { Span = SpanOf(ctx) };
    }

    private ImportDecl BuildImport(KoineParser.ImportDeclContext ctx)
    {
        KoineParser.TypeNameContext[]? names = ctx.typeName();
        var isWildcard = ctx.STAR() is not null;
        // On a recovered (error) parse a truncated `import` (e.g. `import Foo.`) can yield fewer type
        // names than the grammar requires; guard `names` length before indexing/skipping rather than
        // throwing. The syntax error is reported elsewhere.
        List<string> imported;
        if (isWildcard)
        {
            imported = new List<string>();
        }
        else
        {
            imported = new List<string>(Math.Max(0, names.Length - 1));
            for (var i = 1; i < names.Length; i++)
            {
                imported.Add(names[i].GetText());
            }
        }
        var module = names.Length > 0 ? names[0].GetText() : string.Empty;
        return new ImportDecl(module, imported, isWildcard) { Span = SpanOf(ctx) };
    }

    /// <summary>
    /// Flattens a (possibly nested) module's types into the context's type list, stamping
    /// each with its module path, and records the module names for collision checks (R13.3).
    /// </summary>
    private void FlattenModule(
        KoineParser.ModuleDeclContext ctx, IReadOnlyList<string> parentPath,
        List<TypeDecl> types, List<string> moduleNames)
    {
        var name = NameOf(ctx.Identifier());
        moduleNames.Add(name);
        var path = new List<string>(parentPath.Count + 1);
        path.AddRange(parentPath);
        path.Add(name);

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
            Types = WithModulePath(agg.Types, path)
        },
        _ => decl with { ModulePath = path }
    };

    /// <summary>Stamps a module path onto each declaration in a pre-sized list (avoids a capturing Select closure).</summary>
    private static List<TypeDecl> WithModulePath(IReadOnlyList<TypeDecl> types, IReadOnlyList<string> path)
    {
        var list = new List<TypeDecl>(types.Count);
        for (var i = 0; i < types.Count; i++)
        {
            list.Add(WithModulePath(types[i], path));
        }

        return list;
    }

    private SpecDecl BuildSpec(KoineParser.SpecDeclContext ctx) =>
        // On a recovered (error) parse a missing `on <Type>` clause leaves `typeName()` absent; fall
        // back to an empty placeholder rather than throwing (mirrors BuildAggregate, #1298).
        new(NameOf(ctx.Identifier()), ctx.typeName()?.GetText() ?? string.Empty, BuildExpression(ctx.expression()))
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
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
        return new ServiceDecl(NameOf(ctx.Identifier()), operations, useCases)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
        };
    }

    private UseCaseDecl BuildUseCase(KoineParser.UsecaseDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? Map(pl.param(), BuildParam)
            : new List<Param>();
        TypeRef? returnType = ctx.typeRef() is { } tr ? BuildTypeRef(tr) : null;
        return new UseCaseDecl(NameOf(ctx.Identifier()), parameters, returnType)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
        };
    }

    private ReadModelDecl BuildReadModel(KoineParser.ReadmodelDeclContext ctx)
    {
        KoineParser.ReadmodelFieldContext[] fieldCtxs = ctx.readmodelField();
        var fields = new List<ReadModelField>(fieldCtxs.Length);
        foreach (KoineParser.ReadmodelFieldContext f in fieldCtxs)
        {
            TypeRef? type = f.typeRef() is { } tr ? BuildTypeRef(tr) : null;
            Expr? projection = f.expression() is { } e ? BuildExpression(e) : null;
            fields.Add(new ReadModelField(f.softName().GetText(), type, projection)
            {
                Span = SpanOf(f),
                NameSpan = SpanOf(f.softName())
            });
        }
        // On a recovered (error) parse a missing `from <Type>` clause leaves `typeName()` absent; fall
        // back to an empty placeholder rather than throwing (mirrors BuildAggregate, #1298).
        return new ReadModelDecl(NameOf(ctx.Identifier()), ctx.typeName()?.GetText() ?? string.Empty, fields)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
        };
    }

    private QueryDecl BuildQuery(KoineParser.QueryDeclContext ctx)
    {
        List<Param> criteria = ctx.paramList() is { } pl
            ? Map(pl.param(), BuildParam)
            : new List<Param>();
        return new QueryDecl(NameOf(ctx.Identifier()), criteria, BuildTypeRef(ctx.typeRef()))
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
        };
    }

    private OperationDecl BuildOperation(KoineParser.OperationDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? Map(pl.param(), BuildParam)
            : new List<Param>();
        Expr? body = ctx.expression() is { } e ? BuildExpression(e) : null;
        return new OperationDecl(NameOf(ctx.Identifier()), parameters, BuildTypeRef(ctx.typeRef()), body)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
        };
    }

    private PolicyDecl BuildPolicy(KoineParser.PolicyDeclContext ctx)
    {
        KoineParser.PolicyReactionContext? reactionCtx = ctx.policyReaction();
        PolicyReaction reaction;
        if (reactionCtx is null)
        {
            // Recovered (error) parse: `policy <Name> when <Event> then` with no reaction after `then`
            // (a normal mid-typing state in the live editor). Yield an empty-placeholder reaction
            // rather than throwing — the syntax error itself is reported by the parser's error path.
            reaction = new PolicyReaction(string.Empty, string.Empty, new List<PolicyArg>()) { Span = SpanOf(ctx) };
        }
        else
        {
            // Read names null-tolerantly so a partial reaction (e.g. a missing field token) on a
            // recovered tree still builds, mirroring BuildEmitClause.
            List<PolicyArg> args;
            if (reactionCtx.policyArgList() is { } al)
            {
                KoineParser.PolicyArgContext[] argCtxs = al.policyArg();
                args = new List<PolicyArg>(argCtxs.Length);
                foreach (KoineParser.PolicyArgContext a in argCtxs)
                {
                    args.Add(new PolicyArg(a.softName()?.GetText() ?? string.Empty, BuildExpression(a.expression())) { Span = SpanOf(a) });
                }
            }
            else
            {
                args = new List<PolicyArg>();
            }
            reaction = new PolicyReaction(reactionCtx.typeName()?.GetText() ?? string.Empty, reactionCtx.softName()?.GetText() ?? string.Empty, args)
            {
                Span = SpanOf(reactionCtx)
            };
        }

        // `when <Identifier>` is the event; the policy's own name is Identifier(0). NameOf already
        // tolerates the second Identifier context being absent on a recovered (error) parse of a
        // missing `when <Event>` clause (#1298).
        return new PolicyDecl(ctx.Identifier(0).GetText(), NameOf(ctx.Identifier(1)), reaction)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier(0)),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
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

    /// <summary>
    /// Projects an ANTLR rule-context list into a pre-sized <see cref="List{T}"/>. The generated
    /// accessors return arrays with a known length, but <c>.Select(build).ToList()</c> erases that
    /// length — so the list regrows geometrically — and allocates a Select iterator. This avoids both.
    /// </summary>
    private static List<TDst> Map<TSrc, TDst>(IReadOnlyList<TSrc> src, Func<TSrc, TDst> build)
    {
        var list = new List<TDst>(src.Count);
        for (var i = 0; i < src.Count; i++)
        {
            list.Add(build(src[i]));
        }

        return list;
    }

    private ValueObjectDecl BuildValue(KoineParser.ValueDeclContext ctx)
    {
        var members = Map(ctx.member(), BuildMember);
        var invariants = Map(ctx.invariant(), BuildInvariant);
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new ValueObjectDecl(NameOf(ctx.Identifier()), members, invariants)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private ValueObjectDecl BuildQuantity(KoineParser.QuantityDeclContext ctx)
    {
        var members = Map(ctx.member(), BuildMember);
        var invariants = Map(ctx.invariant(), BuildInvariant);
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new ValueObjectDecl(NameOf(ctx.Identifier()), members, invariants, IsQuantity: true)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private EntityDecl BuildEntity(KoineParser.EntityDeclContext ctx)
    {
        var members = Map(ctx.member(), BuildMember);
        var invariants = Map(ctx.invariant(), BuildInvariant);
        var states = Map(ctx.statesDecl(), BuildStates);
        var commands = Map(ctx.commandDecl(), BuildCommand);
        var factories = Map(ctx.factoryDecl(), BuildFactory);

        var name = ctx.Identifier(0).GetText();
        // NameOf already tolerates the second Identifier context being absent on a recovered (error)
        // parse of a missing `identified by <Identity>` clause (#1298).
        var identityName = NameOf(ctx.Identifier(1));
        (IdentityStrategy strategy, var backing) = BuildIdentityStrategy(ctx.identityStrategy());
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new EntityDecl(name, identityName, members, invariants, commands, states, factories, strategy, backing)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier(0)),
            IdentityNameSpan = SpanOf(ctx.Identifier(1)),
            IdentityStrategySpan = ctx.identityStrategy() is { } strat ? SpanOf(strat) : SourceSpan.None,
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
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

        // natural(T): the wrapped primitive's name. On a recovered (error) parse of `as natural(`
        // missing its type or closing paren, `typeName()` may be absent; `Backing` is already
        // nullable, so tolerate it rather than throwing (mirrors BuildAggregate, #1298).
        return (IdentityStrategy.Natural, ctx.typeName()?.GetText());
    }

    private StatesDecl BuildStates(KoineParser.StatesDeclContext ctx)
    {
        var rules = Map(ctx.stateRule(), BuildStateRule);
        return new StatesDecl(ctx.softName().GetText(), rules) { Span = SpanOf(ctx), NameSpan = SpanOf(ctx.softName()) };
    }

    private StateRule BuildStateRule(KoineParser.StateRuleContext ctx)
    {
        ITerminalNode[]? ids = ctx.Identifier();
        var from = ids[0].GetText();
        var to = new List<string>(Math.Max(0, ids.Length - 1));
        for (var i = 1; i < ids.Length; i++)
        {
            to.Add(ids[i].GetText());
        }
        Expr? guard = ctx.expression() is { } g ? BuildExpression(g) : null;
        return new StateRule(from, to, guard) { Span = SpanOf(ctx) };
    }

    private CommandDecl BuildCommand(KoineParser.CommandDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? Map(pl.param(), BuildParam)
            : new List<Param>();
        var body = Map(ctx.commandStmt(), BuildCommandStmt);
        TypeRef? returnType = ctx.typeRef() is { } tr ? BuildTypeRef(tr) : null;

        return new CommandDecl(NameOf(ctx.Identifier()), parameters, body, returnType)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
        };
    }

    private Param BuildParam(KoineParser.ParamContext ctx) =>
        new(ctx.softName().GetText(), BuildTypeRef(ctx.typeRef())) { Span = SpanOf(ctx), NameSpan = SpanOf(ctx.softName()) };

    private FactoryDecl BuildFactory(KoineParser.FactoryDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? Map(pl.param(), BuildParam)
            : new List<Param>();
        var body = Map(ctx.factoryStmt(), BuildFactoryStmt);

        return new FactoryDecl(NameOf(ctx.Identifier()), parameters, body)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
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
            return BuildEmitClause(emit);
        }

        KoineParser.InitializationContext? init = ctx.initialization();
        if (init is null)
        {
            // Recovered (error) parse with no matched alternative: yield an empty placeholder
            // initialization rather than throwing. The syntax error is reported elsewhere.
            return new Initialization(string.Empty, new IdentifierExpr(string.Empty)) { Span = SpanOf(ctx) };
        }

        return new Initialization(init.softName()?.GetText() ?? string.Empty, BuildExpression(init.expression()))
        {
            Span = SpanOf(init)
        };
    }

    /// <summary>
    /// Builds an <see cref="EmitClause"/> from <c>emit Event(field: value, ...)</c>, shared by the
    /// factory and command statement bodies. Tolerates a recovered (error) parse where the event
    /// name or an argument's field name is a missing/absent token by yielding an empty name rather
    /// than throwing — the syntax error itself is reported by the parser's error listener.
    /// </summary>
    private EmitClause BuildEmitClause(KoineParser.EmitClauseContext emit)
    {
        List<EmitArg> args;
        if (emit.emitArgList() is { } al)
        {
            KoineParser.EmitArgContext[] argCtxs = al.emitArg();
            args = new List<EmitArg>(argCtxs.Length);
            foreach (KoineParser.EmitArgContext a in argCtxs)
            {
                args.Add(new EmitArg(a.softName()?.GetText() ?? string.Empty, BuildExpression(a.expression())) { Span = SpanOf(a) });
            }
        }
        else
        {
            args = new List<EmitArg>();
        }
        return new EmitClause(NameOf(emit.Identifier()), args) { Span = SpanOf(emit) };
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
            return BuildEmitClause(emit);
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
        // NameOf already tolerates the second Identifier context being absent on a recovered (error)
        // parse of a missing `root <Entity>` clause (#1298). The real syntax error is reported
        // separately by the parser's error listener.
        var rootName = NameOf(ctx.Identifier(1));
        var versioned = ctx.VERSIONED() is not null;
        var (since, deprecated) = ReadAnnotations(ctx.annotation());

        return new AggregateDecl(name, rootName, types, specs, versioned, repository)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier(0)),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private RepositoryDecl BuildRepository(KoineParser.RepositoryDeclContext ctx)
    {
        List<string>? operations = ctx.operationsClause() is { } ops
            ? Map(ops.Identifier(), static i => i.GetText())
            : null;
        var finders = Map(ctx.finderDecl(), BuildFinder);
        return new RepositoryDecl(operations, finders) { Span = SpanOf(ctx) };
    }

    private FinderDecl BuildFinder(KoineParser.FinderDeclContext ctx)
    {
        List<Param> parameters = ctx.paramList() is { } pl
            ? Map(pl.param(), BuildParam)
            : new List<Param>();
        return new FinderDecl(NameOf(ctx.Identifier()), parameters, BuildTypeRef(ctx.typeRef()))
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier())
        };
    }

    private EnumDecl BuildEnum(KoineParser.EnumDeclContext ctx)
    {
        List<Param> signature = ctx.paramList() is { } pl
            ? Map(pl.param(), BuildParam)
            : new List<Param>();

        KoineParser.EnumMemberContext[] memberCtxs = ctx.enumMember();
        var members = new List<EnumMember>(memberCtxs.Length);
        foreach (KoineParser.EnumMemberContext m in memberCtxs)
        {
            members.Add(new EnumMember(
                m.Identifier().GetText(),
                Map(m.expression(), BuildExpression))
            { Span = SpanOf(m), NameSpan = SpanOf(m.Identifier()) });
        }

        var (since, deprecated) = ReadAnnotations(ctx.annotation());
        return new EnumDecl(NameOf(ctx.Identifier()), members, signature)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private EventDecl BuildEvent(KoineParser.EventDeclContext ctx)
    {
        var members = Map(ctx.member(), BuildMember);
        var (since, deprecated) = ReadAnnotations(ctx.annotation());
        return new EventDecl(NameOf(ctx.Identifier()), members)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    private IntegrationEventDecl BuildIntegrationEvent(KoineParser.IntegrationEventDeclContext ctx)
    {
        var members = Map(ctx.member(), BuildMember);
        var (since, deprecated) = ReadAnnotations(ctx.annotation());
        return new IntegrationEventDecl(NameOf(ctx.Identifier()), members)
        {
            Span = SpanOf(ctx),
            NameSpan = SpanOf(ctx.Identifier()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
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
            NameSpan = SpanOf(ctx.softName()),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
            Since = since,
            Deprecated = deprecated
        };
    }

    /// <summary>
    /// Gathers the lossless trivia immediately before a rule's first token (whitespace,
    /// blank lines, and comments on the TRIVIA/HIDDEN/DOC channels — see <c>KoineLexer.g4</c>),
    /// in source order. This is the leading half of the trivia attachment that generalizes the
    /// doc-comment recovery of <see cref="DocFor"/>; the doc-comment contiguity/own-line rules
    /// stay in <see cref="DocFor"/> which projects the same tokens onto <see cref="KoineNode.Doc"/>.
    /// </summary>
    private IReadOnlyList<SyntaxTrivia> LeadingTriviaFor(ParserRuleContext ctx) =>
        TriviaFrom(_tokens?.GetHiddenTokensToLeft(ctx.Start.TokenIndex, -1));

    /// <summary>
    /// Gathers the lossless trivia immediately after a rule's last token, in source order.
    /// The trailing half of the trivia attachment.
    /// </summary>
    private IReadOnlyList<SyntaxTrivia> TrailingTriviaFor(ParserRuleContext ctx)
    {
        if (_tokens is null)
        {
            return [];
        }

        IToken stop = ctx.Stop ?? ctx.Start;

        // Single-owner rule: trivia between two nodes belongs to the FOLLOWING node as its leading
        // trivia, so each run is attached exactly once. A node owns its right-hand trivia as trailing
        // ONLY when nothing real follows it (the next default-channel token is EOF) — i.e. it is the
        // last node and carries the file/block trailer. Without this, the text between siblings A and B
        // lands in both A.TrailingTrivia and B.LeadingTrivia, double-emitting when their prints compose.
        if (!NextRealTokenIsEof(stop.TokenIndex))
        {
            return [];
        }

        return TriviaFrom(_tokens.GetHiddenTokensToRight(stop.TokenIndex, -1));
    }

    /// <summary>True when the nearest following default-channel token is EOF (only trivia remains to the right).</summary>
    private bool NextRealTokenIsEof(int tokenIndex)
    {
        for (var i = tokenIndex + 1; i < _tokens!.Size; i++)
        {
            IToken t = _tokens.Get(i);
            if (t.Channel == TokenConstants.DefaultChannel)
            {
                return t.Type == TokenConstants.EOF;
            }
        }

        return true;
    }

    /// <summary>
    /// Maps a run of hidden/trivia tokens to <see cref="SyntaxTrivia"/> pieces, classifying each by
    /// its lexer token type (whitespace with two-or-more newlines becomes a <see cref="SyntaxTriviaKind.BlankLine"/>).
    /// </summary>
    private IReadOnlyList<SyntaxTrivia> TriviaFrom(IList<IToken>? tokens)
    {
        if (tokens is null || tokens.Count == 0)
        {
            return [];
        }

        var pieces = new List<SyntaxTrivia>(tokens.Count);
        foreach (IToken t in tokens)
        {
            var text = t.Text ?? string.Empty;
            SyntaxTriviaKind kind = t.Type switch
            {
                KoineLexer.WS => TokenGeometry.NewlineCount(text) >= 2
                    ? SyntaxTriviaKind.BlankLine
                    : SyntaxTriviaKind.Whitespace,
                KoineLexer.LINE_COMMENT => SyntaxTriviaKind.LineComment,
                KoineLexer.BLOCK_COMMENT => SyntaxTriviaKind.BlockComment,
                KoineLexer.DocComment => SyntaxTriviaKind.Doc,
                _ => SyntaxTriviaKind.Whitespace
            };
            pieces.Add(new SyntaxTrivia(kind, text, SpanOf(t)));
        }

        return pieces;
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

    private TypeRef BuildTypeRef(KoineParser.TypeRefContext? ctx)
    {
        // On a recovered (error) parse a required type reference can be absent entirely; yield a
        // placeholder empty-named TypeRef rather than throwing. The syntax error is reported elsewhere.
        if (ctx is null)
        {
            return new TypeRef(string.Empty);
        }

        KoineParser.TypeRefContext[]? args = ctx.typeRef();
        TypeRef? element = args.Length > 0 ? BuildTypeRef(args[0]) : null;
        TypeRef? value = args.Length > 1 ? BuildTypeRef(args[1]) : null;
        var isOptional = ctx.QUESTION() is not null;

        // `(typeName DOT)? typeName`: a leading qualifier names the owning context (R13.2).
        // On a recovered (error) parse the type name can be missing entirely; tolerate a
        // zero-length `typeName` array (the syntax error is already reported elsewhere) by
        // falling back to an empty name rather than indexing past the end.
        KoineParser.TypeNameContext[]? names = ctx.typeName();
        var hasQualifier = names.Length == 2;
        var qualifier = hasQualifier ? names[0].GetText() : null;
        var name = names.Length == 0 ? string.Empty : names[hasQualifier ? 1 : 0].GetText();

        return new TypeRef(name, element, value, isOptional, qualifier) { Span = SpanOf(ctx) };
    }

    private Invariant BuildInvariant(KoineParser.InvariantContext ctx)
    {
        Expr condition = BuildExpression(ctx.expression());
        var message = ctx.StringLiteral() is { } str
            ? UnescapeString(StripQuotes(str.GetText()))
            : null;

        return new Invariant(condition, message)
        {
            Span = SpanOf(ctx),
            Doc = DocFor(ctx),
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx)
        };
    }

    // ------------------------------------------------------------------------
    // Expressions
    // ------------------------------------------------------------------------

    private Expr BuildExpression(KoineParser.ExpressionContext? ctx) =>
        // On a recovered (error) parse a required expression can be absent; yield a placeholder
        // empty identifier rather than throwing. The syntax error is reported elsewhere.
        ctx is null ? new IdentifierExpr(string.Empty) : BuildLet(ctx.letExpr());

    private Expr BuildLet(KoineParser.LetExprContext? ctx)
    {
        // A recovered parse of a `let ... in` whose body is missing or unparseable leaves the
        // recursive `letExpr()` (the body) null; guard before dereferencing it so the walk yields
        // a placeholder instead of an NRE (#1512).
        if (ctx is null)
        {
            return new IdentifierExpr(string.Empty);
        }

        // No `let` keyword => the plain `guardExpr` fall-through (every existing expression).
        if (ctx.LET() is null)
        {
            return BuildGuard(ctx.guardExpr());
        }

        KoineParser.LetBindingContext[] bindingCtxs = ctx.letBinding();
        var bindings = new List<LetBinding>(bindingCtxs.Length);
        foreach (KoineParser.LetBindingContext b in bindingCtxs)
        {
            bindings.Add(new LetBinding(b.softName().GetText(), BuildExpression(b.expression()))
            {
                Span = SpanOf(b),
                NameSpan = SpanOf(b.softName())
            });
        }
        Expr body = BuildLet(ctx.letExpr());
        return new LetExpr(bindings, body) { Span = SpanOf(ctx) };
    }

    private Expr BuildGuard(KoineParser.GuardExprContext? ctx)
    {
        // A recovered parse of a `let ... in` whose body is missing leaves not just the body's
        // `letExpr()` null but, one level down, its `guardExpr()` fallback null too (#1512) —
        // guard the same way `BuildLet` does rather than dereferencing a null context.
        if (ctx is null)
        {
            return new IdentifierExpr(string.Empty);
        }

        Expr body = BuildCond(ctx.condExpr(0));

        if (ctx.WHEN() is null)
        {
            return body;
        }

        Expr condition = BuildCond(ctx.condExpr(1));
        return new GuardExpr(body, condition) { Span = SpanOf(ctx) };
    }

    private Expr BuildCond(KoineParser.CondExprContext? ctx)
    {
        // A recovered parse of a truncated `if <c> then` (nothing follows `then`) leaves the
        // then-branch `condExpr` outright null rather than an empty-but-present node (#1512,
        // same shape as `BuildLet`/`BuildGuard`/`BuildCoalesce`); guard before dereferencing.
        if (ctx is null)
        {
            return new IdentifierExpr(string.Empty);
        }

        if (ctx.IF() is null)
        {
            return BuildCoalesce(ctx.coalesceExpr());
        }

        Expr condition = BuildCond(ctx.condExpr(0));
        Expr then = BuildCond(ctx.condExpr(1));
        Expr @else = BuildCond(ctx.condExpr(2));
        return new ConditionalExpr(condition, then, @else) { Span = SpanOf(ctx) };
    }

    private Expr BuildCoalesce(KoineParser.CoalesceExprContext? ctx)
    {
        // A recovered parse of a truncated `if ... then` / `if ... then ... else` leaves the
        // missing branch's `condExpr` non-null but empty — its own `coalesceExpr()` fallback is
        // then null too (#1512, same shape as `BuildLet`/`BuildGuard`); guard before dereferencing.
        if (ctx is null)
        {
            return new IdentifierExpr(string.Empty);
        }

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

        // On a recovered (error) parse the regex literal can be absent (e.g. an unterminated
        // `matches /ab`); fall back to an empty pattern rather than throwing.
        var pattern = ctx.Regex() is { } regex ? StripSlashes(regex.GetText()) : string.Empty;
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

    private Expr BuildPostfix(KoineParser.PostfixExprContext? ctx)
    {
        // On a recovered (error) parse the postfix expression can be absent entirely (e.g. a trailing
        // binary operator like `a +`, where `unaryExpr` matches neither alternative); yield a
        // placeholder empty identifier rather than throwing, matching BuildExpression. The syntax
        // error is reported elsewhere.
        if (ctx is null)
        {
            return new IdentifierExpr(string.Empty);
        }

        Expr result = BuildPrimary(ctx.primary());

        // Walk the trailing `.member` / `.method(args)` chain in source order.
        IList<IParseTree>? children = ctx.children;
        var i = 1; // index 0 is the primary
        while (i < children.Count)
        {
            // children[i] is DOT; the member/method name follows it. On a recovered parse of a
            // truncated chain (e.g. a dangling `.`), ANTLR may leave the DOT as the last child with
            // no name following — stop the walk and return the best-effort partial expression rather
            // than reading past the end (#603). The real syntax error is already reported by the parser.
            if (i + 1 >= children.Count)
            {
                break;
            }

            var name = children[i + 1].GetText();
            i += 2;

            if (i < children.Count
                && children[i] is ITerminalNode lp
                && lp.Symbol.Type == KoineLexer.LPAREN)
            {
                i++; // consume '('
                IReadOnlyList<Expr> args = Array.Empty<Expr>();
                // A recovered parse of an unclosed call (e.g. `a.b(`) leaves `(` as the last child and
                // synthesizes no `)`; guard before reading the optional argument list so the walk
                // yields an argument-less CallExpr instead of an ArgumentOutOfRangeException (#603).
                if (i < children.Count && children[i] is KoineParser.ArgListContext argList)
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
        Map(ctx.argument(), BuildArgument);

    private Expr BuildArgument(KoineParser.ArgumentContext ctx) =>
        ctx.lambda() is { } lambda
            ? BuildLambda(lambda)
            : BuildExpression(ctx.expression());

    private Expr BuildLambda(KoineParser.LambdaContext ctx) =>
        new LambdaExpr(ctx.softName().GetText(), BuildExpression(ctx.expression()))
        {
            Span = SpanOf(ctx)
        };

    private Expr BuildPrimary(KoineParser.PrimaryContext? ctx)
    {
        // Defense in depth for the recovered-parse path: a missing primary also yields the empty
        // placeholder identifier rather than throwing (the syntax error is reported elsewhere).
        if (ctx is null)
        {
            return new IdentifierExpr(string.Empty);
        }

        if (ctx.literal() is { } literal)
        {
            return BuildLiteral(literal);
        }

        if (ctx.exprName() is { } identifier)
        {
            var text = identifier.GetText();
            return new IdentifierExpr(text)
            {
                Span = SpanOf(ctx),
                LeafText = text,
                LeadingTrivia = LeadingTriviaFor(ctx),
                TrailingTrivia = TrailingTriviaFor(ctx)
            };
        }

        // Parenthesized expression.
        return BuildExpression(ctx.expression());
    }

    private Expr BuildLiteral(KoineParser.LiteralContext ctx)
    {
        // The literal rule wraps exactly one terminal, so the rule's text IS the token's text; compute
        // it once and reuse it for both the typed value and the verbatim LeafText below.
        var text = ctx.GetText();

        // Decide the kind + typed value once: Int/Decimal/Bool keep their verbatim spelling; a string
        // literal carries the inner content unescaped, with no surrounding quotes.
        (LiteralKind kind, string value) = ctx switch
        {
            _ when ctx.IntLiteral() is not null => (LiteralKind.Int, text),
            _ when ctx.DecimalLiteral() is not null => (LiteralKind.Decimal, text),
            _ when ctx.BoolLiteral() is not null => (LiteralKind.Bool, text),
            _ => (LiteralKind.String, UnescapeString(StripQuotes(text))),
        };

        // Verbatim source spelling of the literal (incl. quotes/escapes for strings) is kept as the
        // leaf node's LeafText, so it can reconstruct its own text tree-driven via ToFullString();
        // the typed LiteralExpr.Text above keeps the parsed/unescaped value, distinct from leaf text.
        return new LiteralExpr(kind, value)
        {
            Span = SpanOf(ctx),
            LeafText = text,
            LeadingTrivia = LeadingTriviaFor(ctx),
            TrailingTrivia = TrailingTriviaFor(ctx),
        };
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    /// <summary>
    /// The full <see cref="SourceSpan"/> of a parser rule: from <c>ctx.Start</c> through
    /// <c>ctx.Stop</c> (1-based start, 1-based end-EXCLUSIVE, 0-based offset + length),
    /// correctly handling a multi-line stop token (block comment / multi-line string).
    /// </summary>
    private SourceSpan SpanOf(ParserRuleContext ctx) =>
        TokenGeometry.SpanOf(ctx.Start, ctx.Stop ?? ctx.Start, _file);

    /// <summary>The single-token span of a name terminal (used for <see cref="KoineNode.NameSpan"/>).</summary>
    private SourceSpan SpanOf(IToken token) => TokenGeometry.SpanOf(token, _file);

    /// <summary>
    /// The single-token span of a name terminal node (used for <see cref="KoineNode.NameSpan"/>).
    /// Tolerates a <c>null</c> node — on a recovered (error) parse a required name terminal may be
    /// absent — by returning an empty span at the start of the file rather than throwing.
    /// </summary>
    private SourceSpan SpanOf(ITerminalNode? node) =>
        node is null ? new SourceSpan(1, 1, _file) : TokenGeometry.SpanOf(node.Symbol, _file);

    /// <summary>
    /// The text of a name terminal, tolerating a <c>null</c> node from a recovered (error) parse:
    /// a missing required name yields the empty string instead of a <see cref="NullReferenceException"/>.
    /// The syntax error itself is reported separately by the parser's error listener.
    /// </summary>
    private static string NameOf(ITerminalNode? node) => node?.GetText() ?? string.Empty;

    /// <summary>
    /// Picks the n-th binary operator (0-based) among a rule's child terminals,
    /// mapping its source text to the corresponding <see cref="BinaryOp"/>.
    /// </summary>
    private BinaryOp OperatorAt(ParserRuleContext ctx, int index)
    {
        var seen = 0;
        for (var i = 0; i < ctx.ChildCount; i++)
        {
            if (ctx.GetChild(i) is ITerminalNode terminal
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
