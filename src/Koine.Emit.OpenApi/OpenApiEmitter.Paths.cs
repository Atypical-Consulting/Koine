using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The <c>paths</c> layer of the OpenAPI emitter: the behavioral surface of a bounded context becomes
/// HTTP operations. An entity <see cref="CommandDecl"/> maps to a <c>POST</c> whose JSON request body is
/// built from the command's parameters (a state-changing operation); a <see cref="QueryDecl"/> maps to a
/// <c>GET</c> whose criteria become query <c>parameters</c> and whose <c>200</c> response references the
/// result schema (a side-effect-free read). Operation paths are kebab-cased and the whole map is emitted
/// in a stable ordinal-by-path order so Verify snapshots are reproducible.
/// <para>R19's <c>@route</c>/<c>@get</c>…<c>@patch</c>/<c>@auth</c> annotations (#1219) override the path,
/// the verb key, and add a per-operation <c>security</c> requirement — all three read off the shared
/// <see cref="RouteInfo"/>, so the openapi document and the C# <c>api</c> layer never disagree.</para>
/// </summary>
public sealed partial class OpenApiEmitter
{
    /// <summary>
    /// Builds the <c>paths</c> object: a POST per entity command and a GET per query — or the verb an R19
    /// annotation named — grouped by path and ordered by it.
    /// </summary>
    private static YamlObject BuildPaths(ContextNode ctx, ModelIndex index)
    {
        var emitted = SchemaTypeNames(ctx);
        var operations = new List<(string Path, string Verb, YamlObject Operation)>();

        // Commands: state-changing operations on entities (top-level and aggregate-nested) → POST.
        foreach (EntityDecl entity in ctx.AllEntities())
        {
            foreach (CommandDecl command in entity.Commands)
            {
                RouteInfo route = RouteDerivation.ForCommand(entity, command);
                operations.Add((
                    route.Route,
                    route.Verb.ToLowerInvariant(),
                    CommandOperation(entity, command, route, index, emitted)));
            }
        }

        // Queries: read operations over a read model → GET.
        foreach (QueryDecl query in ctx.AllTypeDecls().OfType<QueryDecl>())
        {
            RouteInfo route = RouteDerivation.ForQuery(query);
            operations.Add((
                route.Route,
                route.Verb.ToLowerInvariant(),
                QueryOperation(query, route, index, emitted)));
        }

        // OpenAPI keys the path item by path, then the operation by verb — so several operations sharing
        // a path (which `@route` makes possible: `PUT`/`DELETE` on one resource) have to merge into ONE
        // path item rather than emit one entry each, which would be a duplicate YAML mapping key.
        // `GroupBy` is order-preserving (groups in first-appearance order, members in source order), so
        // the ordinal sort by path below is still the single source of ordering truth.
        var paths = new YamlObject();
        foreach (var group in operations.GroupBy(o => o.Path).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var pathItem = new YamlObject();
            var verbs = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (_, verb, operation) in group)
            {
                // Defensive, first-wins: two declarations resolving to the same path AND verb is a
                // KOI1211 error, so a valid model never gets here — but an emitter can be driven without
                // the validator (the MCP/Studio hosts, a plugin pipeline), and emitting the verb key twice
                // would produce a document no YAML parser will read ("duplicated mapping key"). Dropping
                // the later operation deterministically keeps the document parseable; the diagnostic, not
                // this guard, is what tells the author about it.
                if (verbs.Add(verb))
                {
                    pathItem.Add(verb, operation);
                }
            }

            paths.Add(group.Key, pathItem);
        }

