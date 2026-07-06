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
/// routes); app-specific policy (auth, non-default status codes, custom routes) stays hand-written until
/// the annotation escape hatches land.</para>
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
    /// Emits one context's <c>&lt;Context&gt;Endpoints</c> extension (W2), or nothing when the context has
    /// no commands, factories or queries to map.
    /// </summary>
    private void EmitApiLayer(EmitContext emit, List<EmittedFile> files, ContextNode ctx)
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
                    WriteCommandEndpoint(body, root, cmd);
                    any = true;
                }
            }

            if (repoOps.Contains("add"))
            {
                foreach (FactoryDecl factory in root.Factories)
                {
                    WriteFactoryEndpoint(body, root, factory);
                    any = true;
                }
            }
        }

        foreach (QueryDecl query in ctx.Types.OfType<QueryDecl>())
        {
            WriteQueryEndpoint(body, ctx, query);
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

    /// <summary>A command → <c>POST /{entity}/{command}</c> bound to <c>&lt;Behavior&gt;Handler</c>.</summary>
    private void WriteCommandEndpoint(StringBuilder body, EntityDecl root, CommandDecl cmd)
    {
        var behavior = root.Name + CSharpNaming.ToPascalCase(cmd.Name);
        var route = "/" + Kebab(root.Name) + "/" + Kebab(cmd.Name);

        // Mirror the Application layer's handler result shape (W1): the handler returns a value when the
        // command declares a return type, or --app-handler-result aggregate/readModel, or --app-not-found
        // nullable/result. A command always loads by id, so it honors the not-found policy — nullable
        // maps null → 404, result maps Result<T> → 200/404.
        var returnsValue = cmd.ReturnType is not null
            || _options.HandlerResult is CSharpHandlerResult.Aggregate or CSharpHandlerResult.ReadModel
            || _options.NotFound is CSharpNotFound.Nullable or CSharpNotFound.Result;
        WriteMutationEndpoint(body, route, behavior, returnsValue, _options.NotFound);
    }

    /// <summary>A factory → <c>POST /{entity}/{factory}</c>; it always returns the created aggregate.</summary>
    private void WriteFactoryEndpoint(StringBuilder body, EntityDecl root, FactoryDecl factory)
    {
        var behavior = root.Name + CSharpNaming.ToPascalCase(factory.Name);
        var route = "/" + Kebab(root.Name) + "/" + Kebab(factory.Name);
        // A factory creates — it has no not-found concept — so it always returns the created aggregate
        // plainly, regardless of the not-found policy.
        WriteMutationEndpoint(body, route, behavior, returnsValue: true, CSharpNotFound.Throw);
    }

    /// <summary>
    /// Writes a POST endpoint that binds <c>&lt;Behavior&gt;Request</c> from the body and invokes the
    /// handler. In plain mode it injects the concrete handler and calls <c>HandleAsync</c>; in MediatR
    /// mode it injects <c>IMediator</c> and calls <c>Send</c>. <paramref name="miss"/> shapes the HTTP
    /// result from the handler's return: <c>Throw</c> ⇒ plain 200; <c>Nullable</c> ⇒ null → 404;
    /// <c>Result</c> ⇒ a <c>Result&lt;T&gt;</c> → 200 with the value / 404.
    /// </summary>
    private void WriteMutationEndpoint(StringBuilder body, string route, string behavior, bool returnsValue, CSharpNotFound miss)
    {
        var requestType = behavior + "Request";
        var i2 = Indent + Indent;
        var i3 = i2 + Indent;

        body.Append(i2).Append("endpoints.MapPost(\"").Append(route).Append("\", async (").Append(requestType).Append(" request, ");
        body.Append(_options.ApplicationMediatr ? "MediatR.IMediator mediator" : behavior + "Handler handler");
        body.Append(", CancellationToken ct) =>\n");
        body.Append(i2).Append("{\n");

        var call = _options.ApplicationMediatr ? "mediator.Send(request, ct)" : "handler.HandleAsync(request, ct)";
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

        body.Append(i2).Append("});\n");
    }

    /// <summary>A query → <c>GET /{query}</c> bound to <c>&lt;Query&gt;Handler</c>; criteria come from the query string.</summary>
    private void WriteQueryEndpoint(StringBuilder body, ContextNode ctx, QueryDecl query)
    {
        var route = "/" + Kebab(query.Name);
        // Only a by-identity query returns a wrapped value (nullable/Result<T>) — a list/non-identity
        // query returns a plain value, so its endpoint stays a plain 200 regardless of the policy. Uses
        // the same resolution as the Application-layer handler, so the two never disagree.
        var miss = ResolveByIdentityQuery(query, ctx) is not null ? _options.NotFound : CSharpNotFound.Throw;
        var i2 = Indent + Indent;
        var i3 = i2 + Indent;

        body.Append(i2).Append("endpoints.MapGet(\"").Append(route).Append("\", async ([AsParameters] ").Append(query.Name)
            .Append(" query, ").Append(query.Name).Append("Handler handler, CancellationToken ct) =>\n");
        body.Append(i2).Append("{\n");
        body.Append(i3).Append("var result = await handler.HandleAsync(query, ct);\n");
        body.Append(i3).Append(HttpResultFor(miss));
        body.Append(i2).Append("});\n");
    }

    /// <summary>The <c>return</c> line mapping a handler's returned value to an HTTP result per the not-found policy.</summary>
    private static string HttpResultFor(CSharpNotFound miss) => miss switch
    {
        CSharpNotFound.Nullable => "return result is null ? Results.NotFound() : Results.Ok(result);\n",
        CSharpNotFound.Result => "return result.IsSuccess ? Results.Ok(result.Value) : Results.NotFound();\n",
        _ => "return Results.Ok(result);\n",
    };

    /// <summary>Kebab-cases a PascalCase name for a route segment (Order → order, OrderById → order-by-id).</summary>
    private static string Kebab(string name)
    {
        var sb = new StringBuilder(name.Length + 4);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c))
            {
                if (i > 0)
                {
                    sb.Append('-');
                }

                sb.Append(char.ToLowerInvariant(c));
            }
            else
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }
}
