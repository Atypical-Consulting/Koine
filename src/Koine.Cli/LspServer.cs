using System.Text;
using System.Text.Json;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;
using SourceSpan = Koine.Compiler.Ast.SourceSpan;

namespace Koine.Cli;

/// <summary>
/// A minimal Language Server for <c>.koi</c> files. It speaks LSP over stdio
/// (JSON-RPC with <c>Content-Length</c> framing) and pushes
/// <c>textDocument/publishDiagnostics</c> as documents are opened and edited, so
/// editors show Koine syntax and semantic errors inline.
///
/// <para>Implemented against the BCL only — no LSP SDK dependency. It handles the
/// minimal subset needed for diagnostics: initialize/shutdown, full-text document
/// sync, and diagnostics publishing.</para>
/// </summary>
internal sealed class LspServer
{
    private readonly KoineCompiler _compiler = new();
    private readonly KoineLanguageService _ls = new();
    private readonly SemanticTokenProvider _semanticTokens = new();
    private readonly Dictionary<string, string> _docs = new(StringComparer.Ordinal);

    // On-disk baseline of every *.koi in the workspace (uri -> text), scanned at initialize.
    private readonly Dictionary<string, string> _workspaceFiles = new(StringComparer.Ordinal);
    private readonly HashSet<string> _scannedRoots = new(StringComparer.Ordinal);
    private readonly Stream _in;
    private readonly Stream _out;

    public LspServer(Stream input, Stream output)
    {
        _in = input;
        _out = output;
    }

    public static int Run()
    {
        var stdin = Console.OpenStandardInput();
        var stdout = Console.OpenStandardOutput();

        // Protect the protocol: the stdout stream must carry ONLY framed LSP
        // messages, so route any stray Console.Write (from anywhere) to stderr.
        Console.SetOut(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });

