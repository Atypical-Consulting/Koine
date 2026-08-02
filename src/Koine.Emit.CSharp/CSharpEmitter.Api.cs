using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The opt-in ASP.NET Minimal-API <b>endpoint layer</b> (W2): for each aggregate command/factory a
/// <c>MapPost</c> and for each query a <c>MapGet</c>, each binding the request to the Application-layer
/// handler that layer emits and shaping the HTTP result from the handler's return (W1's
/// <c>--app-handler-result</c> / <c>--app-not-found</c> options: void → 200, a value → 200 with body,
/// a nullable value → 404 when null). A presentation layer above <c>application</c> — the <c>api</c>
/// layer implies it, so the handlers/request records it references always exist.
///
/// <para>Everything here is gated on <see cref="CSharpEmitterOptions.EmitsApi"/>, so the layer is
/// absent (and the rest of the C# output byte-identical) when off. ASP.NET Minimal APIs are referenced
/// by <c>using</c> / fully-qualified name; the consumer supplies
/// <c>&lt;FrameworkReference Include="Microsoft.AspNetCore.App" /&gt;</c>. Convention-first (OpenApi-style
/// routes), with R19's <c>@route</c>/<c>@get</c>…<c>@patch</c>/<c>@auth</c> annotations as the per-operation
/// escape hatch — an annotated command/query maps through its own verb, path and
/// <c>.RequireAuthorization(...)</c> (#1219). Other app-specific policy (non-default status codes,
/// filters) still stays hand-written.</para>
/// </summary>
public sealed partial class CSharpEmitter
{
    private static readonly string[] AspNetCoreUsings =
    {
        "Microsoft.AspNetCore.Builder",
        "Microsoft.AspNetCore.Http",
        "Microsoft.AspNetCore.Routing",
    };

