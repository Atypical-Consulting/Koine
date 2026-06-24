using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.CodeFixes;

namespace Koine.Compiler.Services;

/// <summary>
/// Computes selection-driven refactors over a single document, mirroring how
/// <see cref="KoineLanguageService.DefinitionAt(KoineCompilation, string, int, int)"/> resolves navigation. Each refactor is returned
/// as an editor-agnostic <see cref="CodeFix"/> (title + kind + the text edits that apply it); the
/// host shell turns it into a CodeAction carrying an inline WorkspaceEdit. This is the engine behind
/// the selection-driven <c>ICodeFixProvider</c>s (see
/// <see cref="Koine.Compiler.CodeFixes.Providers.ExtractValueObjectCodeFixProvider"/>).
///
/// <para>v1 ships a single refactor — <b>extract value object</b> — but the entry point is shaped to
/// accumulate future refactors at a position: each computes its own edits and is offered only when the
/// selection actually lands on an applicable construct (the no-noise contract the rest of the language
/// services follow).</para>
/// </summary>
internal sealed class RefactorService
{
    private readonly string _source;
    private readonly KoineModel _model;

    private RefactorService(string source, KoineModel model)
    {
        _source = source;
        _model = model;
    }

    /// <summary>
    /// The refactors available for the selection <c>[startOffset, endOffset)</c> over
    /// <paramref name="source"/> (0-based absolute offsets), using an already-parsed
    /// <paramref name="model"/>. Returns an empty list when no refactor applies at the selection.
    /// </summary>
    public static IReadOnlyList<CodeFix> RefactorsFor(string source, KoineModel model, int startOffset, int endOffset)
    {
        var service = new RefactorService(source, model);
        var actions = new List<CodeFix>();
        if (service.TryExtractValueObject(startOffset, endOffset) is { } extract)
        {
            actions.Add(extract);
        }

        if (service.TryExtractEntity(startOffset, endOffset) is { } extractEntity)
        {
            actions.Add(extractEntity);
        }

        if (service.TryExtractAggregate(startOffset, endOffset) is { } extractAggregate)
        {
            actions.Add(extractAggregate);
        }

        return actions;
    }

    /// <summary>
    /// Builds the "Extract value object" refactor when the selection lands on one or more
    /// contiguous member fields of a value/entity/event type. The result is two edits in the active
    /// file: (1) a new sibling <c>value ExtractedValue { … }</c> inserted immediately before the
    /// enclosing type, carrying the selected fields verbatim, and (2) a replacement of those fields
    /// with a single <c>extracted: ExtractedValue</c> line. <c>ExtractedValue</c> / <c>extracted</c>
    /// are deliberate placeholder names the user renames afterward. Returns <c>null</c> when the
    /// selection does not land on extractable fields.
    /// </summary>
    private CodeFix? TryExtractValueObject(int startOffset, int endOffset)
    {
        foreach (TypeDecl type in EnumerateTypes(_model))
        {
            IReadOnlyList<Member>? members = MembersOf(type);
            if (members is null || members.Count == 0 || type.Span.IsNone)
            {
                continue;
            }

            // The selection must fall within this type's body.
            if (!ContainsSelection(type.Span, startOffset, endOffset))
            {
                continue;
            }

            List<Member> selected = SelectedContiguousMembers(members, startOffset, endOffset);
            if (selected.Count == 0)
            {
                continue;
            }

            // Finding 1 — derived/initialized fields would carry an RHS referencing fields left
            // behind in the origin type (dangling refs). v1 only extracts self-contained primitive
            // fields, so refuse the whole selection when any field has an initializer/value.
            if (selected.Any(m => m.Initializer is not null))
            {
                return null;
            }

            return BuildExtract(type, selected);
        }

        return null;
    }

