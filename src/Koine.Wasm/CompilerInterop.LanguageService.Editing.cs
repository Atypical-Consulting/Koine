using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Grammar;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Wasm;

// Source-changing surface of the in-browser language service: prepare-rename / rename,
// code actions (diagnostic quickfixes + selection refactors), and document/range formatting.
// See CompilerInterop.LanguageService.cs.
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
    /// <summary>
    /// The editable identifier range under the cursor (LSP <c>prepareRename</c>): <c>{ range, placeholder }</c>
    /// or the JSON literal <c>null</c> when a rename is not valid there. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string PrepareRename(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var range = LanguageService.PrepareRenameAt(comp, activeUri, line, character);
            if (range is null)
            {
                return "null";
            }

            var name = LanguageService.NameAt(comp, activeUri, line, character);
            return JsonSerializer.Serialize(new WPrepareRename(RangeOf(range), name), LangJson.Default.WPrepareRename);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>
    /// Workspace edit that renames the name under the cursor to <paramref name="newName"/> across the
    /// merged workspace: <c>{ changes: { uri: TextEdit[] }, idCoRename, leftBehindIdName }</c>, or the
    /// JSON literal <c>null</c> when no rename applies (cursor not on a renameable name, invalid
    /// identifier, or unchanged). When the renamed symbol is an aggregate root entity with a
    /// convention-linked <c>&lt;Root&gt;Id</c> identity, the edit also co-renames that identity type to
    /// <c>&lt;newName&gt;Id</c> (#550) — <c>idCoRename</c>/<c>leftBehindIdName</c> report that co-rename's
    /// authoritative outcome (<see cref="Koine.Compiler.Services.IdCoRenameOutcome"/>) so Koine Studio's
    /// status note doesn't have to re-derive it from rendered text (#565 follow-up).
    /// </summary>
    [JSExport]
    public static string Rename(string filesJson, string activeUri, int line, int character, string newName)
    {
        try
        {
            var result = LanguageService.RenameEditsAt(GetWarmCompilation(DeserializeFiles(filesJson)), activeUri, line, character, newName);
            if (result is null)
            {
                return "null";
            }

            // Each occurrence carries its OWN newText: the root takes newName, while a co-renamed
            // aggregate-root identity type takes <newName>Id (#550).
            var changes = result.Edits
                .GroupBy(e => e.Occurrence.Uri, StringComparer.Ordinal)
                .ToDictionary(
                    g => g.Key,
                    g => g.Select(e => new WTextEdit(RangeOf(e.Occurrence), e.NewText)).ToArray(),
                    StringComparer.Ordinal);
            var edit = new WWorkspaceEdit(changes, result.IdCoRename?.ToString(), result.LeftBehindIdName);
            return JsonSerializer.Serialize(edit, LangJson.Default.WWorkspaceEdit);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>
    /// Code actions for the request: diagnostic-driven "did you mean 'X'?" quickfixes (extracted from
    /// the <paramref name="diagnosticsJson"/> the client holds for the active file) plus selection-driven
    /// refactors over the 0-based range (e.g. Extract value object). Each action carries an inline
    /// workspace edit. Returns a JSON <c>CodeAction[]</c>. Parity with the stdio LSP's <c>textDocument/codeAction</c>.
    /// </summary>
    [JSExport]
    public static string CodeActions(
        string filesJson, string activeUri, int startLine, int startChar, int endLine, int endChar, string diagnosticsJson)
    {
        try
        {
            // Warm path (issue #464): reuse the reconciled snapshot for selection-driven refactors —
            // no re-parse. The quickfix path reads client-supplied diagnostics, never the compilation.
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var actions = new List<WCodeAction>();

            // 1. Diagnostic quickfixes: a "… — did you mean 'X'?" message yields a one-edit fix.
            //    Guard each item (a message-less diagnostic deserializes to a null Message); mirror
            //    the stdio LSP's per-item skip so one malformed diagnostic can't abort the whole
            //    handler and suppress the selection-driven refactors below.
            foreach (var d in TryDeserializeInDiagnostics(diagnosticsJson))
            {
                if (string.IsNullOrEmpty(d.Message))
                {
                    continue;
                }

                var suggestion = ExtractSuggestion(d.Message);
                if (suggestion is null)
                {
                    continue;
                }

                var changes = new Dictionary<string, WTextEdit[]>(StringComparer.Ordinal)
                {
                    [activeUri] = [new WTextEdit(d.Range, suggestion)],
                };
                actions.Add(new WCodeAction($"Change to '{suggestion}'", "quickfix", new WWorkspaceEdit(changes)));
            }

            // 2. Selection-driven refactors (Extract value object, …).
            foreach (var refactor in LanguageService.RefactorsAt(comp, activeUri, startLine, startChar, endLine, endChar))
            {
                var edits = refactor.Edits.Select(e => new WTextEdit(SpanRange(e.Range), e.NewText)).ToArray();
                var changes = new Dictionary<string, WTextEdit[]>(StringComparer.Ordinal) { [activeUri] = edits };
                actions.Add(new WCodeAction(refactor.Title, refactor.Kind, new WWorkspaceEdit(changes)));
            }

            return JsonSerializer.Serialize(actions.ToArray(), LangJson.Default.WCodeActionArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Canonical formatting edits for <paramref name="source"/>. Returns a single full-document
    /// <c>TextEdit</c> when formatting changes anything, or an empty array when it is already canonical.
    /// </summary>
    [JSExport]
    public static string Format(string source)
    {
        try
        {
            var result = new KoineFormatter().Format(source);
            if (!result.Changed)
            {
                return "[]";
            }

            var lines = SplitLines(source);
            var lastLine = lines.Length - 1;
            var lastChar = lines.Length == 0 ? 0 : lines[lastLine].Length;
            var edit = new WTextEdit(
                new WRange(new WPosition(0, 0), new WPosition(lastLine, lastChar)),
                result.Text);
            return JsonSerializer.Serialize(new[] { edit }, LangJson.Default.WTextEditArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Range-formatting edits (LSP <c>textDocument/rangeFormatting</c>) for the 0-based selection in
    /// <paramref name="source"/>: the whole document is formatted, the minimal changed line-region is
    /// taken and intersected with the selection, yielding a single clipped <c>TextEdit</c> — or an empty
    /// array when the selection contains nothing to reformat. Parity with the stdio LSP's
    /// <c>RangeFormattingResultJson</c> (both delegate to <see cref="KoineFormatter.FormatRange"/>).
    /// </summary>
    [JSExport]
    public static string FormatRange(string source, int startLine, int startChar, int endLine, int endChar)
    {
        try
        {
            var edit = new KoineFormatter().FormatRange(source, startLine, startChar, endLine, endChar);
            if (edit is null)
            {
                return "[]";
            }

            var wedit = new WTextEdit(
                new WRange(
                    new WPosition(edit.StartLine, edit.StartCharacter),
                    new WPosition(edit.EndLine, edit.EndCharacter)),
                edit.NewText);
            return JsonSerializer.Serialize(new[] { wedit }, LangJson.Default.WTextEditArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>Deserializes the client's active-file diagnostics (<c>[{range, message}]</c>); empty on any error.</summary>
    private static IReadOnlyList<WInDiagnostic> TryDeserializeInDiagnostics(string diagnosticsJson)
    {
        if (string.IsNullOrWhiteSpace(diagnosticsJson))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize(diagnosticsJson, LangJson.Default.WInDiagnosticArray) ?? [];
        }
        catch
        {
            return [];
        }
    }

    /// <summary>Extracts <c>X</c> from a Suggestions-style message ending in <c>… — did you mean 'X'?</c>.</summary>
    private static string? ExtractSuggestion(string message)
    {
        const string marker = "did you mean '";
        var i = message.IndexOf(marker, StringComparison.Ordinal);
        if (i < 0)
        {
            return null;
        }

        var start = i + marker.Length;
        var end = message.IndexOf('\'', start);
        return end > start ? message[start..end] : null;
    }

}
