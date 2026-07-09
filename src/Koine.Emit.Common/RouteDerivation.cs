using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The HTTP shape one entity command or query derives to: an <c>(entity, command|query) -&gt;
/// { verb, route, operationId, requestShape, responseShape }</c> mapping (#1042 / W2.0). AST-only —
/// no target syntax — so both the <c>openapi</c> emitter and the C# <c>api</c> layer can share one
/// source of truth for routes, verbs and operation ids instead of duplicating the derivation.
/// </summary>
/// <param name="Verb">The HTTP verb: <c>POST</c> for a command, <c>GET</c> for a query.</param>
/// <param name="Route">The kebab-cased path (<c>/order/place</c>, <c>/order-by-id</c>).</param>
/// <param name="OperationId">The OpenAPI-style operation id (<c>Order_Place</c> for a command,
/// the bare query name for a query).</param>
/// <param name="RequestShape">The parameters/criteria that become the request body/query string.</param>
/// <param name="ResponseShape">The type the operation returns, or <c>null</c> for a command with no
/// return type.</param>
public readonly record struct RouteInfo(
    string Verb,
    string Route,
    string OperationId,
    IReadOnlyList<Param> RequestShape,
    TypeRef? ResponseShape);

/// <summary>
/// Derives the shared <see cref="RouteInfo"/> for an entity command or a query (#1042 / W2.0). This is
/// an <b>emit-side</b> concern, not a model query, so it lives in <c>Koine.Emit.Common</c> rather than
/// <c>Ast/</c>: it decides HTTP-oriented shape (verb, route, operation id), a presentation-layer
/// concept the target-agnostic semantic model has no opinion on.
/// </summary>
public static class RouteDerivation
{
    /// <summary>A command → <c>POST /{entity}/{command}</c>, its parameters the request body.</summary>
    public static RouteInfo ForCommand(EntityDecl entity, CommandDecl command) => new(
        Verb: "POST",
        Route: $"/{Kebab(entity.Name)}/{Kebab(command.Name)}",
        OperationId: $"{entity.Name}_{command.Name}",
        RequestShape: command.Parameters,
        ResponseShape: command.ReturnType);

    /// <summary>A query → <c>GET /{query}</c>, its criteria the query-string parameters.</summary>
    public static RouteInfo ForQuery(QueryDecl query) => new(
        Verb: "GET",
        Route: $"/{Kebab(query.Name)}",
        OperationId: query.Name,
        RequestShape: query.Criteria,
        ResponseShape: query.ResultType);

    /// <summary>
    /// Converts a Pascal/camel-cased identifier to a kebab-cased path segment
    /// (<c>OrdersByStatus → orders-by-status</c>). A boundary is inserted before an uppercase letter that
    /// either follows a lowercase/digit or ends an acronym run (an uppercase followed by a lowercase), so
    /// acronyms split as expected (<c>XMLImport → xml-import</c>) — matching the word-boundary convention
    /// the per-language <c>ToSnakeCase</c> naming helpers use.
    /// </summary>
    public static string Kebab(string name)
    {
        var sb = new System.Text.StringBuilder(name.Length + 4);
        for (int i = 0; i < name.Length; i++)
        {
            char c = name[i];
            if (char.IsAsciiLetterUpper(c))
            {
                bool afterWord = i > 0 && (char.IsAsciiLetterLower(name[i - 1]) || char.IsAsciiDigit(name[i - 1]));
                bool acronymEnd = i > 0 && char.IsAsciiLetterUpper(name[i - 1])
                    && i + 1 < name.Length && char.IsAsciiLetterLower(name[i + 1]);
                if (afterWord || acronymEnd)
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