    /// <summary>
    /// The members hit by the selection, validated to be contiguous in declaration order. A
    /// zero-width selection (a bare cursor) selects the single member whose span contains it.
    /// Returns an empty list when nothing is hit or the hit members are not contiguous.
    /// </summary>
    private static List<Member> SelectedContiguousMembers(IReadOnlyList<Member> members, int startOffset, int endOffset)
    {
        var hit = new List<Member>();
        var indices = new List<int>();
        for (var i = 0; i < members.Count; i++)
        {
            SourceSpan span = members[i].Span;
            if (span.IsNone || span.Length <= 0)
            {
                continue;
            }

            var memberStart = span.Offset;
            var memberEnd = span.Offset + span.Length;

            // Overlap test for a range selection; containment for a bare cursor (start == end).
            var overlaps = startOffset == endOffset
                ? startOffset >= memberStart && startOffset < memberEnd
                : startOffset < memberEnd && endOffset > memberStart;
            if (overlaps)
            {
                hit.Add(members[i]);
                indices.Add(i);
            }
        }

        // Reject a non-contiguous hit (e.g. the selection straddles a gap): v1 extracts a single run.
        for (var i = 1; i < indices.Count; i++)
        {
            if (indices[i] != indices[i - 1] + 1)
            {
                return [];
            }
        }

        return hit;
    }

    private CodeFix BuildExtract(TypeDecl type, IReadOnlyList<Member> selected)
    {
        // Indentation of the enclosing type declaration (its 1-based start column minus one).
        var typeIndent = new string(' ', Math.Max(0, type.Span.Column - 1));
        var fieldIndent = typeIndent + "  ";

        // Finding 4 — disambiguate the placeholder names against what already exists, so the
        // refactor never silently shadows an existing type or member by reusing a taken name.
        var voName = UniqueName("ExtractedValue", ExistingTypeNames());
        var fieldName = UniqueName("extracted", MemberNamesOf(type));

        // Finding 2 — build the moved body from the VERBATIM combined source slice, spanning from
        // the start of the FIRST selected field's leading comment/doc trivia to the END of the last
        // selected field. This carries per-field doc comments AND any comment sitting between
        // selected fields into the new value object (Member.Span alone excludes the leading `///`).
        var moveStart = LeadingContentStart(selected[0]);
        // A same-line trailing comment of the last selected field is parsed as the NEXT member's
        // leading trivia, so Member.Span excludes it. Absorb it so it travels with the field into the
        // new value object instead of being orphaned onto the placeholder.
        var moveEnd = ExtendOverTrailingComment(selected[^1].Span.Offset + selected[^1].Span.Length);
        var movedSlice = SliceRange(moveStart, moveEnd);

        // (1) The extracted value object. The moved slice is re-indented from the origin field
        // indentation to this VO's body indentation so the layout reads correctly at its new home.
        var sb = new StringBuilder();
        sb.Append("value ").Append(voName).Append(" {\n");
        sb.Append(Reindent(movedSlice, selected[0].Span.Column - 1, fieldIndent)).Append('\n');
        sb.Append(typeIndent).Append("}\n\n").Append(typeIndent);

        // Finding 3 — insert BEFORE the enclosing type's leading-trivia/doc block (not at the type
        // keyword, which sits AFTER the type's own `///` doc), so the original type keeps its doc.
        var insertOffset = LeadingTriviaStart(type);
        var (insertLine, insertCol) = LineColumnOf(insertOffset);
        SourceSpan insertAt = PointSpan(insertLine, insertCol, insertOffset);
        var insert = new CodeFixEdit(insertAt, sb.ToString());

        // (2) Replace the SAME combined range (leading trivia included) with one placeholder field,
        // so nothing in the moved range is left behind or duplicated.
        SourceSpan combined = RangeSpan(moveStart, moveEnd);
        var replace = new CodeFixEdit(combined, $"{fieldName}: {voName}");

        return new CodeFix(
            $"Extract value object (rename '{voName}' / '{fieldName}' afterwards)",
            "refactor.extract",
            // A one-off, position-specific refactor: not part of a fix-all batch.
            EquivalenceKey: null,
            [insert, replace]);
    }

