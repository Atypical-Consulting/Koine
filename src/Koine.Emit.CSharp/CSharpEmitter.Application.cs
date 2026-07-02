using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The opt-in <b>Application layer</b> slice of <see cref="CSharpEmitter"/> (issue #129): concrete
/// implementations behind the application contracts the core emitter already produces. For each
/// aggregate <b>command</b> and <b>factory</b> it emits a request record, a handler that loads the
/// aggregate via its <c>IUnitOfWork</c> repository property, invokes the behavior and commits via
/// <c>SaveChangesAsync</c>, and a FluentValidation validator derived from invariants; for each query
/// a concrete <c>IQueryHandler</c>; for each service an <c>I&lt;Service&gt;</c> implementation; and an
/// <c>Add&lt;Context&gt;Application</c> DI extension wiring them all.
///
/// <para>Everything here is gated on <see cref="CSharpEmitterOptions.EmitApplication"/>, so the layer
/// is absent (and the rest of the C# output byte-identical) when off. MediatR / FluentValidation /
/// Microsoft.Extensions.DependencyInjection are referenced only from this file — never from
/// <c>Ast/</c>. Use-case → behavior bindings are not expressed by the Koine model, so an
/// <c>I&lt;Service&gt;</c> method delegates to a name-matching behavior handler where one exists and
/// otherwise throws <c>NotImplementedException</c>.</para>
/// </summary>
public sealed partial class CSharpEmitter
{
    private static readonly string[] FluentValidationUsing = { "FluentValidation" };
    private static readonly string[] DependencyInjectionUsing = { "Microsoft.Extensions.DependencyInjection" };

    /// <summary>One registrable application component, accumulated while emitting a context's layer.</summary>
    private readonly record struct AppRegistration(string Kind, string Service, string Implementation);

    /// <summary>
    /// Emits the whole Application layer for one context (issue #129): command/factory handlers +
    /// request records + validators, query handlers, the <c>I&lt;Service&gt;</c> implementations, and
    /// the DI extension. A no-op for a context with nothing to wire.
    /// </summary>
    private void EmitApplicationLayer(
        EmitContext emit,
        List<EmittedFile> files,
        ContextNode ctx,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var ns = ctx.Name;
        var registrations = new List<AppRegistration>();

        // Aggregates whose root is an entity expose a repository (the IUnitOfWork property), so only
        // those can be orchestrated. Declaration order keeps emission deterministic.
        var aggregates = ctx.Types.OfType<AggregateDecl>()
            .Where(a => a.RootEntity() is not null)
            .ToList();

        foreach (AggregateDecl agg in aggregates)
        {
            EntityDecl root = agg.RootEntity()!;
            IReadOnlyList<string> repoOps = agg.Repository?.Operations ?? DefaultRepositoryOps;
            var plural = Pluralize(root.Name);

            // Commands need a load (getById); factories need an add. Skip a behavior whose required
            // repository operation is not exposed — it cannot be wired.
            if (repoOps.Contains("getById"))
            {
                foreach (CommandDecl cmd in root.Commands)
                {
                    EmitCommandHandler(emit, files, registrations, ns, root, plural, cmd, index, typeMapper, enumMemberToType);
                }
            }

            if (repoOps.Contains("add"))
            {
                foreach (FactoryDecl factory in root.Factories)
                {
                    EmitFactoryHandler(emit, files, registrations, ns, root, plural, factory, index, typeMapper, enumMemberToType);
                }
            }
        }

        // Query handlers (one per query object), projecting via the emitted read-model mapper.
        foreach (QueryDecl query in ctx.Types.OfType<QueryDecl>())
        {
            EmitQueryHandler(emit, files, registrations, ns, query, aggregates, ctx);
        }

        // I<Service> implementations (one per service with use cases).
        foreach (ServiceDecl svc in ctx.Services.Where(s => s.UseCases.Count > 0))
        {
            EmitApplicationServiceImpl(emit, files, registrations, ns, svc, typeMapper);
        }

        // MediatR pipeline behaviors (validation + transaction), emitted once per context when the
        // MediatR sub-mode is on and there is at least one request handler to wrap.
        var hasRequestHandlers = registrations.Any(r => r.Kind is "handler");
        if (_options.ApplicationMediatr && hasRequestHandlers)
        {
            files.Add(EmitValidationBehavior(emit, ns));
            files.Add(EmitTransactionBehavior(emit, ns, aggregates.Count > 0));
        }

        if (registrations.Count > 0)
        {
            files.Add(EmitDiExtension(emit, ns, registrations));
        }
    }

    // ----------------------------------------------------------------------
    // Command / factory handlers + request records
    // ----------------------------------------------------------------------

    private void EmitCommandHandler(
        EmitContext emit,
        List<EmittedFile> files,
        List<AppRegistration> registrations,
        string ns,
        EntityDecl root,
        string plural,
        CommandDecl cmd,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var behavior = root.Name + CSharpNaming.ToPascalCase(cmd.Name);
        var requestType = behavior + "Request";
        var handlerType = behavior + "Handler";
        var method = CSharpNaming.ToPascalCase(cmd.Name);
        // The C# type the command returns in plain mode (null = void/Task). In MediatR mode a void
        // command becomes a Unit-returning request so it always uses the two-arg IRequestHandler<,>.
        var plainResult = cmd.ReturnType is { } rt ? typeMapper.Map(rt) : null;

        // Request: the aggregate identity to load, then the command's parameters. The identity
        // property is normally "Id", but a command parameter named `id` (allowed for commands, only
        // factories reserve it) would PascalCase to a colliding "Id" — so pick a non-colliding name.
        var paramProps = cmd.Parameters.Select(p => CSharpNaming.ToPascalCase(p.Name)).ToHashSet(StringComparer.Ordinal);
        var idProp = "Id";
        while (paramProps.Contains(idProp))
        {
            idProp = "Aggregate" + idProp;
        }

        var fields = new List<(string Type, string Prop)> { (root.IdentityName, idProp) };
        fields.AddRange(cmd.Parameters.Select(p => (typeMapper.Map(p.Type), CSharpNaming.ToPascalCase(p.Name))));
        var args = string.Join(", ", cmd.Parameters.Select(p => "request." + CSharpNaming.ToPascalCase(p.Name)));

        files.Add(EmitRequestRecord(emit, ns, requestType, fields, plainResult));

        var sb = new StringBuilder();
        WriteHandlerHeader(sb, handlerType, requestType, plainResult,
            cmd.Doc ?? $"Handles {requestType} by invoking {root.Name}.{method} and committing the unit of work.");

        sb.Append(Indent).Append(HandlerSignature(requestType, plainResult)).Append('\n');
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("var aggregate = await _unitOfWork.").Append(plural)
          .Append(".GetByIdAsync(request.").Append(idProp).Append(", ").Append(CtArg()).Append(")\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("?? throw new InvalidOperationException($\"").Append(root.Name).Append(" '{request.").Append(idProp).Append("}' was not found.\");\n");

        if (plainResult is null)
        {
            sb.Append(Indent).Append(Indent).Append("aggregate.").Append(method).Append('(').Append(args).Append(");\n");
            WriteCommit(sb);
            WriteVoidReturn(sb);
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append("var result = aggregate.").Append(method).Append('(').Append(args).Append(");\n");
            WriteCommit(sb);
            sb.Append(Indent).Append(Indent).Append("return result;\n");
        }

        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        files.Add(new EmittedFile(PathFor(emit, ns, KindFolder.Application, $"{handlerType}.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false)));

        registrations.Add(new AppRegistration("handler", MediatrHandlerService(requestType, plainResult), handlerType));
        EmitValidator(emit, files, registrations, ns, requestType, cmd.Parameters, cmd.Body, index, enumMemberToType);
    }

    private void EmitFactoryHandler(
        EmitContext emit,
        List<EmittedFile> files,
        List<AppRegistration> registrations,
        string ns,
        EntityDecl root,
        string plural,
        FactoryDecl factory,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var behavior = root.Name + CSharpNaming.ToPascalCase(factory.Name);
        var requestType = behavior + "Request";
        var handlerType = behavior + "Handler";
        var method = CSharpNaming.ToPascalCase(factory.Name);

        var fields = factory.Parameters.Select(p => (typeMapper.Map(p.Type), CSharpNaming.ToPascalCase(p.Name))).ToList();
        var args = string.Join(", ", factory.Parameters.Select(p => "request." + CSharpNaming.ToPascalCase(p.Name)));

        files.Add(EmitRequestRecord(emit, ns, requestType, fields, root.Name));

        var sb = new StringBuilder();
        WriteHandlerHeader(sb, handlerType, requestType, root.Name,
            factory.Doc ?? $"Handles {requestType} by creating a {root.Name} via {root.Name}.{method} and committing the unit of work.");

        sb.Append(Indent).Append(HandlerSignature(requestType, root.Name)).Append('\n');
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("var aggregate = ").Append(root.Name).Append('.').Append(method)
          .Append('(').Append(args).Append(");\n");
        sb.Append(Indent).Append(Indent).Append("await _unitOfWork.").Append(plural)
          .Append(".AddAsync(aggregate, ").Append(CtArg()).Append(");\n");
        WriteCommit(sb);
        sb.Append(Indent).Append(Indent).Append("return aggregate;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        files.Add(new EmittedFile(PathFor(emit, ns, KindFolder.Application, $"{handlerType}.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false)));

        registrations.Add(new AppRegistration("handler", MediatrHandlerService(requestType, root.Name), handlerType));
        EmitValidator(emit, files, registrations, ns, requestType, factory.Parameters, factory.Body, index, enumMemberToType);
    }

    /// <summary>
    /// Emits a request <c>record</c> file. In MediatR mode it is a <c>MediatR.IRequest&lt;TResponse&gt;</c>
    /// (a void behavior uses <c>MediatR.Unit</c> so every handler is the two-arg shape, version-robust).
    /// </summary>
    private EmittedFile EmitRequestRecord(EmitContext emit, string ns, string requestType, IReadOnlyList<(string Type, string Prop)> fields, string? plainResult)
    {
        var paramList = string.Join(", ", fields.Select(f => $"{f.Type} {f.Prop}"));
        var name = requestType.EndsWith("Request", StringComparison.Ordinal) ? requestType[..^"Request".Length] : requestType;
        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"Application request for {name}.", "");
        sb.Append("public sealed record ").Append(requestType).Append('(').Append(paramList).Append(')');
        if (_options.ApplicationMediatr)
        {
            sb.Append(" : MediatR.IRequest<").Append(MediatrResponse(plainResult)).Append('>');
        }

        sb.Append(";\n");
        return new EmittedFile(PathFor(emit, ns, KindFolder.Application, $"{requestType}.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>Writes the handler class declaration line + the injected unit of work + constructor.</summary>
    private void WriteHandlerHeader(StringBuilder sb, string handlerType, string requestType, string? plainResult, string doc)
    {
        WriteXmlDoc(sb, doc, "");
        sb.Append("public sealed class ").Append(handlerType);
        if (_options.ApplicationMediatr)
        {
            sb.Append(" : MediatR.IRequestHandler<").Append(requestType).Append(", ").Append(MediatrResponse(plainResult)).Append('>');
        }

        sb.Append("\n{\n");
        sb.Append(Indent).Append("private readonly IUnitOfWork _unitOfWork;\n\n");
        sb.Append(Indent).Append("public ").Append(handlerType).Append("(IUnitOfWork unitOfWork)\n");
        sb.Append(Indent).Append(Indent).Append("=> _unitOfWork = unitOfWork;\n\n");
    }

    /// <summary>The handler method signature: plain <c>HandleAsync</c> or MediatR <c>Handle</c>.</summary>
    private string HandlerSignature(string requestType, string? plainResult)
    {
        var name = _options.ApplicationMediatr ? "Handle" : "HandleAsync";
        var ret = _options.ApplicationMediatr
            ? $"Task<{MediatrResponse(plainResult)}>"
            : plainResult is null ? "Task" : $"Task<{plainResult}>";
        var ctParam = _options.ApplicationMediatr ? "CancellationToken cancellationToken" : "CancellationToken ct = default";
        return $"public async {ret} {name}({requestType} request, {ctParam})";
    }

    /// <summary>Plain handlers commit the unit of work; MediatR handlers defer the commit to the transaction behavior.</summary>
    private void WriteCommit(StringBuilder sb)
    {
        if (!_options.ApplicationMediatr)
        {
            sb.Append(Indent).Append(Indent).Append("await _unitOfWork.SaveChangesAsync(ct);\n");
        }
    }

    /// <summary>A void behavior returns nothing in plain mode and <c>MediatR.Unit.Value</c> in MediatR mode.</summary>
    private void WriteVoidReturn(StringBuilder sb)
    {
        if (_options.ApplicationMediatr)
        {
            sb.Append(Indent).Append(Indent).Append("return MediatR.Unit.Value;\n");
        }
    }

    private string CtArg() => _options.ApplicationMediatr ? "cancellationToken" : "ct";

    /// <summary>The MediatR response type for a behavior: its plain result, or <c>MediatR.Unit</c> for a void one.</summary>
    private static string MediatrResponse(string? plainResult) => plainResult ?? "MediatR.Unit";

    private string MediatrHandlerService(string requestType, string? plainResult) =>
        // Plain handlers register as the concrete type (Service slot unused); MediatR handlers register
        // against their two-arg IRequestHandler<TRequest, TResponse> interface.
        _options.ApplicationMediatr ? $"MediatR.IRequestHandler<{requestType}, {MediatrResponse(plainResult)}>" : string.Empty;


    // ----------------------------------------------------------------------
    // FluentValidation validators derived from invariants (issue #129)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a FluentValidation <c>AbstractValidator&lt;TRequest&gt;</c> whose rules are derived, via
    /// <see cref="CSharpExpressionTranslator"/>, from (a) the invariants of each value-object parameter
    /// and (b) the behavior's <c>requires</c> preconditions that reference only its parameters. Rules
    /// the translator cannot render statically are skipped; the aggregate's own guards remain the
    /// backstop. A validator with no derivable rules is still emitted (and registered) for uniformity.
    /// </summary>
    private void EmitValidator(
        EmitContext emit,
        List<EmittedFile> files,
        List<AppRegistration> registrations,
        string ns,
        string requestType,
        IReadOnlyList<Param> parameters,
        IReadOnlyList<CommandStmt> body,
        ModelIndex index,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var validatorType = requestType + "Validator";
        // The application layer emits into the base context namespace, so it is the bounded context.
        var context = ns;
        var rules = new StringBuilder();

        // (a) Re-encode each value-object parameter's invariants as RuleFor(x => x.Param).Must(p => ...).
        foreach (Param p in parameters)
        {
            if (p.Type.IsOptional || !TryGetValueObject(context, p.Type.Name, index, out ValueObjectDecl vo) || vo.Invariants.Count == 0)
            {
                continue;
            }

            var translator = new CSharpExpressionTranslator(index, vo.Members, enumMemberToType, memberReceiver: "p", context: context, options: _options);
            foreach (Invariant inv in vo.Invariants)
            {
                if (TryTranslate(translator, inv.Condition, out var predicate))
                {
                    var message = inv.Message ?? SynthesizeMessage(inv.Condition);
                    rules.Append(Indent).Append(Indent).Append("RuleFor(x => x.").Append(CSharpNaming.ToPascalCase(p.Name))
                         .Append(").Must(p => ").Append(predicate).Append(").WithMessage(\"")
                         .Append(EscapeCSharpString(message)).Append("\");\n");
                }
            }
        }

        // (b) Parameter-only `requires` preconditions become a whole-request rule.
        var paramNames = new HashSet<string>(parameters.Select(p => p.Name), StringComparer.Ordinal);
        var paramMembers = parameters.Select(p => new Member(p.Name, p.Type, null)).ToList();
        var reqTranslator = new CSharpExpressionTranslator(index, paramMembers, enumMemberToType, memberReceiver: "x", context: context, options: _options);
        foreach (RequiresClause req in body.OfType<RequiresClause>())
        {
            if (!ReferencesOnly(req.Condition, paramNames) || !TryTranslate(reqTranslator, req.Condition, out var predicate))
            {
                continue;
            }

            var message = req.Message ?? SynthesizeMessage(req.Condition);
            rules.Append(Indent).Append(Indent).Append("RuleFor(x => x).Must(x => ").Append(predicate)
                 .Append(").WithMessage(\"").Append(EscapeCSharpString(message)).Append("\");\n");
        }

        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"Validates {requestType}, with rules derived from the model's invariants.", "");
        sb.Append("public sealed class ").Append(validatorType).Append(" : FluentValidation.AbstractValidator<")
          .Append(requestType).Append(">\n{\n");
        sb.Append(Indent).Append("public ").Append(validatorType).Append("()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(rules);
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        files.Add(new EmittedFile(PathFor(emit, ns, KindFolder.Application, $"{validatorType}.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false, FluentValidationUsing)));

        registrations.Add(new AppRegistration("validator", $"FluentValidation.IValidator<{requestType}>", validatorType));
    }

    /// <summary>Attempts a translation, returning false (and skipping the rule) if the translator throws.</summary>
    private static bool TryTranslate(CSharpExpressionTranslator translator, Expr condition, out string rendered)
    {
        try
        {
            rendered = translator.TranslateTopLevel(condition, CSharpExpressionTranslator.NameMode.Property);
            return true;
        }
        catch
        {
            rendered = string.Empty;
            return false;
        }
    }

    private static bool TryGetValueObject(string context, string typeName, ModelIndex index, out ValueObjectDecl vo)
    {
        if ((index.TryGetDeclIn(context, typeName, out TypeDecl decl) || index.TryGetDecl(typeName, out decl))
            && decl is ValueObjectDecl found)
        {
            vo = found;
            return true;
        }

        vo = null!;
        return false;
    }

    /// <summary>
    /// True when every free identifier in <paramref name="expr"/> is one of <paramref name="allowed"/>
    /// (and there is at least one). Reuses the shared target-agnostic free-identifier walker so the
    /// scoping rules (lambda/let bindings) and node coverage stay in step with the grammar.
    /// </summary>
    private static bool ReferencesOnly(Expr expr, ISet<string> allowed)
    {
        var free = MemberAnalysis.ReferencedIdentifiers(expr).ToHashSet(StringComparer.Ordinal);
        return free.Count > 0 && free.All(allowed.Contains);
    }

    // ----------------------------------------------------------------------
    // Query handlers
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a concrete <c>IQueryHandler&lt;TQuery,TResult&gt;</c>. A single-result query keyed by the
    /// source aggregate root's identity loads via the repository and projects with the emitted
    /// <c>To&lt;ReadModel&gt;</c> mapper; any other shape (list results, non-identity criteria) is a
    /// store-specific query the model does not express, so the handler throws with a clear message.
    /// </summary>
    private void EmitQueryHandler(
        EmitContext emit,
        List<EmittedFile> files,
        List<AppRegistration> registrations,
        string ns,
        QueryDecl query,
        IReadOnlyList<AggregateDecl> aggregates,
        ContextNode ctx)
    {
        var isList = query.ResultType.Name == ModelIndex.ListTypeName;
        var resultName = isList ? query.ResultType.Element!.Name : query.ResultType.Name;
        var resultType = isList ? $"IReadOnlyList<{resultName}>" : resultName;
        var handlerType = query.Name + "Handler";
        var service = $"Koine.Runtime.IQueryHandler<{query.Name}, {resultType}>";

        // Resolve the by-identity load: a single result over a read model whose source is an aggregate
        // root, with exactly one criterion typed as that root's identity.
        ReadModelDecl? readModel = ctx.Types.OfType<ReadModelDecl>().FirstOrDefault(r => r.Name == resultName);
        (string Plural, string Criterion, string Root)? byId = null;
        if (!isList && readModel is not null)
        {
            AggregateDecl? agg = aggregates.FirstOrDefault(a => a.RootEntity()!.Name == readModel.SourceType);
            EntityDecl? root = agg?.RootEntity();
            if (root is not null)
            {
                Param? idCriterion = query.Criteria.FirstOrDefault(c => c.Type.Name == root.IdentityName);
                if (idCriterion is not null)
                {
                    byId = (Pluralize(root.Name), CSharpNaming.ToPascalCase(idCriterion.Name), root.Name);
                }
            }
        }

        var sb = new StringBuilder();
        WriteXmlDoc(sb, query.Doc ?? $"Handles the {query.Name} query.", "");
        sb.Append("public sealed class ").Append(handlerType).Append(" : ").Append(service).Append("\n{\n");

        if (byId is { } b)
        {
            sb.Append(Indent).Append("private readonly IUnitOfWork _unitOfWork;\n\n");
            sb.Append(Indent).Append("public ").Append(handlerType).Append("(IUnitOfWork unitOfWork)\n");
            sb.Append(Indent).Append(Indent).Append("=> _unitOfWork = unitOfWork;\n\n");
            sb.Append(Indent).Append("public async Task<").Append(resultType).Append("> HandleAsync(")
              .Append(query.Name).Append(" query, CancellationToken ct = default)\n");
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("var aggregate = await _unitOfWork.").Append(b.Plural)
              .Append(".GetByIdAsync(query.").Append(b.Criterion).Append(", ct)\n");
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("?? throw new InvalidOperationException($\"").Append(b.Root).Append(" '{query.").Append(b.Criterion).Append("}' was not found.\");\n");
            sb.Append(Indent).Append(Indent).Append("return aggregate.To").Append(resultName).Append("();\n");
            sb.Append(Indent).Append("}\n");
        }
        else
        {
            sb.Append(Indent).Append("public Task<").Append(resultType).Append("> HandleAsync(")
              .Append(query.Name).Append(" query, CancellationToken ct = default)\n");
            sb.Append(Indent).Append(Indent)
              .Append("=> throw new System.NotImplementedException(\"")
              .Append(query.Name)
              .Append(" requires a read-store query the Koine model does not express; implement it against your projection store.\");\n");
        }

        sb.Append("}\n");
        files.Add(new EmittedFile(PathFor(emit, ns, KindFolder.Application, $"{handlerType}.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false)));

        registrations.Add(new AppRegistration("query", service, handlerType));
    }

    // ----------------------------------------------------------------------
    // I<Service> implementation (delegate to a name-matching handler, else throw)
    // ----------------------------------------------------------------------

    private void EmitApplicationServiceImpl(
        EmitContext emit,
        List<EmittedFile> files,
        List<AppRegistration> registrations,
        string ns,
        ServiceDecl svc,
        CSharpTypeMapper typeMapper)
    {
        var iface = "I" + svc.Name;
        var implType = svc.Name + "Application";

        var sb = new StringBuilder();
        WriteXmlDoc(sb,
            $"Application-service implementation of {iface}. Koine does not bind use cases to aggregate " +
            "behaviors, so each method throws until wired; the generated command/factory handlers are the " +
            "real entry points.", "");
        sb.Append("public sealed class ").Append(implType).Append(" : ").Append(iface).Append("\n{\n");

        var first = true;
        foreach (UseCaseDecl uc in svc.UseCases)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            var ret = uc.ReturnType is null ? "Task" : $"Task<{typeMapper.Map(uc.ReturnType)}>";
            IEnumerable<string> args = uc.Parameters
                .Select(p => $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}")
                .Append("CancellationToken ct = default");
            sb.Append(Indent).Append("public ").Append(ret).Append(' ').Append(CSharpNaming.ToPascalCase(uc.Name))
              .Append('(').Append(string.Join(", ", args)).Append(")\n");
            sb.Append(Indent).Append(Indent)
              .Append("=> throw new System.NotImplementedException(\"")
              .Append(svc.Name).Append('.').Append(CSharpNaming.ToPascalCase(uc.Name))
              .Append(" is not bound to an aggregate behavior; call the generated handler or implement this method.\");\n");
        }

        sb.Append("}\n");
        files.Add(new EmittedFile(PathFor(emit, ns, KindFolder.Application, $"{implType}.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false)));

        registrations.Add(new AppRegistration("service", iface, implType));
    }

    // ----------------------------------------------------------------------
    // MediatR pipeline behaviors (opt-in)
    // ----------------------------------------------------------------------

    private EmittedFile EmitValidationBehavior(EmitContext emit, string ns)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>MediatR pipeline behavior: runs every registered validator before the handler.</summary>\n");
        sb.Append("public sealed class ValidationBehavior<TRequest, TResponse> : MediatR.IPipelineBehavior<TRequest, TResponse>\n");
        sb.Append(Indent).Append("where TRequest : notnull\n{\n");
        sb.Append(Indent).Append("private readonly IEnumerable<FluentValidation.IValidator<TRequest>> _validators;\n\n");
        sb.Append(Indent).Append("public ValidationBehavior(IEnumerable<FluentValidation.IValidator<TRequest>> validators)\n");
        sb.Append(Indent).Append(Indent).Append("=> _validators = validators;\n\n");
        sb.Append(Indent).Append("public async Task<TResponse> Handle(TRequest request, MediatR.RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("foreach (var validator in _validators)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var result = await validator.ValidateAsync(request, cancellationToken);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (!result.IsValid)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("throw new FluentValidation.ValidationException(result.Errors);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("return await next();\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");
        return new EmittedFile(PathFor(emit, ns, KindFolder.Application, "ValidationBehavior.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    private EmittedFile EmitTransactionBehavior(EmitContext emit, string ns, bool hasUnitOfWork)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>MediatR pipeline behavior: commits the unit of work after a successful handler.</summary>\n");
        sb.Append("public sealed class TransactionBehavior<TRequest, TResponse> : MediatR.IPipelineBehavior<TRequest, TResponse>\n");
        sb.Append(Indent).Append("where TRequest : notnull\n{\n");
        if (hasUnitOfWork)
        {
            sb.Append(Indent).Append("private readonly IUnitOfWork _unitOfWork;\n\n");
            sb.Append(Indent).Append("public TransactionBehavior(IUnitOfWork unitOfWork)\n");
            sb.Append(Indent).Append(Indent).Append("=> _unitOfWork = unitOfWork;\n\n");
            sb.Append(Indent).Append("public async Task<TResponse> Handle(TRequest request, MediatR.RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)\n");
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("var response = await next();\n");
            sb.Append(Indent).Append(Indent).Append("await _unitOfWork.SaveChangesAsync(cancellationToken);\n");
            sb.Append(Indent).Append(Indent).Append("return response;\n");
            sb.Append(Indent).Append("}\n");
        }
        else
        {
            sb.Append(Indent).Append("public Task<TResponse> Handle(TRequest request, MediatR.RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)\n");
            sb.Append(Indent).Append(Indent).Append("=> next();\n");
        }

        sb.Append("}\n");
        return new EmittedFile(PathFor(emit, ns, KindFolder.Application, "TransactionBehavior.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    // ----------------------------------------------------------------------
    // DI registration
    // ----------------------------------------------------------------------

    private EmittedFile EmitDiExtension(EmitContext emit, string ns, IReadOnlyList<AppRegistration> registrations)
    {
        var method = "Add" + ns + "Application";
        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"Registers the {ns} application handlers, validators and query handlers.", "");
        sb.Append("public static class ").Append(ns).Append("ApplicationServiceCollectionExtensions\n{\n");
        sb.Append(Indent).Append("public static Microsoft.Extensions.DependencyInjection.IServiceCollection ")
          .Append(method).Append("(this Microsoft.Extensions.DependencyInjection.IServiceCollection services)\n");
        sb.Append(Indent).Append("{\n");

        foreach (AppRegistration r in registrations)
        {
            switch (r.Kind)
            {
                case "handler" when _options.ApplicationMediatr:
                    sb.Append(Indent).Append(Indent).Append("services.AddTransient<").Append(r.Service).Append(", ").Append(r.Implementation).Append(">();\n");
                    break;
                case "handler":
                    sb.Append(Indent).Append(Indent).Append("services.AddTransient<").Append(r.Implementation).Append(">();\n");
                    break;
                default:
                    sb.Append(Indent).Append(Indent).Append("services.AddTransient<").Append(r.Service).Append(", ").Append(r.Implementation).Append(">();\n");
                    break;
            }
        }

        if (_options.ApplicationMediatr)
        {
            sb.Append(Indent).Append(Indent).Append("services.AddTransient(typeof(MediatR.IPipelineBehavior<,>), typeof(ValidationBehavior<,>));\n");
            sb.Append(Indent).Append(Indent).Append("services.AddTransient(typeof(MediatR.IPipelineBehavior<,>), typeof(TransactionBehavior<,>));\n");
        }

        sb.Append(Indent).Append(Indent).Append("return services;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");
        return new EmittedFile(PathFor(emit, ns, KindFolder.Application, $"{ns}ApplicationServiceCollectionExtensions.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false, DependencyInjectionUsing));
    }
}
