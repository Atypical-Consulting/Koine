using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.CodeFixes.Providers;

/// <summary>
/// The "Rename to '&lt;unique&gt;'" quick fix for the duplicate-declaration diagnostics: a duplicate type
/// (<see cref="DiagnosticCodes.DuplicateType"/>, KOI0102), a duplicate member
/// (<see cref="DiagnosticCodes.DuplicateMember"/>, KOI0103), and a duplicate enum member
/// (<see cref="DiagnosticCodes.DuplicateEnumMember"/>, KOI0104). It renames the offending declaration to a
/// fresh name (<c>Name2</c>, <c>Name3</c>, …) that does not collide with the existing names in the relevant
/// scope.
///
/// <para>Both the duplicate's name and the unique replacement are derived from the parsed
/// <see cref="CodeFixContext.Model"/> — never the message prose. The name TOKEN is then located by scanning
/// the <see cref="CodeFixContext.SourceText"/> within the diagnostic span: for a type/member the span is the
/// declaration itself and the name occurs once; for an enum member the validator's span is the WHOLE enum
/// (coarse), so the duplicate is the LAST occurrence of the name inside the span. When the token cannot be
/// confidently located, the provider offers nothing.</para>
/// </summary>
public sealed class RenameDuplicateCodeFixProvider : ICodeFixProvider
{
    public IReadOnlyCollection<string> FixableDiagnosticCodes { get; } =
    [
        DiagnosticCodes.DuplicateType,
        DiagnosticCodes.DuplicateMember,
        DiagnosticCodes.DuplicateEnumMember,
    ];

    public IReadOnlyList<CodeFix> GetFixes(CodeFixContext context)
    {
        if (context.Diagnostic is not { } diagnostic || context.Model is not { } model)
        {
            return [];
        }

        // Resolve the duplicate's name + the names it must not collide with, from the structured model.
        if (!TryResolveRename(model, diagnostic, out var name, out var existing, out var lastOccurrence))
        {
            return [];
        }

        // Locate the name token within the diagnostic span. For an enum member the whole-enum span holds the
        // name more than once, so take the LAST occurrence; otherwise the name occurs once in its own decl.
        var tokenSpan = LocateName(context.SourceText, diagnostic.Span, name, lastOccurrence);
        if (tokenSpan is not { } token)
        {
            return [];
        }

        var unique = UniqueName(name, existing);
        return
        [
            new CodeFix(
                $"Rename to '{unique}'",
                "quickfix",
                EquivalenceKey: null,
                [new CodeFixEdit(token, unique)]),
        ];
    }