    /// <summary>
    /// Builds the "Extract entity" refactor when the selection lands on one or more contiguous member
    /// fields of a value/entity/event type. The sibling to <see cref="TryExtractValueObject"/>: instead
    /// of a <c>value</c>, it emits a new <c>entity ExtractedEntity identified by ExtractedEntityId { … }</c>
    /// inserted immediately before the enclosing type, carrying the selected fields verbatim, and
    /// replaces those fields with a single <c>extracted: ExtractedEntity</c> line. <c>ExtractedEntity</c>
    /// / <c>ExtractedEntityId</c> / <c>extracted</c> are deliberate placeholder names the user renames
    /// afterward. Returns <c>null</c> when the selection does not land on extractable fields.
    /// </summary>
    private CodeFix? TryExtractEntity(int startOffset, int endOffset)
    {
        foreach (TypeDecl type in EnumerateTypes(_model))
        {
            IReadOnlyList<Member>? members = MembersOf(type);
            if (members is null || members.Count == 0 || type.Span.IsNone)
            {
                continue;
            }

            // The selection must fall within this type's body.
            if (!ContainsSelection(type.Span, startOffset, endOffset))
            {
                continue;
            }

            List<Member> selected = SelectedContiguousMembers(members, startOffset, endOffset);
            if (selected.Count == 0)
            {
                continue;
            }

            // Same guard as extract-VO: a derived/initialized field would carry an RHS referencing
            // fields left behind in the origin type (dangling refs), so refuse the whole selection.
            if (selected.Any(m => m.Initializer is not null))
            {
                return null;
            }

            return BuildExtractEntity(type, selected);
        }

        return null;
    }

    private CodeFix BuildExtractEntity(TypeDecl type, IReadOnlyList<Member> selected)
    {
        // Indentation of the enclosing type declaration (its 1-based start column minus one).
        var typeIndent = new string(' ', Math.Max(0, type.Span.Column - 1));
        var fieldIndent = typeIndent + "  ";

        // Disambiguate the placeholder names against what already exists, so the refactor never
        // silently shadows an existing type or member by reusing a taken name. The identity type name
        // is derived from the (already-disambiguated) entity name, then itself disambiguated.
        ISet<string> existingTypes = ExistingTypeNames();
        var entityName = UniqueName("ExtractedEntity", existingTypes);
        var idName = UniqueName(entityName + "Id", existingTypes);
        var fieldName = UniqueName("extracted", MemberNamesOf(type));

        // Build the moved body from the VERBATIM combined source slice, spanning from the start of the
        // FIRST selected field's leading comment/doc trivia to the END of the last selected field (plus
        // any same-line trailing comment), so per-field docs and inter-field comments travel along.
        var moveStart = LeadingContentStart(selected[0]);
        var moveEnd = ExtendOverTrailingComment(selected[^1].Span.Offset + selected[^1].Span.Length);
        var movedSlice = SliceRange(moveStart, moveEnd);

        // (1) The extracted entity. The moved slice is re-indented from the origin field indentation to
        // this entity's body indentation so the layout reads correctly at its new home.
        var sb = new StringBuilder();
        sb.Append("entity ").Append(entityName).Append(" identified by ").Append(idName).Append(" {\n");
        sb.Append(Reindent(movedSlice, selected[0].Span.Column - 1, fieldIndent)).Append('\n');
        sb.Append(typeIndent).Append("}\n\n").Append(typeIndent);

        // Insert BEFORE the enclosing type's leading-trivia/doc block (not at the type keyword, which
        // sits AFTER the type's own `///` doc), so the original type keeps its doc.
        var insertOffset = LeadingTriviaStart(type);
        var (insertLine, insertCol) = LineColumnOf(insertOffset);
        SourceSpan insertAt = PointSpan(insertLine, insertCol, insertOffset);
        var insert = new CodeFixEdit(insertAt, sb.ToString());

        // (2) Replace the SAME combined range (leading trivia included) with one placeholder field,
        // so nothing in the moved range is left behind or duplicated.
        SourceSpan combined = RangeSpan(moveStart, moveEnd);
        var replace = new CodeFixEdit(combined, $"{fieldName}: {entityName}");

        return new CodeFix(
            $"Extract entity (rename '{entityName}' / '{fieldName}' afterwards)",
            "refactor.extract",
            // A one-off, position-specific refactor: not part of a fix-all batch.
            EquivalenceKey: null,
            [insert, replace]);
    }

