using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// R12.3/R12.4 — read models and queries. Split out of
/// <see cref="SemanticValidator"/>; <see cref="ValidateReadModel"/> and
/// <see cref="ValidateQuery"/> are dispatched from the type-validation switch in
/// the same order as before, preserving diagnostic codes, messages, and emission
/// order. (Use cases, which co-emit with services, stay in the services pass.)
///
/// <para><see cref="ValidateApiAnnotations"/> (R19) is shared: queries reach it from
/// <see cref="ValidateQuery"/>, commands from <c>EntityBehaviorValidator.ValidateCommands</c>,
/// so both surfaces of the API annotations obey one set of rules. <see cref="ValidateApiRoutes"/> is
/// the one check that cannot be per-declaration — a route collision is a property of the whole
/// context — so <c>PerContextAnalyzer</c> drives it once per context.</para>
/// </summary>
internal static class CqrsValidator
{
    /// <summary>
    /// Validates a read model (R12.3): the source must be a declared value/entity;
    /// field names are unique; a direct field must name a source member; a derived
    /// field's projection must resolve over the source and produce a value assignable
    /// to its declared type.
    /// </summary>
    public static void ValidateReadModel(
        ReadModelDecl rm, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var sourceMembers = ReadModelSourceMembers(resolver.Context, rm.SourceType, index);
        if (sourceMembers is null)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelUnknownSource,
                $"read model '{rm.Name}' projects from '{rm.SourceType}', which is not a declared value or entity type",
                rm.Span));
            return;
        }

        // Build defensively (last-wins): a source value object with duplicate members
        // (reported elsewhere as KOI0103) must not crash this loop.
        var memberByName = new Dictionary<string, Member>(sourceMembers.Count, StringComparer.Ordinal);
        foreach (var m in sourceMembers)
        {
            memberByName[m.Name] = m;
        }

        // Materialized lazily: only the unknown-field suggestion path (uncommon) needs it.
        string[]? sourceMemberNames = null;
        var scope = TypeScope.FromMembers(sourceMembers, index);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);
        // The record property a field emits to (R12.3): a positional record property is
        // PascalCased, so two fields differing only by their first-letter case collide.
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var field in rm.Fields)
        {
            if (!seen.Add(SemanticValidator.PropertyKey(field.Name)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateReadModelField,
                    $"duplicate field '{field.Name}' in read model '{rm.Name}'", field.Span));
            }

            if (SemanticValidator.IsReservedRecordMember(field.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                    $"read-model field '{field.Name}' collides with a record-synthesized member", field.Span));
            }

            if (field.Projection is null)
            {
                // A direct field must name a member (or the synthetic `id`) of the source.
                if (!memberByName.ContainsKey(field.Name))
                {
                    sourceMemberNames ??= memberByName.Keys.ToArray();
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelUnknownField,
                        $"read model '{rm.Name}' field '{field.Name}' is not a member of '{rm.SourceType}'{Suggestions.For(field.Name, sourceMemberNames)}",
                        field.Span) with
                    { Suggestion = Suggestions.Best(field.Name, sourceMemberNames) });
                }
            }
            else
            {
                // A derived field: the projection resolves over the source; its declared
                // type must be known and accept the projected value.
                SemanticValidator.ValidateTypeRef(field.Type!, index, resolver, diagnostics);
                checker.Check(field.Projection, scope, field.Type);
                var inferred = resolver.Infer(field.Projection, scope);
                if (inferred is not null && index.IsKnownType(resolver.Context, field.Type!.Name)
                    && !MemberAnalysis.IsAssignable(inferred, field.Type!))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReadModelFieldTypeMismatch,
                        $"read model '{rm.Name}' field '{field.Name}' is declared '{field.Type!.Name}' but projects a '{inferred.Name}'",
                        field.Span));
                }
            }
        }
    }

    /// <summary>
    /// Validates a query (R12.4): criteria parameter types and names, and that the
    /// result is a declared read model or a <c>List</c> of one.
    /// </summary>
    public static void ValidateQuery(QueryDecl q, ModelIndex index, TypeResolver resolver, List<Diagnostic> diagnostics)
    {
        // Criteria become positional record properties (PascalCased), so dedup on the
        // emitted property key and reject names that collide with record members.
        var seenParams = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in q.Criteria)
        {
            SemanticValidator.ValidateTypeRef(p.Type, index, resolver, diagnostics);
            if (!seenParams.Add(SemanticValidator.PropertyKey(p.Name)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                    $"duplicate criterion '{p.Name}' in query '{q.Name}'", p.Span));
            }

            if (SemanticValidator.IsReservedRecordMember(p.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                    $"query criterion '{p.Name}' collides with a record-synthesized member", p.Span));
            }
        }

        SemanticValidator.ValidateTypeRef(q.ResultType, index, resolver, diagnostics);
        var resultName = q.ResultType.Name == ModelIndex.ListTypeName
            ? q.ResultType.Element?.Name
            : q.ResultType.Name;
        // Resolved against the query's own declaring context (#1711) so a same-named,
        // differently-kinded type declared elsewhere can't shadow it via the flat lookup.
        if (resultName is not null && index.Classify(resolver.Context, resultName) != TypeKind.ReadModel)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QueryResultNotReadModel,
                $"query '{q.Name}' must return a read model or 'List<readmodel>', not '{q.ResultType.Name}'",
                q.Span));
        }

        ValidateApiAnnotations(q.ApiAnnotations, q.RouteOverride, q.AuthRole, $"query '{q.Name}'", q.Span, diagnostics,
            q.Criteria, identityTypeName: null);
    }

    /// <summary>
    /// Validates the API annotations preceding a command or query (R19): <c>@route</c> must name a
    /// well-formed absolute path (see <see cref="DescribeRouteProblem"/>), each annotation may appear at
    /// most once, at most one verb annotation may precede a declaration (one declaration is one
    /// endpoint), a verb annotation takes no argument, and <c>@auth</c> must name a non-blank role. An
    /// argument-less <c>@route</c>/<c>@auth</c> is diagnosed too — it configures nothing, and the reader
    /// deliberately keeps its span so it fails loudly here instead of being silently dropped. Each
    /// diagnostic lands on its own annotation.
    /// </summary>
    /// <param name="subject">How the declaration reads in the message, e.g. <c>command 'place'</c>.</param>
    /// <param name="members">The declaration's own parameters (a command) or criteria (a query) — what a
    /// route token can name-match (#1748).</param>
    /// <param name="identityTypeName">The aggregate identity's type name when <paramref name="subject"/>
    /// is a command on an entity, so an <c>id</c> token with no matching parameter still resolves; <c>null</c>
    /// for a query, which has no identity fallback (#1748).</param>
    public static void ValidateApiAnnotations(
        ApiAnnotationInfo? api,
        string? route,
        string? authRole,
        string subject,
        SourceSpan declSpan,
        List<Diagnostic> diagnostics,
        IReadOnlyList<Param> members,
        string? identityTypeName)
    {
        if (api is null)
        {
            return;
        }

        if (!api.RouteSpan.IsNone)
        {
            if (route is null)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidRouteOverride,
                    $"'@route' on {subject} names no path; give it one, e.g. @route(\"/orders\")",
                    At(api.RouteSpan, declSpan)));
            }
            else if (DescribeRouteProblem(route) is { } problem)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.InvalidRouteOverride,
                    $"route override '{route}' on {subject} {problem}",
                    At(api.RouteSpan, declSpan)));
            }
            else
            {
                ValidateRouteTokenBindings(route, members, identityTypeName, subject, At(api.RouteSpan, declSpan), diagnostics);
            }
        }

        if (api.VerbCount > 1)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.MultipleVerbAnnotations,
                $"{subject} carries {api.VerbCount} HTTP verb annotations; a declaration is one endpoint, so at most one is allowed",
                At(api.VerbSpan, declSpan)));
        }

        // A verb annotation is a bare marker — an argument on it configures nothing, so it can only be a
        // mistake (`@get("/orders")` reads as a route that would never be applied).
        if (!api.VerbArgumentSpan.IsNone)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.VerbAnnotationArgument,
                $"the HTTP verb annotation on {subject} takes no argument; write it bare, e.g. @put — a path goes on '@route'",
                At(api.VerbArgumentSpan, declSpan)));
        }

        if (!api.AuthSpan.IsNone && string.IsNullOrWhiteSpace(authRole))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EmptyAuthRole,
                authRole is null
                    ? $"'@auth' on {subject} names no role; give it one, e.g. @auth(\"admin\")"
                    : $"'@auth' on {subject} names a blank role",
                At(api.AuthSpan, declSpan)));
        }

        // `@route`/`@auth` are single-valued: repeating one silently kept the last and dropped the rest.
        ReportDuplicate(api.RouteCount, "@route", api.RouteSpan);
        ReportDuplicate(api.AuthCount, "@auth", api.AuthSpan);

        // Only the command reader ever sets this: a command's leading annotation list accepts the R15.1
        // evolution annotations grammatically, but a command is not a type declaration and has nowhere
        // to keep them, so they are rejected rather than discarded (a query, being a TypeDecl, keeps them).
        if (!api.UnsupportedVersionSpan.IsNone)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.VersionAnnotationOnCommand,
                $"'@since'/'@deprecated' on {subject} has no effect; evolution annotations apply to type " +
                "declarations (value, entity, event, query, …), not to a command",
                At(api.UnsupportedVersionSpan, declSpan)));
        }

        void ReportDuplicate(int count, string annotation, SourceSpan span)
        {
            if (count > 1)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateApiAnnotation,
                    $"{subject} carries {count} '{annotation}' annotations; it may carry at most one",
                    At(span, declSpan)));
            }
        }
    }

    /// <summary>
    /// KOI1215 (warning): a <c>@route</c> <c>{token}</c> that names neither a parameter/criterion of the
    /// declaration nor (for a command) the aggregate identity binds to nothing (#1748). The resolution
    /// order mirrors <c>Koine.Emit.Common/RouteDerivation</c>'s — a member name-match
    /// (<see cref="StringComparison.OrdinalIgnoreCase"/>), else <c>id</c> → the identity, else unbound —
    /// but is reimplemented here rather than calling into <c>RouteDerivation</c> because <c>Semantics/</c>
    /// may not depend on an emitter assembly (the dependency runs the other way: emit → compiler). A
    /// <b>warning</b>, not an error: a purely decorative token was legal before #1734 gave <c>@route</c>
    /// any binding meaning at all, so turning it into a hard error would break existing models on upgrade.
    /// </summary>
    private static void ValidateRouteTokenBindings(
        string route, IReadOnlyList<Param> members, string? identityTypeName, string subject, SourceSpan span,
        List<Diagnostic> diagnostics)
    {
        foreach (var token in RouteTemplate.Tokens(route))
        {
            var boundToMember = members.Any(m => string.Equals(m.Name, token, StringComparison.OrdinalIgnoreCase));
            var boundToIdentity = !boundToMember && identityTypeName is not null
                && string.Equals(token, "id", StringComparison.OrdinalIgnoreCase);
            if (boundToMember || boundToIdentity)
            {
                continue;
            }

            diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.UnboundRouteToken,
                $"route override '{route}' on {subject} names a token '{{{token}}}' that binds to nothing; " +
                "name it after a parameter of the declaration, or 'id' for the aggregate identity",
                span));
        }
    }

    /// <summary>
    /// Context-level R19 check (#1219): no two commands/queries in one bounded context may resolve to the
    /// same HTTP <b>route AND verb</b>. Sharing a route is legal — that is what <c>@route</c> is for, and
    /// OpenAPI keys a path item by path then by verb — but sharing both is not: the <c>openapi</c> document
    /// would carry the same verb key twice under one path (a duplicate YAML mapping key, which makes the
    /// document unparseable), and the C# <c>api</c> layer would register two indistinguishable endpoints,
    /// which ASP.NET rejects with <c>AmbiguousMatchException</c> at request time. Reported as KOI1211 on the
    /// second (and each later) colliding declaration, so the first one — the one already "holding" the
    /// route — stays clean.
    ///
    /// <para>Scope: every entity's commands and factories (top-level and aggregate-nested) and every
    /// query, i.e. the superset the <c>openapi</c> emitter maps (#1747). The C# <c>api</c> layer maps a
    /// narrower set (a command needs its aggregate's repository to expose <c>getById</c>, a factory
    /// <c>add</c>, and only top-level queries), so a collision this reports is always real for at least
    /// one HTTP target.</para>
    ///
    /// <para>Routes are compared <b>ordinally</b> — exactly the criterion that makes an OpenAPI mapping key
    /// a duplicate. Two templates that differ only in letter case, or only in the <i>name</i> of a route
    /// parameter (<c>/orders/{id}</c> vs <c>/orders/{orderId}</c>), are distinct YAML keys and so are not
    /// reported here, even though ASP.NET would still consider them ambiguous.</para>
    /// </summary>
    public static void ValidateApiRoutes(ContextNode ctx, List<Diagnostic> diagnostics)
    {
        // First-wins: the value is how the declaration that claimed the (route, verb) pair reads in a message.
        var claimed = new Dictionary<(string Route, string Verb), string>();

        foreach (EntityDecl entity in ctx.AllEntities())
        {
            foreach (CommandDecl command in entity.Commands)
            {
                Claim(
                    command.RouteOverride ?? $"/{Kebab(entity.Name)}/{Kebab(command.Name)}",
                    command.VerbOverride ?? "POST",
                    $"command '{command.Name}' on '{entity.Name}'",
                    command.Span);
            }

            foreach (FactoryDecl factory in entity.Factories)
            {
                Claim(
                    $"/{Kebab(entity.Name)}/{Kebab(factory.Name)}",
                    "POST",
                    $"factory '{factory.Name}' on '{entity.Name}'",
                    factory.Span,
                    conventionalOnly: true);
            }
        }

        foreach (QueryDecl query in ctx.AllTypeDecls().OfType<QueryDecl>())
        {
            Claim(
                query.RouteOverride ?? $"/{Kebab(query.Name)}",
                query.VerbOverride ?? "GET",
                $"query '{query.Name}'",
                query.Span);
        }

        void Claim(string route, string verb, string subject, SourceSpan span, bool conventionalOnly = false)
        {
            if (claimed.TryGetValue((route, verb), out var first))
            {
                // A factory's route/verb has no annotation axis to move (#1747) — the generic "share a
                // route only when their verbs differ" advice is not actionable for it, so the reported
                // claimant gets a pointer to the only declaration that CAN move.
                var hint = conventionalOnly
                    ? "; a factory's route is conventional and cannot be annotated, so move the " +
                      "@route/verb on the other declaration"
                    : "";
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateApiRoute,
                    $"{subject} maps '{verb} {route}', which {first} already maps; two declarations may " +
                    "share a route only when their verbs differ" + hint,
                    span));
                return;
            }

            claimed[(route, verb)] = subject;
        }
    }

    /// <summary>
    /// The kebab-cased path segment the HTTP convention derives from an identifier
    /// (<c>OrdersByStatus → orders-by-status</c>) — the same rule <c>RouteDerivation.Kebab</c> applies
    /// emit-side. The convention itself has to be restated here because it lives in
    /// <c>Koine.Emit.Common</c>, which references this assembly: <c>Semantics/</c> runs before the
    /// emitters and must never depend on one. Only the two format strings are restated — the fiddly
    /// word-boundary rule is the shared <see cref="IdentifierWords.Split"/> (#1239), so the two cannot
    /// drift on the hard part, and <c>R19ApiAnnotationsTests</c> pins the whole derivation against
    /// <c>RouteDerivation</c> from the test project, which can see both.
    /// </summary>
    private static string Kebab(string name) =>
        string.Join('-', IdentifierWords.Split(name, splitAfterDigit: true)).ToLowerInvariant();

    /// <summary>
    /// The rule a route override breaks, phrased to complete "route override 'x' on <c>subject</c> …",
    /// or <c>null</c> when the path is well-formed. Beyond the leading <c>/</c>, this catches the
    /// malformed templates that would otherwise compile and then throw <c>RoutePatternException</c> when
    /// the host builds its route table — a startup crash the emitted C# cannot reveal, since a bad
    /// template is a perfectly valid string literal. Whitespace and control characters are rejected too:
    /// the routing stack tolerates them, but they cannot be typed into a URL as written, so they are
    /// always a mistake. <c>{{</c>/<c>}}</c> are the routing escape for literal braces and are skipped
    /// rather than treated as parameter delimiters.
    /// </summary>
    private static string? DescribeRouteProblem(string route)
    {
        if (!route.StartsWith('/'))
        {
            return "must be an absolute path starting with '/'";
        }

        for (var i = 0; i < route.Length; i++)
        {
            if (char.IsWhiteSpace(route[i]) || char.IsControl(route[i]))
            {
                return "must not contain whitespace or control characters";
            }
        }

        var depth = 0;
        var parameterLength = 0;
        for (var i = 0; i < route.Length; i++)
        {
            var c = route[i];

            // `{{` / `}}` escape a literal brace — consume both characters, delimiting nothing. The
            // escape check itself is the one piece of this walk RouteTemplate.Tokens (#1748) shares.
            if ((c == '{' || c == '}') && RouteTemplate.IsEscapedBrace(route, i, c))
            {
                parameterLength += 2;
                i++;
                continue;
            }

            switch (c)
            {
                case '{' when depth > 0:
                    return "nests '{' inside a route parameter; escape a literal brace as '{{'";
                case '{':
                    depth = 1;
                    parameterLength = 0;
                    break;
                case '}' when depth == 0:
                    return "closes a route parameter that was never opened; escape a literal brace as '}}'";
                case '}' when parameterLength == 0:
                    return "has an empty route parameter '{}'; name it, e.g. '{id}'";
                case '}':
                    depth = 0;
                    break;
                default:
                    parameterLength++;
                    break;
            }
        }

        return depth > 0
            ? "leaves a route parameter unclosed; every '{' needs a matching '}'"
            : null;
    }

    /// <summary>
    /// The annotation's own span when the reader placed it, the declaration's otherwise — a safety net,
    /// since every annotation the checks above can reach comes with a span today.
    /// </summary>
    private static SourceSpan At(SourceSpan annotation, SourceSpan declaration) =>
        annotation.IsNone ? declaration : annotation;

    /// <summary>
    /// The members a read model can project from its source (entities add the synthetic
    /// <c>id</c>); <c>null</c> when the source is not a value/entity type.
    /// </summary>
    private static IReadOnlyList<Member>? ReadModelSourceMembers(string? context, string sourceType, ModelIndex index)
    {
        // Resolve the source in the read model's own context first (R13.2), so a name
        // shared across contexts binds to the right declaration.
        TypeDecl? decl = null;
        if (context is not null && index.TryGetDeclIn(context, sourceType, out var local))
        {
            decl = local;
        }
        else if (index.TryGetDecl(sourceType, out var global))
        {
            decl = global;
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => EntityProjectionMembers(e),
            _ => null
        };
    }

    /// <summary>
    /// An entity's members plus the synthetic <c>id</c> — added only when the entity does
    /// not already declare its own <c>id</c> member (which would otherwise duplicate it).
    /// </summary>
    private static IReadOnlyList<Member> EntityProjectionMembers(EntityDecl e)
    {
        foreach (Member m in e.Members)
        {
            if (string.Equals(m.Name, "id", StringComparison.OrdinalIgnoreCase))
            {
                return e.Members;
            }
        }

        var withId = new List<Member>(e.Members.Count + 1);
        withId.AddRange(e.Members);
        withId.Add(new Member("id", new TypeRef(e.IdentityName), null));
        return withId;
    }
}
