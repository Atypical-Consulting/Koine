using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The <c>paths</c> layer of the OpenAPI emitter: the behavioral surface of a bounded context becomes
/// HTTP operations. An entity <see cref="CommandDecl"/> maps to a <c>POST</c> whose JSON request body is
/// built from the command's parameters (a state-changing operation); a <see cref="QueryDecl"/> maps to a
/// <c>GET</c> whose criteria become query <c>parameters</c> and whose <c>200</c> response references the
/// result schema (a side-effect-free read). Operation paths are kebab-cased and the whole map is emitted
/// in a stable ordinal-by-path order so Verify snapshots are reproducible.
/// </summary>
public sealed partial class OpenApiEmitter
{
    /// <summary>Builds the <c>paths</c> object: a POST per entity command and a GET per query, ordered by path.</summary>
    private static YamlObject BuildPaths(ContextNode ctx, ModelIndex index)
    {
        var emitted = SchemaTypeNames(ctx);
        var operations = new List<(string Path, YamlObject Operation)>();

        // Commands: state-changing operations on entities (top-level and aggregate-nested) → POST.
        foreach (EntityDecl entity in ctx.AllEntities())
        {
            foreach (CommandDecl command in entity.Commands)
            {
                operations.Add((
                    RouteDerivation.ForCommand(entity, command).Route,
                    new YamlObject().Add("post", CommandOperation(entity, command, index, emitted))));
            }
        }

        // Queries: read operations over a read model → GET.
        foreach (QueryDecl query in ctx.AllTypeDecls().OfType<QueryDecl>())
        {
            operations.Add((
                RouteDerivation.ForQuery(query).Route,
                new YamlObject().Add("get", QueryOperation(query, index, emitted))));
        }

        var paths = new YamlObject();
        foreach (var (path, operation) in operations.OrderBy(o => o.Path, StringComparer.Ordinal))
        {
            paths.Add(path, operation);
        }

        return paths;
    }

    /// <summary>A command → a <c>POST</c> operation: a JSON request body from its parameters, plus success/validation responses.</summary>
    private static YamlObject CommandOperation(EntityDecl entity, CommandDecl command, ModelIndex index, HashSet<string> emitted)
    {
        var operation = new YamlObject();
        operation.Add("operationId", RouteDerivation.ForCommand(entity, command).OperationId);
        operation.Add("summary", string.IsNullOrWhiteSpace(command.Doc)
            ? Yaml.Str($"{command.Name} on {entity.Name}")
            : Yaml.Str(OneLine(command.Doc!)));

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
        return operation;
    }

    /// <summary>A query → a <c>GET</c> operation: its criteria become query parameters, the result a <c>200</c> body.</summary>
    private static YamlObject QueryOperation(QueryDecl query, ModelIndex index, HashSet<string> emitted)
    {
        var operation = new YamlObject();
        operation.Add("operationId", RouteDerivation.ForQuery(query).OperationId);
        operation.Add("summary", string.IsNullOrWhiteSpace(query.Doc)
            ? Yaml.Str(query.Name)
            : Yaml.Str(OneLine(query.Doc!)));

        if (query.Criteria.Count > 0)
        {
            var parameters = new YamlArray();
            foreach (Param criterion in query.Criteria)
            {
                var parameter = new YamlObject();
                parameter.Add("name", criterion.Name);
                parameter.Add("in", "query");
                parameter.Add("required", Yaml.Bool(!criterion.Type.IsOptional));
                parameter.Add("schema", SchemaForType(criterion.Type, index, emitted));
                parameters.Add(parameter);
            }

            operation.Add("parameters", parameters);
        }

        var responses = new YamlObject();
        responses.Add("200", JsonResponse("The matching results.", query.ResultType, index, emitted));
        operation.Add("responses", responses);
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