    /// <summary>
    /// Builds the "Extract aggregate" refactor when the selection covers one or more contiguous
    /// <b>whole top-level type declarations</b> (not member fields), the first of which is an
    /// <see cref="EntityDecl"/> usable as the aggregate root. Unlike <see cref="TryExtractValueObject"/>
    /// / <see cref="TryExtractEntity"/> (which lift a run of member fields out of a type body), this
    /// wraps the selected sibling type(s) in a new
    /// <c>aggregate ExtractedAggregate root &lt;rootEntity&gt; { … }</c> inserted in place, re-indenting
    /// the wrapped types one level deeper. <c>ExtractedAggregate</c> is a deliberate placeholder name
    /// the user renames afterward. Returns <c>null</c> when the selection does not land on a whole
    /// top-level entity (e.g. on member fields, on a non-entity, or on a type already nested in an
    /// aggregate).
    /// </summary>
    private CodeFix? TryExtractAggregate(int startOffset, int endOffset)
    {
        foreach (ContextNode ctx in _model.Contexts)
        {
            // Only context top-level types are root candidates: a type already nested in an aggregate
            // is in that aggregate's `.Types`, never in `ctx.Types`, so it is never offered here.
            IReadOnlyList<TypeDecl> topLevel = ctx.Types;
            List<TypeDecl> selected = SelectedContiguousTypes(topLevel, startOffset, endOffset);
            if (selected.Count == 0)
            {
                continue;
            }

            // The first selected type must be a valid aggregate root (an entity); aggregate name must
            // differ from the root name, which `UniqueName` guarantees against the existing type set.
            if (selected[0] is not EntityDecl root)
            {
                continue;
            }

            return BuildExtractAggregate(selected, root.Name);
        }

        return null;
    }

    /// <summary>
    /// The whole top-level type declarations fully covered by the selection, validated to be
    /// contiguous in declaration order. A type counts as covered when the selection contains its
    /// entire span (from its leading-trivia/doc block through the end of its body); a narrow
    /// field-level selection inside a type body therefore covers nothing. Returns an empty list when
    /// nothing is fully covered or the covered types are not contiguous.
    /// </summary>
    private List<TypeDecl> SelectedContiguousTypes(IReadOnlyList<TypeDecl> types, int startOffset, int endOffset)
    {
        var hit = new List<TypeDecl>();
        var indices = new List<int>();
        for (var i = 0; i < types.Count; i++)
        {
            TypeDecl type = types[i];
            if (type.Span.IsNone || type.Span.Length <= 0)
            {
                continue;
            }

            var typeStart = LeadingTriviaStart(type);
            var typeEnd = type.Span.Offset + type.Span.Length;

            // Whole-declaration containment: the selection must span the entire type (trivia included).
            if (startOffset <= typeStart && endOffset >= typeEnd)
            {
                hit.Add(type);
                indices.Add(i);
            }
        }

        // Reject a non-contiguous hit (a selection straddling a gap): wrap a single contiguous run.
        for (var i = 1; i < indices.Count; i++)
        {
            if (indices[i] != indices[i - 1] + 1)
            {
                return [];
            }
        }

        return hit;
    }

