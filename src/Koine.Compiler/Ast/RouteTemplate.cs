namespace Koine.Compiler.Ast;

/// <summary>
/// Walks an <c>@route</c> path template's <c>{token}</c>s (#1748). An HTTP route template is not a
/// C#-specific concept — it already lives in the AST as <c>CommandDecl.RouteOverride</c> /
/// <c>QueryDecl.RouteOverride</c> — but two different consumers need to walk it the same way:
/// <c>Semantics/CqrsValidator</c> (KOI1208/KOI1215, which may not reference <c>Koine.Emit.Common</c>)
/// and <c>Koine.Emit.Common/RouteDerivation</c> (token-to-member binding, KOI1215's OpenAPI/C#
/// counterpart). Putting the tokenizer here — reachable from both, since the dependency only ever
/// runs emit → compiler — is what keeps them from re-implementing (and silently drifting from) one
/// another, exactly as <see cref="RouteDerivation"/>'s own XML doc explains for <c>RouteInfo</c>.
/// </summary>
public static class RouteTemplate
{
    /// <summary>
    /// The bare, de-duplicated <c>{token}</c> names in <paramref name="route"/>, in declaration order.
    /// <c>{{</c> escapes a literal brace and opens no token; an unterminated <c>{</c> (no matching
    /// <c>}</c>) stops tokenization silently — a malformed template is KOI1208's job to reject, not
    /// this method's to guess at. An empty token (<c>{}</c>) is skipped.
    /// </summary>
    public static IReadOnlyList<string> Tokens(string route)
    {
        List<string>? names = null;
        for (var i = 0; i < route.Length; i++)
        {
            if (route[i] != '{')
            {
                continue;
            }

            if (IsEscapedBrace(route, i, '{'))
            {
                i++;
                continue;
            }

            var close = route.IndexOf('}', i + 1);
            if (close < 0)
            {
                break;
            }

            var name = ParameterName(route[(i + 1)..close]);
            if (name.Length > 0)
            {
                names ??= [];
                if (!names.Contains(name, StringComparer.Ordinal))
                {
                    names.Add(name);
                }
            }

            i = close;
        }

        return (IReadOnlyList<string>?)names ?? [];
    }

    /// <summary>
    /// The bare name inside a route token: the catch-all <c>*</c>/<c>**</c> prefix and the optional
    /// <c>?</c> and <c>:constraint</c> suffixes are ASP.NET template syntax, not part of the name
    /// itself (<c>{id:int}</c>, <c>{id?}</c>, <c>{*rest}</c>, <c>{**rest}</c> → <c>id</c>, <c>id</c>,
    /// <c>rest</c>, <c>rest</c>).
    /// </summary>
    public static string ParameterName(string token)
    {
        var name = token.TrimStart('*');
        var colon = name.IndexOf(':');
        if (colon >= 0)
        {
            name = name[..colon];
        }

        return name.TrimEnd('?');
    }

    /// <summary>
    /// Whether <paramref name="route"/>[<paramref name="index"/>] opens a <c>{{</c>/<c>}}</c> escape
    /// pair for <paramref name="brace"/> — the one piece of the walk both <see cref="Tokens"/> and
    /// <c>CqrsValidator.DescribeRouteProblem</c>'s KOI1208 well-formedness check need identically.
    /// </summary>
    internal static bool IsEscapedBrace(string route, int index, char brace) =>
        index + 1 < route.Length && route[index + 1] == brace;
}