        return paths;
    }

    /// <summary>
    /// The <c>in: path</c> parameter objects an operation's route template implies (#1219). OpenAPI
    /// requires every <c>{token}</c> in a path key to be declared as a required path parameter, so an
    /// <c>@route("/orders/{id}")</c> that declared none produced a document a real validator rejects
    /// (<c>openapi-spec-validator</c>: "Path parameter 'id' … was not resolved"; <c>redocly lint</c>:
    /// <c>path-parameters-defined</c>). Tokens come from the shared <see cref="RouteTemplate"/> walker
    /// (#1748), in declaration order and de-duplicated. Every token is typed <c>string</c>: the route is
    /// free text, so nothing here says what the token binds to (see §15.9 of the reference docs).
    /// </summary>
    private static YamlArray? PathParameters(string route)
    {
        IReadOnlyList<string> names = RouteTemplate.Tokens(route);
        if (names.Count == 0)
        {
            return null;
        }

        var parameters = new YamlArray();
        foreach (var name in names)
        {
            var parameter = new YamlObject();
            parameter.Add("name", name);
            parameter.Add("in", "path");
            // A path token is always required — OpenAPI forbids an optional one, even for `{id?}`.
            parameter.Add("required", Yaml.Bool(true));
            parameter.Add("schema", new YamlObject().Add("type", "string"));
            parameters.Add(parameter);
        }

        return parameters;
    }

    /// <summary>
    /// Adds the OpenAPI security-requirement object an <c>@auth("role")</c> annotation implies —
    /// <c>security: [{ "&lt;role&gt;": [] }]</c>, the role naming a security scheme the consumer declares —
    /// or leaves the operation untouched when it carries none (#1219). Built eagerly-safe: the empty scope
    /// array is only constructed once a role is actually present.
    /// </summary>
    private static void AddSecurity(YamlObject operation, RouteInfo route)
    {
        if (route.AuthRole is { Length: > 0 } role)
        {
            operation.Add("security", new YamlArray().Add(new YamlObject().Add(role, new YamlArray())));
        }
    }

    /// <summary>A command → a <c>POST</c> operation (or its <c>@put</c>/<c>@delete</c>/… verb): the route
    /// template's path parameters, a JSON request body from its parameters, plus success/validation responses
    /// and any <c>@auth</c> security requirement.</summary>
    private static YamlObject CommandOperation(EntityDecl entity, CommandDecl command, RouteInfo route, ModelIndex index, HashSet<string> emitted)
    {
        var operation = new YamlObject();
        operation.Add("operationId", route.OperationId);
        operation.Add("summary", string.IsNullOrWhiteSpace(command.Doc)
            ? Yaml.Str($"{command.Name} on {entity.Name}")
            : Yaml.Str(OneLine(command.Doc!)));

        // An `@route` template's `{token}`s must be declared as path parameters or the document is invalid.
        if (PathParameters(route.Route) is { } pathParameters)
        {
            operation.Add("parameters", pathParameters);
        }

        // The parameters become a required JSON request body; a no-argument command carries none.
        if (command.Parameters.Count > 0)
        {
            var content = new YamlObject();
            content.Add("application/json", new YamlObject().Add(
                "schema", ParameterObjectSchema(command.Parameters, index, emitted)));

            var requestBody = new YamlObject();
            requestBody.Add("required", Yaml.Bool(true));
            requestBody.Add("content", content);
            operation.Add("requestBody", requestBody);
        }

        var responses = new YamlObject();
        if (command.ReturnType is { } returnType)
        {
            responses.Add("200", JsonResponse("The command result.", returnType, index, emitted));
        }
        else
        {
            responses.Add("204", new YamlObject().Add("description", "The command succeeded."));
        }

        responses.Add("400", new YamlObject().Add("description", "A precondition or invariant was violated."));
        operation.Add("responses", responses);
        AddSecurity(operation, route);
        return operation;
    }

    /// <summary>A query → a <c>GET</c> operation (or its annotated verb): its route template's tokens become
    /// path parameters and its criteria query parameters, the result a <c>200</c> body, and any <c>@auth</c>
    /// role a security requirement.</summary>
    private static YamlObject QueryOperation(QueryDecl query, RouteInfo route, ModelIndex index, HashSet<string> emitted)
    {
        var operation = new YamlObject();
        operation.Add("operationId", route.OperationId);
        operation.Add("summary", string.IsNullOrWhiteSpace(query.Doc)
            ? Yaml.Str(query.Name)
            : Yaml.Str(OneLine(query.Doc!)));

        // Path parameters first (they are part of the URL), then the criteria as query parameters — the
        // two live in one `parameters` array, distinguished by their `in` value.
        YamlArray? parameters = PathParameters(route.Route);
        if (query.Criteria.Count > 0)
        {
            parameters ??= new YamlArray();
            foreach (Param criterion in query.Criteria)
            {
                var parameter = new YamlObject();
                parameter.Add("name", criterion.Name);
                parameter.Add("in", "query");
                parameter.Add("required", Yaml.Bool(!criterion.Type.IsOptional));
                parameter.Add("schema", SchemaForType(criterion.Type, index, emitted));
                parameters.Add(parameter);
            }
        }

        if (parameters is not null)
        {
            operation.Add("parameters", parameters);
        }

        var responses = new YamlObject();
        responses.Add("200", JsonResponse("The matching results.", query.ResultType, index, emitted));
        operation.Add("responses", responses);
        AddSecurity(operation, route);
        return operation;
    }

    /// <summary>An object schema (properties + required) built from a parameter list — a command request body.</summary>
    private static YamlObject ParameterObjectSchema(IReadOnlyList<Param> parameters, ModelIndex index, HashSet<string> emitted) =>
        ObjectSchema(
            doc: null,
            parameters.Select(p => (p.Name, p.Type, (string?)null, (IReadOnlyList<KeyValuePair<string, Yaml>>?)null)),
            index,
            emitted);

    /// <summary>A <c>200</c>-style JSON response: a description plus an <c>application/json</c> schema for <paramref name="type"/>.</summary>
    private static YamlObject JsonResponse(string description, TypeRef type, ModelIndex index, HashSet<string> emitted)
    {
        var content = new YamlObject();
        content.Add("application/json", new YamlObject().Add("schema", SchemaForType(type, index, emitted)));

        var response = new YamlObject();
        response.Add("description", description);
        response.Add("content", content);
        return response;
    }
}
