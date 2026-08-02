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
/// <param name="TokenBindings">What each <c>{token}</c> in <paramref name="Route"/> resolves to (#1748):
/// empty for a conventional route or one with no tokens. Resolved once here so the <c>openapi</c> document
/// and the C# <c>api</c> layer read one answer and cannot disagree about what a token binds to.</param>
public readonly record struct RouteInfo(
    string Verb,
    string Route,
    string OperationId,
    IReadOnlyList<Param> RequestShape,
    TypeRef? ResponseShape,
    string? AuthRole,
    IReadOnlyList<RouteTokenBinding> TokenBindings);

/// <summary>What a <c>@route</c> <c>{token}</c> resolves to (#1748).</summary>
public enum RouteTokenTarget
{
    /// <summary>The token names neither a parameter/criterion nor the aggregate identity — KOI1215.</summary>
    Unbound,

    /// <summary>The token names a command parameter or query criterion (by <see cref="RouteTokenBinding.Member"/>).</summary>
    Member,

    /// <summary>The token is <c>id</c> and the declaration is a command on an entity with no <c>id</c>-named parameter — binds to the aggregate identity.</summary>
    Identity,
}

/// <summary>
/// One <c>{token}</c> in a <c>@route</c> template resolved against a command's parameters / a query's
/// criteria / the aggregate identity (#1748). <see cref="Token"/> is the bare name
/// <see cref="Ast.RouteTemplate.Tokens"/> produced (declaration-order, de-duplicated, ASP.NET
/// constraint/modifier syntax already stripped). <see cref="Member"/> is set only for
/// <see cref="RouteTokenTarget.Member"/>; <see cref="Type"/> is the type to bind — the member's own type,
/// or the aggregate identity's type for <see cref="RouteTokenTarget.Identity"/> — and is <c>null</c> for
/// <see cref="RouteTokenTarget.Unbound"/>.
/// </summary>
public readonly record struct RouteTokenBinding(
    string Token,
    RouteTokenTarget Target,
    Param? Member,
    TypeRef? Type);

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
    public static RouteInfo ForCommand(EntityDecl entity, CommandDecl command)
    {
        var route = command.RouteOverride ?? $"/{Kebab(entity.Name)}/{Kebab(command.Name)}";
        return new(
            Verb: command.VerbOverride ?? "POST",
            Route: route,
            OperationId: $"{entity.Name}_{command.Name}",
            RequestShape: command.Parameters,
            ResponseShape: command.ReturnType,
            AuthRole: command.AuthRole,
            TokenBindings: ResolveTokenBindings(route, command.Parameters, entity));
    }

    /// <summary>
    /// A query → <c>GET /{query}</c>, its criteria the query-string parameters — with the same R19
    /// annotation overrides as <see cref="ForCommand"/> (#1219).
    /// </summary>
    public static RouteInfo ForQuery(QueryDecl query)
    {
        var route = query.RouteOverride ?? $"/{Kebab(query.Name)}";
        return new(
            Verb: query.VerbOverride ?? "GET",
            Route: route,
            OperationId: query.Name,
            RequestShape: query.Criteria,
            ResponseShape: query.ResultType,
            AuthRole: query.AuthRole,
            TokenBindings: ResolveTokenBindings(route, query.Criteria, entity: null));
    }

    /// <summary>
    /// A factory → <c>POST /{entity}/{factory}</c>, its parameters the request body and the created
    /// aggregate the response — unless the factory carries R19 API annotations (#1846), which override
    /// the same three independent axes <see cref="ForCommand"/> honors.
    ///
    /// <para>Token resolution passes <c>entity: null</c> — deliberately, and unlike
    /// <see cref="ForCommand"/>. A command loads an existing aggregate, so its request record carries an
    /// identity property an <c>{id}</c> token can bind to; a factory <i>creates</i> one, and its request
    /// record is built from <see cref="FactoryDecl.Parameters"/> alone, so there is no identity property
    /// to rebind and an <see cref="RouteTokenTarget.Identity"/> binding would emit uncompilable C#. On a
    /// factory <c>{id}</c> therefore binds only when the factory declares a parameter of that name (the
    /// explicit-id opt-in for a non-Guid identity, #324) — otherwise it is an unbound token, which is
    /// KOI1215's concern. <c>Semantics/</c> passes a <c>null</c> identity for a factory for the same
    /// reason, so the warning and the emitted code agree.</para>
    /// </summary>
    public static RouteInfo ForFactory(EntityDecl entity, FactoryDecl factory)
    {
        var route = factory.RouteOverride ?? $"/{Kebab(entity.Name)}/{Kebab(factory.Name)}";
        return new(
            Verb: factory.VerbOverride ?? "POST",
            Route: route,
            OperationId: $"{entity.Name}_{factory.Name}",
            RequestShape: factory.Parameters,
            ResponseShape: new TypeRef(entity.Name),
            AuthRole: factory.AuthRole,
            TokenBindings: ResolveTokenBindings(route, factory.Parameters, entity: null));
    }

    /// <summary>
    /// Resolves each <c>{token}</c> in <paramref name="route"/> against <paramref name="shape"/> (a
    /// command's parameters or a query's criteria) — #1748. Resolution order: a member of
    /// <paramref name="shape"/> whose name matches the token (<see cref="StringComparison.OrdinalIgnoreCase"/>,
    /// mirroring ASP.NET's own case-insensitive route-value binding); else, when <paramref name="entity"/>
    /// is not <c>null</c> (a command, never a query — a query has no aggregate identity) and the token is
    /// <c>id</c>, the aggregate identity; else unbound (KOI1215's concern, not this method's). A rename
    /// silently unbinding a token, or a token that never named anything, are exactly what KOI1215 exists
    /// to catch — explicit binding syntax (<c>bind id -&gt; orderId</c>) was rejected for the same case in
    /// #1219/#1748's design discussion as unneeded ceremony over name-matching.
    /// </summary>
    private static IReadOnlyList<RouteTokenBinding> ResolveTokenBindings(
        string route, IReadOnlyList<Param> shape, EntityDecl? entity)
    {
        IReadOnlyList<string> tokens = RouteTemplate.Tokens(route);
        if (tokens.Count == 0)
        {
            return [];
        }

        var bindings = new List<RouteTokenBinding>(tokens.Count);
        foreach (var token in tokens)
        {
            Param? member = null;
            foreach (var candidate in shape)
            {
                if (string.Equals(candidate.Name, token, StringComparison.OrdinalIgnoreCase))
                {
                    member = candidate;
                    break;
                }
            }

            if (member is not null)
            {
                bindings.Add(new RouteTokenBinding(token, RouteTokenTarget.Member, member, member.Type));
            }
            else if (entity is not null && string.Equals(token, "id", StringComparison.OrdinalIgnoreCase))
            {
                bindings.Add(new RouteTokenBinding(
                    token, RouteTokenTarget.Identity, Member: null, Type: new TypeRef(entity.IdentityName)));
            }
            else
            {
                bindings.Add(new RouteTokenBinding(token, RouteTokenTarget.Unbound, Member: null, Type: null));
            }
        }

        return bindings;
    }

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