    /// <summary>
    /// Resolves the duplicate's <paramref name="name"/>, the <paramref name="existing"/> names it must avoid,
    /// and whether the name TOKEN to rewrite is the LAST occurrence within the span (true only for the
    /// coarse-span enum-member case). Returns <c>false</c> when nothing matches the diagnostic.
    /// </summary>
    private static bool TryResolveRename(
        KoineModel model,
        Diagnostic diagnostic,
        out string name,
        out IReadOnlyCollection<string> existing,
        out bool lastOccurrence)
    {
        name = string.Empty;
        existing = [];
        lastOccurrence = false;

        switch (diagnostic.Code)
        {
            case DiagnosticCodes.DuplicateType:
                // KOI0102 is raised both for a duplicate type (span = the type decl) and for a service
                // whose name collides with a type/service (span = the service decl). Match by offset
                // against both. Uniqueness is checked against every type AND service name (they share one
                // namespace), so the replacement collides with neither.
                foreach (TypeDecl type in AllTypes(model))
                {
                    if (!type.Span.IsNone && type.Span.Offset == diagnostic.Span.Offset)
                    {
                        name = type.Name;
                        existing = DeclaredNames(model);
                        return true;
                    }
                }

                foreach (ServiceDecl svc in AllServices(model))
                {
                    if (!svc.Span.IsNone && svc.Span.Offset == diagnostic.Span.Offset)
                    {
                        name = svc.Name;
                        existing = DeclaredNames(model);
                        return true;
                    }
                }

                return false;

            case DiagnosticCodes.DuplicateMember:
                // The duplicate member's span starts at the member name; match by offset. Uniqueness is
                // checked against the enclosing type's member names.
                foreach (TypeDecl type in AllTypes(model))
                {
                    IReadOnlyList<Member> members = MembersOf(type);
                    foreach (Member member in members)
                    {
                        if (!member.Span.IsNone && member.Span.Offset == diagnostic.Span.Offset)
                        {
                            name = member.Name;
                            existing = members.Select(m => m.Name).ToHashSet(StringComparer.Ordinal);
                            return true;
                        }
                    }
                }

                return false;

            case DiagnosticCodes.DuplicateEnumMember:
                // The validator points the span at the WHOLE enum, so match the enum by offset, then find
                // the member name that occurs more than once. Uniqueness is checked against the enum's
                // member names; the token is the LAST occurrence inside the coarse span.
                foreach (EnumDecl en in AllTypes(model).OfType<EnumDecl>())
                {
                    if (en.Span.IsNone || en.Span.Offset != diagnostic.Span.Offset)
                    {
                        continue;
                    }

                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var memberName in en.MemberNames)
                    {
                        if (!seen.Add(memberName))
                        {
                            name = memberName;
                            existing = en.MemberNames.ToHashSet(StringComparer.Ordinal);
                            lastOccurrence = true;
                            return true;
                        }
                    }
                }

                return false;

            default:
                return false;
        }
    }

    /// <summary>
    /// The span of the <paramref name="name"/> token within <paramref name="span"/> of
    /// <paramref name="sourceText"/>: the FIRST whole-word occurrence in CODE normally, or the LAST when
    /// <paramref name="lastOccurrence"/> is set (the coarse enum-member span). String literals and
    /// comments inside the span are skipped, so a name that also appears in a member's associated-data
    /// string (<c>Beta("Alpha")</c>) or a leading annotation argument (<c>@deprecated("Money")</c>) never
    /// mis-targets the rename onto the literal. Returns <c>null</c> when no code occurrence is found.
    /// </summary>
    private static SourceSpan? LocateName(string sourceText, SourceSpan span, string name, bool lastOccurrence)
    {
        if (span.IsNone || name.Length == 0)
        {
            return null;
        }

        var start = span.Offset;
        var end = Math.Min(span.Offset + span.Length, sourceText.Length);
        if (start < 0 || start > sourceText.Length)
        {
            return null;
        }

        int found = -1;
        var i = start;
        while (i < end)
        {
            var c = sourceText[i];

            // Skip a string literal "..." (honoring \" escapes) so a name inside it is never matched.
            if (c == '"')
            {
                i++;
                while (i < end && sourceText[i] != '"')
                {
                    i += sourceText[i] == '\\' && i + 1 < end ? 2 : 1;
                }

                i++; // past the closing quote
                continue;
            }

            // Skip a line comment //… to end of line.
            if (c == '/' && i + 1 < end && sourceText[i + 1] == '/')
            {
                i += 2;
                while (i < end && sourceText[i] != '\n')
                {
                    i++;
                }

                continue;
            }

            // Skip a block comment /* … */.
            if (c == '/' && i + 1 < end && sourceText[i + 1] == '*')
            {
                i += 2;
                while (i + 1 < end && !(sourceText[i] == '*' && sourceText[i + 1] == '/'))
                {
                    i++;
                }

                i += 2; // past the closing */
                continue;
            }

            // A whole-word occurrence of `name` in code.
            if (c == name[0]
                && i + name.Length <= end
                && string.CompareOrdinal(sourceText, i, name, 0, name.Length) == 0
                && IsWholeWord(sourceText, i, name.Length))
            {
                found = i;
                if (!lastOccurrence)
                {
                    break;
                }

                i += name.Length;
                continue;
            }

            i++;
        }

        if (found < 0)
        {
            return null;
        }

        // 1-based line/column for the located token; offset/length drive the edit slice.
        var (line, column) = LineColumn(sourceText, found);
        var (endLine, endColumn) = LineColumn(sourceText, found + name.Length);
        return new SourceSpan(line, column, endLine, endColumn, found, name.Length, span.File);
    }

    /// <summary>True when the identifier at <paramref name="at"/> is not bordered by an identifier char.</summary>
    private static bool IsWholeWord(string text, int at, int length)
    {
        if (at > 0 && IsIdentChar(text[at - 1]))
        {
            return false;
        }

        var afterIndex = at + length;
        return afterIndex >= text.Length || !IsIdentChar(text[afterIndex]);
    }

    private static bool IsIdentChar(char c) => char.IsLetterOrDigit(c) || c == '_';

    /// <summary>The 1-based (line, column) of the 0-based <paramref name="offset"/> in <paramref name="text"/>.</summary>
    private static (int Line, int Column) LineColumn(string text, int offset)
    {
        var line = 1;
        var column = 1;
        for (var i = 0; i < offset && i < text.Length; i++)
        {
            if (text[i] == '\n')
            {
                line++;
                column = 1;
            }
            else
            {
                column++;
            }
        }

        return (line, column);
    }

    /// <summary>The first <c>name2</c>, <c>name3</c>, … not present in <paramref name="existing"/>.</summary>
    private static string UniqueName(string name, IReadOnlyCollection<string> existing)
    {
        var n = 2;
        string candidate;
        do
        {
            candidate = $"{name}{n}";
            n++;
        }
        while (existing.Contains(candidate));

        return candidate;
    }

    /// <summary>Every declared type across all contexts and aggregates.</summary>
    private static IEnumerable<TypeDecl> AllTypes(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                yield return type;
            }
        }
    }

    /// <summary>Every service declared across all contexts (services share the type namespace).</summary>
    private static IEnumerable<ServiceDecl> AllServices(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (ServiceDecl svc in ctx.Services)
            {
                yield return svc;
            }
        }
    }

    /// <summary>Every type and service name in the model — the namespace a renamed type/service must avoid.</summary>
    private static IReadOnlyCollection<string> DeclaredNames(KoineModel model) =>
        AllTypes(model).Select(t => t.Name)
            .Concat(AllServices(model).Select(s => s.Name))
            .ToHashSet(StringComparer.Ordinal);

    /// <summary>The field members of <paramref name="type"/>, or empty for a kind that carries none.</summary>
    private static IReadOnlyList<Member> MembersOf(TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => [],
    };
}
