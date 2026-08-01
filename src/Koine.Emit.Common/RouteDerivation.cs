using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The HTTP shape one entity command or query derives to: an <c>(entity, command|query) -&gt;
/// { verb, route, operationId, requestShape, responseShape }</c> mapping (#1042 / W2.0). AST-only —
/// no target syntax — so both the <c>openapi</c> emitter and the C# <c>api</c> layer can share one
/// source of truth for routes, verbs and operation ids instead of duplicating the derivation.
/// </summary>
/// <param name="Verb">The HTTP verb: <c>POST</c> for a command, <c>GET</c> for a query — or the verb
/// an <c>@get</c>/<c>@post</c>/<c>@put</c>/<c>@delete</c>/<c>@patch</c> annotation named (R19 / #1219).</param>
/// <param name="Route">The kebab-cased path (<c>/order/place</c>, <c>/order-by-id</c>) — or the
/// <c>@route</c> annotation's path verbatim (R19 / #1219).</param>
/// <param name="OperationId">The OpenAPI-style operation id (<c>Order_Place</c> for a command,
/// the bare query name for a query).</param>
/// <param name="RequestShape">The parameters/criteria that become the request body/query string.</param>
/// <param name="ResponseShape">The type the operation returns, or <c>null</c> for a command with no
/// return type.</param>
/// <param name="AuthRole">The role an <c>@auth("role")</c> annotation requires, or <c>null</c> when the
/// operation carries none (R19 / #1219).</param>
public readonly record struct RouteInfo(
    string Verb,
    string Route,
    string OperationId,
    IReadOnlyList<Param> RequestShape,
    TypeRef? ResponseShape,
    string? AuthRole);

/// <summary>
/// Derives the shared <see cref="RouteInfo"/> for an entity command or a query (#1042 / W2.0). This is
/// an <b>emit-side</b> concern, not a model query, so it lives in <c>Koine.Emit.Common</c> rather than
/// <c>Ast/</c>: it decides HTTP-oriented shape (verb, route, operation id), a presentation-layer
/// concept the target-agnostic semantic model has no opinion on.
/// </summary>
public static class RouteDerivation
{
    /// <summary>
    /// A command → <c>POST /{entity}/{command}</c>, its parameters the request body — unless the command
    /// carries R19 API annotations (#1219), in which case <c>@route</c> supplies the path verbatim and an
    /// <c>@get</c>/<c>@post</c>/… annotation the verb. The three axes (route, verb, role) are independent:
    /// each falls back to the convention on its own.
    /// </summary>
    public static RouteInfo ForCommand(EntityDecl entity, CommandDecl command) => new(
        Verb: command.VerbOverride ?? "POST",
        Route: command.RouteOverride ?? $"/{Kebab(entity.Name)}/{Kebab(command.Name)}",
        OperationId: $"{entity.Name}_{command.Name}",
        RequestShape: command.Parameters,
        ResponseShape: command.ReturnType,
        AuthRole: command.AuthRole);

    /// <summary>
    /// A query → <c>GET /{query}</c>, its criteria the query-string parameters — with the same R19
    /// annotation overrides as <see cref="ForCommand"/> (#1219).
    /// </summary>
    public static RouteInfo ForQuery(QueryDecl query) => new(
        Verb: query.VerbOverride ?? "GET",
        Route: query.RouteOverride ?? $"/{Kebab(query.Name)}",
        OperationId: query.Name,
        RequestShape: query.Criteria,
        ResponseShape: query.ResultType,
        AuthRole: query.AuthRole);

    /// <summary>
    /// Converts a Pascal/camel-cased identifier to a kebab-cased path segment
    /// (<c>OrdersByStatus → orders-by-status</c>). A boundary is inserted before an uppercase letter that
    /// either follows a lowercase/digit or ends an acronym run (an uppercase followed by a lowercase), so
    /// acronyms split as expected (<c>XMLImport → xml-import</c>) — matching the word-boundary convention
    /// the per-language <c>ToSnakeCase</c> naming helpers use. Thin wrapper over the shared
    /// <see cref="IdentifierWords.Split"/> boundary rule (#1239); passes <c>splitAfterDigit: true</c> to
    /// preserve this method's pre-extraction digit-boundary behavior (<c>Order2Ship → order2-ship</c>) —
    /// a rule the per-language <c>ToSnakeCase</c> helpers never had (#1239 code review).
    /// </summary>
    public static string Kebab(string name) =>
        string.Join('-', IdentifierWords.Split(name, splitAfterDigit: true)).ToLowerInvariant();
}