    /// <summary>
    /// The HTTP verbs ASP.NET refuses to <b>infer</b> a request body for. Mapping a complex parameter
    /// through one of these without an explicit binding source throws at endpoint-build time — see
    /// <see cref="BodyBindingAttributeFor"/>.
    /// </summary>
    private static readonly HashSet<string> BodylessVerbs =
        new(StringComparer.OrdinalIgnoreCase) { "GET", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT" };

    /// <summary>
    /// Emits one context's <c>&lt;Context&gt;Endpoints</c> extension (W2), or nothing when the context has
    /// no commands, factories or queries to map.
    /// </summary>
    private void EmitApiLayer(EmitContext emit, List<EmittedFile> files, ContextNode ctx, CSharpTypeMapper typeMapper, ModelIndex index)
    {
        var ns = ctx.Name;
        var body = new StringBuilder();
        var any = false;

        foreach (AggregateDecl agg in ctx.Types.OfType<AggregateDecl>().Where(a => a.RootEntity() is not null))
        {
            EntityDecl root = agg.RootEntity()!;
            IReadOnlyList<string> repoOps = agg.Repository?.Operations ?? DefaultRepositoryOps;

            // Commands need a load (getById) and factories an add — mirror the Application layer so the
            // endpoint only binds behaviors whose handler was actually emitted.
            if (repoOps.Contains("getById"))
            {
                foreach (CommandDecl cmd in root.Commands)
                {
                    WriteCommandEndpoint(body, root, cmd, typeMapper, index);
                    any = true;
                }
            }

            if (repoOps.Contains("add"))
            {
                foreach (FactoryDecl factory in root.Factories)
                {
                    WriteFactoryEndpoint(body, root, factory, typeMapper, index);
                    any = true;
                }
            }
        }

        foreach (QueryDecl query in ctx.Types.OfType<QueryDecl>())
        {
            WriteQueryEndpoint(body, ctx, query, typeMapper, index);
            any = true;
        }

        if (!any)
        {
            return;
        }

        var sb = new StringBuilder();
        WriteXmlDoc(sb,
            $"Maps the {ns} commands and queries onto ASP.NET Minimal-API endpoints, binding each to its " +
            $"generated Application-layer handler. Register after Add{ns}Application() (and a JSON setup that " +
            "can (de)serialize the request/response types).", "");
        sb.Append("public static class ").Append(ns).Append("Endpoints\n{\n");
        sb.Append(Indent).Append("public static IEndpointRouteBuilder Map").Append(ns)
          .Append("Endpoints(this IEndpointRouteBuilder endpoints)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(body);
        sb.Append(Indent).Append(Indent).Append("return endpoints;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        files.Add(new EmittedFile(PathFor(emit, ns, KindFolder.Endpoints, $"{ns}Endpoints.cs"),
            Assemble(emit, ns, sb.ToString(), usesLinq: false, AspNetCoreUsings)));
    }

    /// <summary>A command → <c>POST /{entity}/{command}</c> bound to <c>&lt;Behavior&gt;Handler</c> — or the
    /// verb/route/role its R19 <c>@route</c>/<c>@put</c>/<c>@auth</c> annotations named (#1219). A
    /// <c>@route</c> <c>{token}</c> that resolves to a parameter or the aggregate identity (#1748) binds
    /// into the endpoint via <see cref="RouteInfo.TokenBindings"/>.</summary>
    private void WriteCommandEndpoint(StringBuilder body, EntityDecl root, CommandDecl cmd, CSharpTypeMapper typeMapper, ModelIndex index)
    {
        var behavior = root.Name + CSharpNaming.ToPascalCase(cmd.Name);
        RouteInfo info = RouteDerivation.ForCommand(root, cmd);

        // Mirror the Application layer's handler result shape (W1): the handler returns a value when the
        // command declares a return type, or --app-handler-result aggregate/readModel, or --app-not-found
        // nullable/result. A command always loads by id, so it honors the not-found policy — nullable
        // maps null → 404, result maps Result<T> → 200/404.
        var returnsValue = cmd.ReturnType is not null
            || _options.HandlerResult is CSharpHandlerResult.Aggregate or CSharpHandlerResult.ReadModel
            || _options.NotFound is CSharpNotFound.Nullable or CSharpNotFound.Result;
        WriteMutationEndpoint(body, info.Verb, "MapPost", info.Route, behavior, returnsValue,
            _options.NotFound, info.AuthRole, info.TokenBindings, CSharpNaming.CommandIdProperty(cmd), typeMapper, index);
    }

    /// <summary>A factory → <c>POST /{entity}/{factory}</c> (<see cref="RouteDerivation.ForFactory"/> —
    /// #1747), always returning the created aggregate — or the verb/route/role its R19
    /// <c>@route</c>/<c>@put</c>/<c>@auth</c> annotations named (#1846), through the very same
    /// <see cref="RouteInfo"/> a command's endpoint reads.
    ///
    /// <para><c>identityProperty</c> is passed empty because it is unreachable here:
    /// <see cref="RouteDerivation.ForFactory"/> never resolves an <see cref="RouteTokenTarget.Identity"/>
    /// binding — a factory mints its identity, so its request record (built from the factory's parameters
    /// alone) has no identity property to rebind. A factory's <c>{id}</c> token binds only by ordinary
    /// name-match against an explicit <c>id</c> parameter, and is otherwise KOI1215-unbound.</para></summary>
    private void WriteFactoryEndpoint(StringBuilder body, EntityDecl root, FactoryDecl factory, CSharpTypeMapper typeMapper, ModelIndex index)
    {
        var behavior = root.Name + CSharpNaming.ToPascalCase(factory.Name);
        RouteInfo info = RouteDerivation.ForFactory(root, factory);
        // A factory creates — it has no not-found concept — so it always returns the created aggregate
        // plainly, regardless of the not-found policy.
        WriteMutationEndpoint(body, info.Verb, "MapPost", info.Route, behavior, returnsValue: true, CSharpNotFound.Throw,
            info.AuthRole, info.TokenBindings, identityProperty: "", typeMapper, index);
    }

    /// <summary>
    /// Writes a mutating endpoint — <paramref name="verb"/> picks the ASP.NET per-verb mapping call
    /// (falling back to <paramref name="conventionalMapMethod"/>) — that binds <c>&lt;Behavior&gt;Request</c>
    /// from the body and invokes the handler. In plain mode it injects the concrete handler and calls
    /// <c>HandleAsync</c>; in MediatR mode it injects <c>IMediator</c> and calls <c>Send</c>.
    /// <paramref name="miss"/> shapes the HTTP result from the handler's return:
    /// <c>Throw</c> ⇒ plain 200; <c>Nullable</c> ⇒ null → 404; <c>Result</c> ⇒ a <c>Result&lt;T&gt;</c> →
    /// 200 with the value / 404. <paramref name="authRole"/>, when set, appends
    /// <c>.RequireAuthorization("role")</c> to the chain (#1219).
    ///
    /// <para>Each bound <paramref name="bindings"/> entry (#1748) lifts one route-bindable
    /// (scalar/enum/identity) token into its own fully-qualified <c>[FromRoute(Name = "…")]</c> parameter
    /// ahead of the request, and the request is re-bound <c>with { … }</c> from it — so the route and the
    /// body can never silently disagree. A member-matched token whose type is not route-bindable (a
    /// general value object) stays unbound with an explanatory comment; an <c>Unbound</c> binding is
    /// KOI1215's concern, not this method's. Zero bindings ⇒ output byte-identical to pre-#1748.</para>
    /// </summary>
    private void WriteMutationEndpoint(StringBuilder body, string verb, string conventionalMapMethod, string route,
        string behavior, bool returnsValue, CSharpNotFound miss, string? authRole,
        IReadOnlyList<RouteTokenBinding> bindings, string identityProperty, CSharpTypeMapper typeMapper, ModelIndex index)
    {
        var requestType = behavior + "Request";
        var i2 = Indent + Indent;
        var i3 = i2 + Indent;

        (string routeParams, List<string> rebinds) = BuildRouteTokenBindings(body, i2, bindings, identityProperty, typeMapper, index);

        body.Append(i2).Append("endpoints.").Append(MapMethodFor(verb, conventionalMapMethod)).Append("(\"")
            .Append(EscapeCSharpString(route))
            .Append("\", async (").Append(routeParams).Append(BodyBindingAttributeFor(verb)).Append(requestType).Append(" request, ");
        body.Append(_options.ApplicationMediatr ? "MediatR.IMediator mediator" : behavior + "Handler handler");
        body.Append(", CancellationToken ct) =>\n");
        body.Append(i2).Append("{\n");

        var requestExpr = rebinds.Count > 0 ? $"request with {{ {string.Join(", ", rebinds)} }}" : "request";
        var call = _options.ApplicationMediatr ? $"mediator.Send({requestExpr}, ct)" : $"handler.HandleAsync({requestExpr}, ct)";
        if (!returnsValue)
        {
            body.Append(i3).Append("await ").Append(call).Append(";\n");
            body.Append(i3).Append("return Results.Ok();\n");
        }
        else
        {
            body.Append(i3).Append("var result = await ").Append(call).Append(";\n");
            body.Append(i3).Append(HttpResultFor(miss));
        }

        body.Append(i2).Append("})").Append(RequireAuthorizationFor(authRole)).Append(";\n");
    }

    /// <summary>
    /// Whether a route token bound-by-name to <paramref name="type"/> can actually be lifted into a
    /// <c>[FromRoute]</c> parameter (#1748): a scalar primitive, an enum, or an identity value object —
    /// every one of which ASP.NET Core Minimal APIs can bind from a single route-value string (identities
    /// via the <c>TryParse</c> convention, issue #1649). A general value object has no such binding, so a
    /// token matching one of those stays unbound in the emitted C# with an explanatory comment rather than
    /// emitting code that would not compile or would compile and then fail to bind at request time.
    /// </summary>
    private static bool IsRouteBindable(TypeRef type, ModelIndex index) =>
        index.Classify(type.Name) is TypeKind.Primitive or TypeKind.Enum or TypeKind.IdValueObject;

    /// <summary>
    /// Builds the <c>[FromRoute]</c> parameter list text and the <c>with { … }</c> rebind assignments for
    /// <paramref name="bindings"/> (#1748), shared by <see cref="WriteMutationEndpoint"/> and
    /// <see cref="WriteQueryEndpoint"/> so the two endpoint kinds can never diverge on how a token binds.
    /// Writes a matched-but-not-route-bindable token's explanatory comment straight into
    /// <paramref name="body"/> (at <paramref name="indent"/>) as it goes, ahead of the endpoint mapping
    /// call it precedes. The route token's raw text becomes both the <c>[FromRoute(Name = "…")]</c>
    /// argument (must match the route template exactly) and the emitted local's identifier — the latter
    /// through <see cref="CSharpNaming.EscapeIdentifier"/>, since a token can be spelled like a C#
    /// keyword (<c>{class}</c>, <c>{event}</c>, <c>{base}</c>, …) and only the identifier, not the
    /// attribute's string argument, needs the <c>@</c> escape to stay valid C#.
    /// </summary>
    /// <param name="identityProperty">The request/query property name an <see cref="RouteTokenTarget.Identity"/>
    /// binding rebinds — never actually reached for a query, which resolves no <c>Identity</c> binding.</param>
    private static (string RouteParams, List<string> Rebinds) BuildRouteTokenBindings(
        StringBuilder body, string indent, IReadOnlyList<RouteTokenBinding> bindings, string? identityProperty,
        CSharpTypeMapper typeMapper, ModelIndex index)
    {
        var routeParams = new StringBuilder();
        var rebinds = new List<string>();
        foreach (RouteTokenBinding binding in bindings)
        {
            if (binding.Target == RouteTokenTarget.Unbound)
            {
                continue;
            }

            if (!IsRouteBindable(binding.Type!, index))
            {
                body.Append(indent).Append("// route token '{").Append(binding.Token).Append("}': ")
                    .Append(binding.Type!.Name).Append(" is not route-bindable\n");
                continue;
            }

            var identifier = CSharpNaming.EscapeIdentifier(binding.Token);
            routeParams.Append("[Microsoft.AspNetCore.Mvc.FromRoute(Name = \"").Append(binding.Token)
                .Append("\")] ").Append(typeMapper.Map(binding.Type!)).Append(' ').Append(identifier).Append(", ");

            var prop = binding.Target == RouteTokenTarget.Identity
                ? identityProperty!
                : CSharpNaming.ToPascalCase(binding.Member!.Name);
            rebinds.Add($"{prop} = {identifier}");
        }

        return (routeParams.ToString(), rebinds);
    }

    /// <summary>A query → <c>GET /{query}</c> bound to <c>&lt;Query&gt;Handler</c>; criteria come from the query
    /// string. Honors the same R19 verb/route/role annotations as a command (#1219).</summary>
    private void WriteQueryEndpoint(StringBuilder body, ContextNode ctx, QueryDecl query, CSharpTypeMapper typeMapper, ModelIndex index)
    {
        RouteInfo info = RouteDerivation.ForQuery(query);
        // Only a by-identity query returns a wrapped value (nullable/Result<T>) — a list/non-identity
        // query returns a plain value, so its endpoint stays a plain 200 regardless of the policy. Uses
        // the same resolution as the Application-layer handler, so the two never disagree.
        var miss = ResolveByIdentityQuery(query, ctx) is not null ? _options.NotFound : CSharpNotFound.Throw;
        var i2 = Indent + Indent;
        var i3 = i2 + Indent;

        // Route-bindable criteria (#1748): the same lifting WriteMutationEndpoint applies to a command's
        // request, mirrored onto the [AsParameters] query record. A query has no aggregate identity, so
        // every RouteTokenTarget here is Member or Unbound (never Identity — RouteDerivation.ForQuery
        // never resolves one) — identityProperty is passed null accordingly.
        (string routeParams, List<string> rebinds) = BuildRouteTokenBindings(
            body, i2, info.TokenBindings, identityProperty: null, typeMapper, index);

        body.Append(i2).Append("endpoints.").Append(MapMethodFor(info.Verb, "MapGet")).Append("(\"")
            .Append(EscapeCSharpString(info.Route)).Append("\", async (").Append(routeParams)
            .Append("[AsParameters] ").Append(query.Name)
            .Append(" query, ").Append(query.Name).Append("Handler handler, CancellationToken ct) =>\n");
        body.Append(i2).Append("{\n");

        var queryExpr = rebinds.Count > 0 ? $"query with {{ {string.Join(", ", rebinds)} }}" : "query";
        body.Append(i3).Append("var result = await handler.HandleAsync(").Append(queryExpr).Append(", ct);\n");
        body.Append(i3).Append(HttpResultFor(miss));
        body.Append(i2).Append("})").Append(RequireAuthorizationFor(info.AuthRole)).Append(";\n");
    }

    /// <summary>
    /// ASP.NET's per-verb Minimal-API mapping method for a <see cref="RouteInfo.Verb"/>. The validator only
    /// admits the five verbs below (KOI1209), so an unrecognized one can't come from a valid model —
    /// it falls back to <paramref name="conventional"/> (the endpoint's un-annotated method) rather than
    /// emitting a <c>Map&lt;Whatever&gt;</c> call that wouldn't compile.
    /// </summary>
    private static string MapMethodFor(string verb, string conventional) => verb switch
    {
        "GET" => "MapGet",
        "POST" => "MapPost",
        "PUT" => "MapPut",
        "DELETE" => "MapDelete",
        "PATCH" => "MapPatch",
        _ => conventional,
    };

    /// <summary>
    /// The explicit body-binding attribute a mutating endpoint's request parameter needs, or the empty
    /// string for the body-taking verbs (so every pre-R19 endpoint stays byte-identical).
    ///
    /// <para>ASP.NET only <em>infers</em> a complex parameter as the request body for verbs that define
    /// body semantics; for GET/DELETE/HEAD/OPTIONS/TRACE/CONNECT inferred-body binding is disabled. An
    /// <c>@get</c>/<c>@delete</c> command (#1219) still binds a <c>&lt;Behavior&gt;Request</c> record, so
    /// without this the endpoint would <b>compile</b> and then throw
    /// <c>InvalidOperationException: Body was inferred but the method does not allow inferred body
    /// parameters</c> the moment the route table is built — i.e. at app startup, which a compile-only
    /// check cannot catch. An <b>explicit</b> <c>[FromBody]</c> overrides that restriction. Written by
    /// fully-qualified name, like the rest of this layer, so no <c>using</c> is added.</para>
    /// </summary>
    private static string BodyBindingAttributeFor(string verb) =>
        BodylessVerbs.Contains(verb) ? "[Microsoft.AspNetCore.Mvc.FromBody] " : "";

    /// <summary>The <c>.RequireAuthorization("role")</c> suffix an <c>@auth</c> annotation adds to the endpoint's
    /// call chain, or the empty string when the operation carries none (#1219).</summary>
    private static string RequireAuthorizationFor(string? authRole) =>
        string.IsNullOrEmpty(authRole) ? "" : $".RequireAuthorization(\"{EscapeCSharpString(authRole)}\")";

    /// <summary>The <c>return</c> line mapping a handler's returned value to an HTTP result per the not-found policy.</summary>
    private static string HttpResultFor(CSharpNotFound miss) => miss switch
    {
        CSharpNotFound.Nullable => "return result is null ? Results.NotFound() : Results.Ok(result);\n",
        CSharpNotFound.Result => "return result.IsSuccess ? Results.Ok(result.Value) : Results.NotFound();\n",
        _ => "return Results.Ok(result);\n",
    };
}