        Log("server started (pid " + Environment.ProcessId + ")");
        try
        {
            return new LspServer(stdin, stdout).Loop();
        }
        catch (Exception ex)
        {
            Log("fatal: " + ex);
            return 1;
        }
        finally
        {
            Log("server exiting");
        }
    }

    /// <summary>
    /// Writes a diagnostic line to stderr (shown in the editor's LSP console) and,
    /// when <c>KOINE_LSP_LOG</c> is set, appends it to that file.
    /// </summary>
    private static void Log(string message)
    {
        var line = $"[koine-lsp] {message}";
        try
        { Console.Error.WriteLine(line); }
        catch { /* never fail on logging */ }

        var path = Environment.GetEnvironmentVariable("KOINE_LSP_LOG");
        if (!string.IsNullOrEmpty(path))
        {
            try
            { File.AppendAllText(path, line + Environment.NewLine); }
            catch { /* ignore */ }
        }
    }

    public int Loop()
    {
        while (true)
        {
            var message = ReadMessage();
            if (message is null)
            {
                return 0; // EOF
            }

            JsonDocument doc;
            try
            { doc = JsonDocument.Parse(message); }
            catch (JsonException) { continue; }

            using (doc)
            {
                var root = doc.RootElement;
                var method = root.TryGetProperty("method", out var m) ? m.GetString() : null;
                if (method is null)
                {
                    continue;
                }

                Log("<- " + method);
                try
                {
                    switch (method)
                    {
                        case "initialize":
                            if (root.TryGetProperty("params", out var initParams))
                            {
                                if (initParams.TryGetProperty("rootUri", out var ru) && ru.ValueKind == JsonValueKind.String)
                                {
                                    ScanWorkspace(ru.GetString()!);
                                }

                                if (initParams.TryGetProperty("workspaceFolders", out var folders)
                                    && folders.ValueKind == JsonValueKind.Array)
                                {
                                    foreach (var f in folders.EnumerateArray())
                                    {
                                        if (f.TryGetProperty("uri", out var fu) && fu.ValueKind == JsonValueKind.String)
                                        {
                                            ScanWorkspace(fu.GetString()!);
                                        }
                                    }
                                }
                            }
                            Respond(root, new Dictionary<string, object?>
                            {
                                ["capabilities"] = new Dictionary<string, object?>
                                {
                                    ["textDocumentSync"] = 1, // Full
                                    ["completionProvider"] = new Dictionary<string, object?>
                                    {
                                        ["resolveProvider"] = false,
                                        ["triggerCharacters"] = new[] { ":", "." },
                                    },
                                    ["hoverProvider"] = true,
                                    ["definitionProvider"] = true,
                                    ["documentFormattingProvider"] = true,
                                    ["documentSymbolProvider"] = true,
                                    ["referencesProvider"] = true,
                                    ["renameProvider"] = new Dictionary<string, object?>
                                    {
                                        ["prepareProvider"] = true,
                                    },
                                    ["codeActionProvider"] = new Dictionary<string, object?>
                                    {
                                        ["codeActionKinds"] = new[] { "quickfix", "refactor", "refactor.extract" },
                                    },
                                    ["semanticTokensProvider"] = new Dictionary<string, object?>
                                    {
                                        ["legend"] = new Dictionary<string, object?>
                                        {
                                            ["tokenTypes"] = SemanticTokenProvider.TokenTypeNames,
                                            ["tokenModifiers"] = SemanticTokenProvider.TokenModifierNames,
                                        },
                                        ["full"] = true,
                                    },
                                },
                                ["serverInfo"] = new Dictionary<string, object?>
                                {
                                    ["name"] = "koine",
                                    ["version"] = typeof(LspServer).Assembly.GetName().Version?.ToString() ?? "0.0.0",
                                },
                            });
                            break;

                        case "textDocument/didOpen":
                            if (TryGetTextDocument(root, out var openUri, out var openText))
                            {
                                _docs[openUri] = openText;
                                PublishWorkspaceDiagnostics();
                            }
                            break;

                        case "textDocument/didChange":
                            if (TryGetChange(root, out var changeUri, out var changeText))
                            {
                                _docs[changeUri] = changeText;
                                PublishWorkspaceDiagnostics();
                            }
                            break;

                        case "textDocument/didSave":
                            if (TryGetSave(root, out var saveUri, out var saveText) && saveText is not null)
                            {
                                _docs[saveUri] = saveText;
                                PublishWorkspaceDiagnostics();
                            }
                            break;

                        case "textDocument/didClose":
                            if (TryGetUri(root, out var closeUri))
                            {
                                _docs.Remove(closeUri);
                                PublishDiagnostics(closeUri, diagnostics: Array.Empty<object>()); // clear
                            }
                            break;

                        case "textDocument/completion":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, CompletionResult(root));
                            }

                            break;

                        case "textDocument/hover":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, HoverResultJson(root));
                            }

                            break;

                        case "textDocument/definition":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, DefinitionResultJson(root));
                            }

                            break;

                        case "textDocument/formatting":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, FormattingResultJson(root));
                            }

                            break;

                        case "textDocument/documentSymbol":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, DocumentSymbolResultJson(root));
                            }

                            break;

                        case "textDocument/references":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, ReferencesResultJson(root));
                            }

                            break;

                        case "textDocument/prepareRename":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, PrepareRenameResultJson(root));
                            }

                            break;

                        case "textDocument/rename":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, RenameResultJson(root));
                            }

                            break;

                        case "textDocument/codeAction":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, CodeActionResultJson(root));
                            }

                            break;

                        case "textDocument/semanticTokens/full":
                            if (root.TryGetProperty("id", out _))
                            {
                                Respond(root, SemanticTokensResultJson(root));
                            }

                            break;

                        case "shutdown":
                            Respond(root, result: (object?)null);
                            break;

                        case "exit":
                            return 0;

                        // Lifecycle/trace notifications we accept but don't act on. Listed
                        // explicitly so they're documented no-ops rather than "method not found"
                        // noise in the logs. (They carry no id, so no response is owed.)
                        case "initialized":
                        case "$/cancelRequest":
                        case "$/setTrace":
                            break;

                        default:
                            // Unknown request (has an id): reply method-not-found so the
                            // client doesn't block waiting. Unknown notifications: ignore.
                            if (root.TryGetProperty("id", out _))
                            {
                                RespondError(root, -32601, "method not found: " + method);
                            }

                            break;
                    }
                }
                catch (Exception ex)
                {
                    Log($"error handling '{method}': {ex}");
                }
            }
        }
    }

    // ---- IntelliSense -----------------------------------------------------

    private object? CompletionResult(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch)
            || !_docs.TryGetValue(uri, out var text))
        {
            return null;
        }

        var items = _ls.CompleteAt(text, line, ch)
            .Select(i => (object)new Dictionary<string, object?>
            {
                ["label"] = i.Label,
                ["kind"] = LspKind(i.Kind),
                ["detail"] = i.Detail,
                ["documentation"] = i.Documentation,
            })
            .ToArray();

        return new Dictionary<string, object?> { ["isIncomplete"] = false, ["items"] = items };
    }

    private object? HoverResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch))
        {
            return null;
        }

        var hover = _ls.HoverAt(Workspace(), uri, line, ch);
        if (hover is null)
        {
            return null;
        }

        return new Dictionary<string, object?>
        {
            ["contents"] = new Dictionary<string, object?>
            {
                ["kind"] = "markdown",
                ["value"] = hover.Markdown,
            },
        };
    }

    private object? DefinitionResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch))
        {
            return null;
        }

        var def = _ls.DefinitionAt(Workspace(), uri, line, ch);
        if (def is null)
        {
            return null;
        }

        // The target is the declaration's NameSpan: a real range over the identifier. Convert it
        // straight to an LSP range — no name-search heuristic, no zero-width fallback.
        return new Dictionary<string, object?>
        {
            // The target may live in a different file than the request (cross-file resolution).
            ["uri"] = def.Uri,
            ["range"] = SpanRange(def.Target),
        };
    }

    /// <summary>
    /// Converts a 1-based, end-EXCLUSIVE <see cref="SourceSpan"/> to a 0-based LSP range
    /// (<c>start.character = Column - 1</c>, <c>end.character = EndColumn - 1</c>).
    /// </summary>
    private static Dictionary<string, object?> SpanRange(SourceSpan span) => new()
    {
        ["start"] = new Dictionary<string, object?>
        {
            ["line"] = Math.Max(0, span.Line - 1),
            ["character"] = Math.Max(0, span.Column - 1),
        },
        ["end"] = new Dictionary<string, object?>
        {
            ["line"] = Math.Max(0, span.EndLine - 1),
            ["character"] = Math.Max(0, span.EndColumn - 1),
        },
    };

    // ---- Formatting -------------------------------------------------------

    private object? FormattingResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !_docs.TryGetValue(uri, out var text))
        {
            return null;
        }

        var formatted = new KoineFormatter().Format(text).Text;
        if (string.Equals(formatted, text, StringComparison.Ordinal))
        {
            return Array.Empty<object>(); // nothing to change
        }

        // One full-document edit: replace [start of doc .. end of doc) with the formatted text.
        var lines = SplitLines(text);
        var lastLine = lines.Length - 1;
        var lastChar = lines.Length == 0 ? 0 : lines[lastLine].Length;
        return new[]
        {
            (object)new Dictionary<string, object?>
            {
                ["range"] = new Dictionary<string, object?>
                {
                    ["start"] = new Dictionary<string, object?> { ["line"] = 0, ["character"] = 0 },
                    ["end"] = new Dictionary<string, object?> { ["line"] = lastLine, ["character"] = lastChar },
                },
                ["newText"] = formatted,
            },
        };
    }

    // ---- Document symbols -------------------------------------------------

    private object? DocumentSymbolResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !_docs.TryGetValue(uri, out var text))
        {
            return null;
        }

        return _ls.DocumentSymbols(text).Select(ToLspSymbol).ToArray();
    }

    private static object ToLspSymbol(DocumentSymbol s)
    {
        // range = the full declaration; selectionRange = just the identifier. The LSP spec
        // requires selectionRange to be contained within range, which holds (NameSpan ⊆ Span).
        // A declaration with no name span (selectionRange == None) falls back to the full range.
        var selection = s.SelectionRange.IsNone ? s.Range : s.SelectionRange;
        return new Dictionary<string, object?>
        {
            ["name"] = s.Name,
            ["kind"] = LspSymbolKind(s.Kind),
            ["range"] = SpanRange(s.Range),
            ["selectionRange"] = SpanRange(selection),
            ["children"] = s.Children.Select(ToLspSymbol).ToArray(),
        };
    }

    /// <summary>Maps a service <see cref="SymbolKind"/> to its LSP SymbolKind number.</summary>
    private static int LspSymbolKind(SymbolKind kind) => kind switch
    {
        SymbolKind.Namespace => 3,
        SymbolKind.Class => 5,
        SymbolKind.Enum => 10,
        SymbolKind.EnumMember => 22,
        SymbolKind.Field => 8,
        SymbolKind.Method => 6,
        SymbolKind.Constructor => 9,
        SymbolKind.Interface => 11,
        SymbolKind.Struct => 23,
        _ => 13, // Variable
    };

    // ---- References & rename ----------------------------------------------

    private object? ReferencesResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch))
        {
            return null;
        }

        var refs = _ls.ReferencesAt(Workspace(), uri, line, ch);
        return refs.Select(ToLocation).ToArray();
    }

    private object? PrepareRenameResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch))
        {
            return null;
        }

        var range = _ls.PrepareRenameAt(Workspace(), uri, line, ch);
        if (range is null)
        {
            return null;
        }

        // The placeholder is the current identifier text the editor pre-fills the rename box with.
        var name = _ls.NameAt(Workspace(), uri, line, ch);
        return new Dictionary<string, object?>
        {
            ["range"] = RangeOf(range),
            ["placeholder"] = name,
        };
    }

    private object? RenameResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch)
            || !root.TryGetProperty("params", out var p)
            || !p.TryGetProperty("newName", out var nn) || nn.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var newName = nn.GetString()!;
        var edits = _ls.RenameAt(Workspace(), uri, line, ch, newName);
        if (edits is null)
        {
            return null;
        }

        // Group reference edits by file into a WorkspaceEdit.changes map (uri -> TextEdit[]).
        var changes = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var group in edits.GroupBy(r => r.Uri, StringComparer.Ordinal))
        {
            changes[group.Key] = group
                .Select(r => (object)new Dictionary<string, object?>
                {
                    ["range"] = RangeOf(r),
                    ["newText"] = newName,
                })
                .ToArray();
        }

        return new Dictionary<string, object?> { ["changes"] = changes };
    }

    private static object ToLocation(Reference r) => new Dictionary<string, object?>
    {
        ["uri"] = r.Uri,
        ["range"] = RangeOf(r),
    };

    private static Dictionary<string, object?> RangeOf(Reference r)
    {
        var line = Math.Max(0, r.Line - 1); // Reference.Line is 1-based; columns are already 0-based
        return new Dictionary<string, object?>
        {
            ["start"] = new Dictionary<string, object?> { ["line"] = line, ["character"] = r.StartColumn },
            ["end"] = new Dictionary<string, object?> { ["line"] = line, ["character"] = r.EndColumn },
        };
    }

    // ---- Code actions -----------------------------------------------------

    /// <summary>
    /// Builds the code actions for the request: diagnostic-driven "did you mean 'X'?" quickfixes
    /// (from the context's diagnostics) plus selection-driven refactors over the request's
    /// <c>params.range</c> (e.g. <c>refactor.extract</c> from <see cref="KoineLanguageService.RefactorsAt"/>).
    /// Each refactor carries an inline WorkspaceEdit; the quickfix behavior is unchanged.
    /// </summary>
    private object? CodeActionResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !root.TryGetProperty("params", out var p))
        {
            return Array.Empty<object>();
        }

        var actions = new List<object>();

        // The client may scope the request to specific kinds via context.only (an array of LSP
        // hierarchical kind strings). When present, an action is offered only if its kind is at or
        // below one of the requested kinds (prefix match, e.g. "refactor" admits "refactor.extract").
        // When absent, all applicable actions are offered (unchanged behavior).
        var only = ReadOnlyKinds(p);

        // 1. Diagnostic quickfixes (unchanged behavior, now gated by context.only).
        if (KindAllowed("quickfix", only)
            && p.TryGetProperty("context", out var context)
            && context.TryGetProperty("diagnostics", out var diags)
            && diags.ValueKind == JsonValueKind.Array)
        {
            foreach (var d in diags.EnumerateArray())
            {
                if (!d.TryGetProperty("message", out var msgEl) || msgEl.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                var suggestion = ExtractSuggestion(msgEl.GetString()!);
                if (suggestion is null || !d.TryGetProperty("range", out var range))
                {
                    continue;
                }

                actions.Add(new Dictionary<string, object?>
                {
                    ["title"] = $"Change to '{suggestion}'",
                    ["kind"] = "quickfix",
                    ["diagnostics"] = new[] { (object)d.Clone() },
                    ["edit"] = new Dictionary<string, object?>
                    {
                        ["changes"] = new Dictionary<string, object?>
                        {
                            [uri] = new[]
                            {
                                (object)new Dictionary<string, object?>
                                {
                                    ["range"] = range.Clone(),
                                    ["newText"] = suggestion,
                                },
                            },
                        },
                    },
                });
            }
        }

        // 2. Selection-driven refactors over params.range (each gated by context.only on its kind).
        if (TryGetRange(p, out var sl, out var sc, out var el, out var ec))
        {
            foreach (var refactor in _ls.RefactorsAt(Workspace(), uri, sl, sc, el, ec))
            {
                if (!KindAllowed(refactor.Kind, only))
                {
                    continue;
                }

                actions.Add(new Dictionary<string, object?>
                {
                    ["title"] = refactor.Title,
                    ["kind"] = refactor.Kind,
                    ["edit"] = new Dictionary<string, object?>
                    {
                        ["changes"] = new Dictionary<string, object?>
                        {
                            [uri] = refactor.Edits
                                .Select(e => (object)new Dictionary<string, object?>
                                {
                                    ["range"] = SpanRange(e.Range),
                                    ["newText"] = e.NewText,
                                })
                                .ToArray(),
                        },
                    },
                });
            }
        }

        return actions;
    }

    /// <summary>
    /// Reads <c>params.context.only</c> — the requested code-action kinds — as a list, or
    /// <c>null</c> when absent (the client did not scope the request). An empty/malformed array
    /// reads as an empty list (the client scoped the request to nothing).
    /// </summary>
    private static IReadOnlyList<string>? ReadOnlyKinds(JsonElement p)
    {
        if (p.TryGetProperty("context", out var context)
            && context.TryGetProperty("only", out var only)
            && only.ValueKind == JsonValueKind.Array)
        {
            var kinds = new List<string>();
            foreach (var k in only.EnumerateArray())
            {
                if (k.ValueKind == JsonValueKind.String && k.GetString() is { } s && s.Length > 0)
                {
                    kinds.Add(s);
                }
            }

            return kinds;
        }

        return null;
    }

    /// <summary>
    /// Whether an action of <paramref name="kind"/> is admitted under the requested
    /// <paramref name="only"/> kinds. <c>null</c> <paramref name="only"/> (absent) admits everything.
    /// Otherwise an LSP hierarchical kind matches when a requested kind is a prefix of it
    /// (e.g. requested <c>"refactor"</c> admits <c>"refactor.extract"</c>); equal kinds match too.
    /// </summary>
    private static bool KindAllowed(string kind, IReadOnlyList<string>? only)
    {
        if (only is null)
        {
            return true;
        }

        foreach (var requested in only)
        {
            if (string.Equals(kind, requested, StringComparison.Ordinal)
                || kind.StartsWith(requested + ".", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Reads the 0-based LSP <c>range</c> from a request's <c>params</c>; false when absent or malformed.</summary>
    private static bool TryGetRange(JsonElement p, out int startLine, out int startChar, out int endLine, out int endChar)
    {
        startLine = startChar = endLine = endChar = 0;
        if (p.TryGetProperty("range", out var range)
            && range.TryGetProperty("start", out var start)
            && range.TryGetProperty("end", out var end)
            && start.TryGetProperty("line", out var sl) && sl.TryGetInt32(out startLine)
            && start.TryGetProperty("character", out var sc) && sc.TryGetInt32(out startChar)
            && end.TryGetProperty("line", out var el) && el.TryGetInt32(out endLine)
            && end.TryGetProperty("character", out var ec) && ec.TryGetInt32(out endChar))
        {
            return true;
        }

        return false;
    }

    // ---- Semantic tokens --------------------------------------------------

    /// <summary>
    /// Computes full-document semantic tokens for the requested document and returns them in the
    /// LSP <c>SemanticTokens</c> shape (<c>{ data: int[] }</c>), where <c>data</c> is the relative
    /// (deltaLine/deltaStart/length/tokenType/tokenModifiers) integer stream. An unopened or
    /// non-parsing document yields an empty stream (graceful degradation — the regex grammar
    /// stays in charge of highlighting).
    /// </summary>
    private object? SemanticTokensResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !_docs.TryGetValue(uri, out var text))
        {
            return new Dictionary<string, object?> { ["data"] = Array.Empty<int>() };
        }

        var tokens = _semanticTokens.Tokenize(text);
        var data = SemanticTokenProvider.Encode(tokens);
        return new Dictionary<string, object?> { ["data"] = data };
    }

    /// <summary>Extracts <c>X</c> from a Suggestions-style message ending in <c>… — did you mean 'X'?</c>.</summary>
    internal static string? ExtractSuggestion(string message)
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

    /// <summary>Maps a service completion kind to its LSP CompletionItemKind number.</summary>
    private static int LspKind(CompletionItemKind kind) => kind switch
    {
        CompletionItemKind.Keyword => 14,
        CompletionItemKind.Class => 7,
        CompletionItemKind.Enum => 13,
        CompletionItemKind.EnumMember => 20,
        CompletionItemKind.Field => 5,
        CompletionItemKind.Property => 10,
        CompletionItemKind.Method => 2,
        _ => 1,
    };

    private static bool TryGetPosition(JsonElement root, out int line, out int character)
    {
        line = 0;
        character = 0;
        if (root.TryGetProperty("params", out var p)
            && p.TryGetProperty("position", out var pos)
            && pos.TryGetProperty("line", out var l)
            && pos.TryGetProperty("character", out var c)
            && l.TryGetInt32(out line)
            && c.TryGetInt32(out character))
        {
            return true;
        }

        return false;
    }

    // ---- Diagnostics ------------------------------------------------------

    private void PublishDiagnostics(string uri, string text)
    {
        var diags = _compiler.Diagnose(text);
        var lines = SplitLines(text);
        var items = diags.Select(d => (object)ToLspDiagnostic(d, lines)).ToArray();
        PublishDiagnostics(uri, items);
    }

    /// <summary>
    /// Diagnoses the merged workspace (every open + on-disk <c>.koi</c> parsed together, as the
    /// build does) and publishes diagnostics per file, so cross-file errors surface in the
    /// right document. Each source file's path is its URI, so each diagnostic's
    /// <see cref="Diagnostic.File"/> identifies the file to publish it to. Files with no
    /// diagnostic are published an empty array (clearing any stale single-file diagnostics).
    /// </summary>
    private void PublishWorkspaceDiagnostics()
    {
        var workspace = Workspace();
        var files = workspace.Select(kv => new SourceFile(kv.Key, kv.Value)).ToList();
        var diags = _compiler.DiagnoseWorkspace(files);

        // Bucket diagnostics by their originating file (== URI). A diagnostic with no file
        // (defensive) is dropped rather than mis-attributed.
        var byUri = new Dictionary<string, List<object>>(StringComparer.Ordinal);
        foreach (var uri in workspace.Keys)
        {
            byUri[uri] = new List<object>();
        }

        foreach (var d in diags)
        {
            if (d.File is { } file && workspace.TryGetValue(file, out var text))
            {
                byUri[file].Add(ToLspDiagnostic(d, SplitLines(text)));
            }
        }

        foreach (var (uri, items) in byUri)
        {
            PublishDiagnostics(uri, items);
        }
    }

    private void PublishDiagnostics(string uri, IReadOnlyList<object> diagnostics) =>
        Notify("textDocument/publishDiagnostics", new Dictionary<string, object?>
        {
            ["uri"] = uri,
            ["diagnostics"] = diagnostics,
        });

    private static Dictionary<string, object?> ToLspDiagnostic(Diagnostic d, string[] lines)
    {
        var (startLine, startChar, endLine, endChar) = ToRange(d, lines);
        return new Dictionary<string, object?>
        {
            ["range"] = new Dictionary<string, object?>
            {
                ["start"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
                ["end"] = new Dictionary<string, object?> { ["line"] = endLine, ["character"] = endChar },
            },
            ["severity"] = d.Severity == DiagnosticSeverity.Error ? 1 : 2, // 1=Error, 2=Warning
            ["code"] = d.Code,
            ["source"] = "koine",
            ["message"] = d.Message,
        };
    }

    /// <summary>
    /// Maps a 1-based Koine <see cref="Diagnostic"/> to a 0-based LSP range. When the diagnostic
    /// carries a known end (<see cref="Diagnostic.HasEnd"/>, i.e. it was built from a node's full
    /// <see cref="SourceSpan"/>), the exact range — possibly multi-token or multi-line — is used.
    /// Otherwise it falls back to a forward scan that underlines the identifier token at the start
    /// position (or one character when none is found).
    /// </summary>
    internal static (int StartLine, int StartChar, int EndLine, int EndChar) ToRange(Diagnostic d, string[] lines)
    {
        var line = Math.Max(0, d.Line - 1);
        var col = Math.Max(0, d.Column - 1);

        // Exact range carried by the diagnostic (end-EXCLUSIVE, 1-based -> 0-based).
        if (d.HasEnd)
        {
            var endLine = Math.Max(0, d.EndLine - 1);
            var endChar = Math.Max(0, d.EndColumn - 1);
            return (line, col, endLine, endChar);
        }

        // Fallback: forward-scan the identifier token at the start position (single line).
        var scanEndCol = col + 1;
        if (line < lines.Length)
        {
            var text = lines[line];
            var e = col;
            while (e < text.Length && (char.IsLetterOrDigit(text[e]) || text[e] == '_'))
            {
                e++;
            }

            scanEndCol = e > col ? e : Math.Min(col + 1, Math.Max(text.Length, col + 1));
        }

        return (line, col, line, scanEndCol);
    }

    internal static string[] SplitLines(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

    // ---- JSON-RPC plumbing -----------------------------------------------

    private void Respond(JsonElement request, object? result)
    {
        var msg = new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["result"] = result };
        if (request.TryGetProperty("id", out var id))
        {
            msg["id"] = id.Clone();
        }

        Send(msg);
    }

    private void Respond(JsonElement request, Dictionary<string, object?> result) =>
        Respond(request, (object?)result);

    private void RespondError(JsonElement request, int code, string message)
    {
        var msg = new Dictionary<string, object?>
        {
            ["jsonrpc"] = "2.0",
            ["error"] = new Dictionary<string, object?> { ["code"] = code, ["message"] = message },
        };
        if (request.TryGetProperty("id", out var id))
        {
            msg["id"] = id.Clone();
        }

        Send(msg);
    }

    private void Notify(string method, object @params) =>
        Send(new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["method"] = method, ["params"] = @params });

    private void Send(object message)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(message, SerializerOptions);
        var header = Encoding.ASCII.GetBytes($"Content-Length: {json.Length}\r\n\r\n");
        _out.Write(header);
        _out.Write(json);
        _out.Flush();
    }

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        // Relaxed escaping: stdio JSON-RPC, not HTML — keep messages readable
        // (don't escape quotes/symbols in diagnostic text to \uXXXX).
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private string? ReadMessage()
    {
        var header = new List<byte>();
        int b;
        while (true)
        {
            b = _in.ReadByte();
            if (b == -1)
            {
                return null;
            }

            header.Add((byte)b);
            var n = header.Count;
            if (n >= 4 && header[n - 4] == '\r' && header[n - 3] == '\n' && header[n - 2] == '\r' && header[n - 1] == '\n')
            {
                break;
            }
        }

        var contentLength = ParseContentLength(Encoding.ASCII.GetString(header.ToArray()));
        if (contentLength <= 0)
        {
            return null;
        }

        var body = new byte[contentLength];
        var read = 0;
        while (read < contentLength)
        {
            var r = _in.Read(body, read, contentLength - read);
            if (r <= 0)
            {
                return null;
            }

            read += r;
        }

        return Encoding.UTF8.GetString(body);
    }

    private static int ParseContentLength(string header)
    {
        foreach (var raw in header.Split("\r\n"))
        {
            var line = raw.Trim();
            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(line["Content-Length:".Length..].Trim(), out var len))
            {
                return len;
            }
        }
        return -1;
    }

    // ---- Param extraction --------------------------------------------------

    /// <summary>Merged view: on-disk workspace files overlaid by open/edited docs (open wins).</summary>
    private Dictionary<string, string> Workspace()
    {
        var merged = new Dictionary<string, string>(_workspaceFiles, StringComparer.Ordinal);
        foreach (var (uri, text) in _docs)
        {
            merged[uri] = text;
        }

        return merged;
    }

    private static string? PathToUri(string path)
    {
        try
        { return new Uri(path).AbsoluteUri; }
        catch { return null; }
    }

    private static string? UriToPath(string uri)
    {
        try
        { var u = new Uri(uri); return u.IsFile ? u.LocalPath : null; }
        catch { return null; }
    }

    /// <summary>Scans the workspace root for *.koi files into <see cref="_workspaceFiles"/>.</summary>
    private void ScanWorkspace(string rootUri)
    {
        var root = UriToPath(rootUri);
        if (root is null || !Directory.Exists(root))
        {
            return;
        }

        if (!_scannedRoots.Add(root))
        {
            return; // already scanned this root (e.g. rootUri == a workspaceFolder)
        }

        try
        {
            foreach (var path in Directory.EnumerateFiles(root, "*.koi", SearchOption.AllDirectories))
            {
                var rel = path.Replace('\\', '/');
                if (rel.Contains("/bin/") || rel.Contains("/obj/") || rel.Contains("/.git/"))
                {
                    continue;
                }

                var uri = PathToUri(path);
                if (uri is null)
                {
                    continue;
                }

                try
                { _workspaceFiles[uri] = File.ReadAllText(path); }
                catch (Exception ex) { Log($"skip {path}: {ex.Message}"); }
            }
            Log($"workspace scan indexed {_workspaceFiles.Count} .koi file(s)");
        }
        catch (Exception ex) { Log("workspace scan failed: " + ex); }
    }

    private static bool TryGetUri(JsonElement root, out string uri)
    {
        uri = "";
        if (root.TryGetProperty("params", out var p)
            && p.TryGetProperty("textDocument", out var td)
            && td.TryGetProperty("uri", out var u))
        {
            uri = u.GetString() ?? "";
            return uri.Length > 0;
        }
        return false;
    }

    private static bool TryGetTextDocument(JsonElement root, out string uri, out string text)
    {
        uri = "";
        text = "";
        if (root.TryGetProperty("params", out var p)
            && p.TryGetProperty("textDocument", out var td)
            && td.TryGetProperty("uri", out var u)
            && td.TryGetProperty("text", out var t))
        {
            uri = u.GetString() ?? "";
            text = t.GetString() ?? "";
            return uri.Length > 0;
        }
        return false;
    }

    private static bool TryGetChange(JsonElement root, out string uri, out string text)
    {
        uri = "";
        text = "";
        if (!TryGetUri(root, out uri))
        {
            return false;
        }

        if (root.TryGetProperty("params", out var p)
            && p.TryGetProperty("contentChanges", out var changes)
            && changes.ValueKind == JsonValueKind.Array
            && changes.GetArrayLength() > 0)
        {
            // Full document sync: take the last change's text.
            var last = changes[changes.GetArrayLength() - 1];
            if (last.TryGetProperty("text", out var t))
            {
                text = t.GetString() ?? "";
                return true;
            }
        }
        return false;
    }

    private static bool TryGetSave(JsonElement root, out string uri, out string? text)
    {
        text = null;
        if (!TryGetUri(root, out uri))
        {
            return false;
        }

        if (root.TryGetProperty("params", out var p) && p.TryGetProperty("text", out var t))
        {
            text = t.GetString();
        }

        return true;
    }
}