    private CodeFix BuildExtractAggregate(IReadOnlyList<TypeDecl> selected, string rootName)
    {
        // Indentation of the first selected type's declaration (its 1-based start column minus one);
        // the wrapped types sit one level (two spaces) deeper inside the new aggregate body.
        var typeIndent = new string(' ', Math.Max(0, selected[0].Span.Column - 1));
        var innerIndent = typeIndent + "  ";

        // Disambiguate the placeholder aggregate name against every existing type, so the new name
        // never collides with an existing type and never equals the root name.
        var aggName = UniqueName("ExtractedAggregate", ExistingTypeNames());

        // The verbatim slice spanning the whole selected run: from the start of the FIRST type's
        // leading-trivia/doc block through the end of the LAST type's body (plus any same-line trailing
        // comment), so per-type docs and inter-type comments travel into the aggregate body intact.
        var moveStart = LeadingTriviaStart(selected[0]);
        var moveEnd = ExtendOverTrailingComment(selected[^1].Span.Offset + selected[^1].Span.Length);
        var movedSlice = SliceRange(moveStart, moveEnd);

        // The wrapped types are re-indented from their origin top-level indentation to the aggregate's
        // inner body indentation so the layout reads correctly one level deeper.
        var sb = new StringBuilder();
        sb.Append("aggregate ").Append(aggName).Append(" root ").Append(rootName).Append(" {\n");
        sb.Append(Reindent(movedSlice, selected[0].Span.Column - 1, innerIndent)).Append('\n');
        sb.Append(typeIndent).Append('}');

        // Replace the whole moved range with the aggregate that wraps it, so nothing is duplicated.
        SourceSpan combined = RangeSpan(moveStart, moveEnd);
        var replace = new CodeFixEdit(combined, sb.ToString());

        return new CodeFix(
            $"Extract aggregate (rename '{aggName}' afterwards)",
            "refactor.extract",
            // A one-off, position-specific refactor: not part of a fix-all batch.
            EquivalenceKey: null,
            [replace]);
    }

    /// <summary>
    /// The absolute offset where this member's leading content begins: the start of its first
    /// leading comment/doc trivia piece when present (so the moved block carries the field's doc),
    /// otherwise the member's own span offset (no leading comment to preserve).
    /// </summary>
    private static int LeadingContentStart(Member member)
    {
        foreach (SyntaxTrivia t in member.LeadingTrivia)
        {
            if (t.Kind is SyntaxTriviaKind.Doc or SyntaxTriviaKind.LineComment or SyntaxTriviaKind.BlockComment
                && !t.Span.IsNone)
            {
                return t.Span.Offset;
            }
        }

        return member.Span.Offset;
    }

    /// <summary>
    /// The absolute offset where the type's leading-trivia/doc block begins: the start of its first
    /// comment/doc trivia piece (so an insertion lands BEFORE the type's `///` doc), otherwise the
    /// type's own span offset.
    /// </summary>
    private static int LeadingTriviaStart(TypeDecl type)
    {
        foreach (SyntaxTrivia t in type.LeadingTrivia)
        {
            if (t.Kind is SyntaxTriviaKind.Doc or SyntaxTriviaKind.LineComment or SyntaxTriviaKind.BlockComment
                && !t.Span.IsNone)
            {
                return t.Span.Offset;
            }
        }

        return type.Span.Offset;
    }

    /// <summary>
    /// Re-indents a verbatim source slice so each line sits at <paramref name="newIndent"/>. The
    /// first line carries no original indentation (the slice starts at field/comment content), so it
    /// is simply prefixed; subsequent lines have up to <paramref name="oldIndentWidth"/> leading
    /// spaces stripped before the new indent is applied — preserving deeper relative indentation.
    /// </summary>
    private static string Reindent(string slice, int oldIndentWidth, string newIndent)
    {
        var lines = slice.Replace("\r\n", "\n").Split('\n');
        var sb = new StringBuilder();
        for (var i = 0; i < lines.Length; i++)
        {
            if (i > 0)
            {
                sb.Append('\n');
            }

            var line = lines[i];
            if (i > 0)
            {
                var strip = 0;
                while (strip < oldIndentWidth && strip < line.Length && line[strip] == ' ')
                {
                    strip++;
                }

                line = line[strip..];
            }

            // Keep a blank line blank (don't emit trailing indentation whitespace).
            sb.Append(line.Length == 0 ? string.Empty : newIndent + line);
        }

        return sb.ToString();
    }

    /// <summary>Every type name declared anywhere in the model (used to disambiguate the new VO name).</summary>
    private HashSet<string> ExistingTypeNames()
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (TypeDecl t in EnumerateTypes(_model))
        {
            names.Add(t.Name);
        }

        return names;
    }

    /// <summary>The member names of <paramref name="type"/> (used to disambiguate the placeholder field name).</summary>
    private static HashSet<string> MemberNamesOf(TypeDecl type)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        if (MembersOf(type) is { } members)
        {
            foreach (Member m in members)
            {
                names.Add(m.Name);
            }
        }

        return names;
    }

    /// <summary><paramref name="baseName"/>, or <c>baseName2</c>, <c>baseName3</c>, … — the first not in <paramref name="taken"/>.</summary>
    private static string UniqueName(string baseName, ISet<string> taken)
    {
        if (!taken.Contains(baseName))
        {
            return baseName;
        }

        for (var n = 2; ; n++)
        {
            var candidate = baseName + n;
            if (!taken.Contains(candidate))
            {
                return candidate;
            }
        }
    }

    /// <summary>Every type declaration in the model, descending into aggregate boundaries.</summary>
    private static IEnumerable<TypeDecl> EnumerateTypes(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl t in ctx.Types)
            {
                foreach (TypeDecl yielded in Flatten(t))
                {
                    yield return yielded;
                }
            }
        }
    }

    private static IEnumerable<TypeDecl> Flatten(TypeDecl type)
    {
        yield return type;
        if (type is AggregateDecl agg)
        {
            foreach (TypeDecl nested in agg.Types)
            {
                foreach (TypeDecl yielded in Flatten(nested))
                {
                    yield return yielded;
                }
            }
        }
    }

    /// <summary>The fielded members of a type whose fields are extractable, or <c>null</c>.</summary>
    private static IReadOnlyList<Member>? MembersOf(TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => null,
    };

    private static bool ContainsSelection(SourceSpan span, int startOffset, int endOffset)
    {
        var spanStart = span.Offset;
        var spanEnd = span.Offset + span.Length;
        return startOffset >= spanStart && endOffset <= spanEnd;
    }

    /// <summary>
    /// Extends <paramref name="end"/> over a comment that trails the last selected field on the SAME
    /// line (only inline whitespace between the field and the comment), so it is carried into the
    /// moved slice rather than left behind. A <c>//</c> comment extends to end of line; a <c>/* */</c>
    /// comment to its close. A comment on the NEXT line is not absorbed (it leads the following field).
    /// </summary>
    private int ExtendOverTrailingComment(int end)
    {
        var i = end;
        while (i < _source.Length && (_source[i] == ' ' || _source[i] == '\t'))
        {
            i++;
        }

        if (i + 1 < _source.Length && _source[i] == '/' && _source[i + 1] == '/')
        {
            i += 2;
            while (i < _source.Length && _source[i] != '\n' && _source[i] != '\r')
            {
                i++;
            }

            return i;
        }

        if (i + 1 < _source.Length && _source[i] == '/' && _source[i + 1] == '*')
        {
            var close = _source.IndexOf("*/", i + 2, StringComparison.Ordinal);
            if (close >= 0)
            {
                return close + 2;
            }
        }

        return end;
    }

    /// <summary>The verbatim source text in the absolute offset range <c>[start, end)</c>.</summary>
    private string SliceRange(int start, int end) =>
        start < 0 || end > _source.Length || end <= start
            ? string.Empty
            : _source[start..end];

    private static SourceSpan PointSpan(int line, int column, int offset) =>
        new(line, column, line, column, offset, 0);

    /// <summary>
    /// A span covering the absolute offset range <c>[start, end)</c>, with real 1-based
    /// line/column endpoints (end-exclusive) so the LSP shell maps it to a correct editor range.
    /// </summary>
    private SourceSpan RangeSpan(int start, int end)
    {
        var (line, col) = LineColumnOf(start);
        var (endLine, endCol) = LineColumnOf(end);
        return new SourceSpan(line, col, endLine, endCol, start, end - start);
    }

    /// <summary>The 1-based (line, column) of the absolute character <paramref name="offset"/> in the source.</summary>
    private (int Line, int Column) LineColumnOf(int offset)
    {
        var line = 1;
        var col = 1;
        var max = Math.Min(offset, _source.Length);
        for (var i = 0; i < max; i++)
        {
            if (_source[i] == '\n')
            {
                line++;
                col = 1;
            }
            else
            {
                col++;
            }
        }

        return (line, col);
    }
}
