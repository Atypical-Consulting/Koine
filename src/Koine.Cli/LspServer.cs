using System.Text;
using System.Text.Json;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

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
    private readonly Dictionary<string, string> _docs = new(StringComparer.Ordinal);

    // On-disk baseline of every *.koi in the workspace (uri -> text), scanned at initialize.
    private readonly Dictionary<string, string> _workspaceFiles = new(StringComparer.Ordinal);
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
        try { Console.Error.WriteLine(line); } catch { /* never fail on logging */ }

        var path = Environment.GetEnvironmentVariable("KOINE_LSP_LOG");
        if (!string.IsNullOrEmpty(path))
        {
            try { File.AppendAllText(path, line + Environment.NewLine); } catch { /* ignore */ }
        }
    }

    public int Loop()
    {
        while (true)
        {
            var message = ReadMessage();
            if (message is null)
                return 0; // EOF

            JsonDocument doc;
            try { doc = JsonDocument.Parse(message); }
            catch (JsonException) { continue; }

            using (doc)
            {
                var root = doc.RootElement;
                var method = root.TryGetProperty("method", out var m) ? m.GetString() : null;
                if (method is null)
                    continue;

                Log("<- " + method);
                try
                {
                switch (method)
                {
                    case "initialize":
                        if (root.TryGetProperty("params", out var initParams))
                        {
                            if (initParams.TryGetProperty("rootUri", out var ru) && ru.ValueKind == JsonValueKind.String)
                                ScanWorkspace(ru.GetString()!);
                            if (initParams.TryGetProperty("workspaceFolders", out var folders)
                                && folders.ValueKind == JsonValueKind.Array)
                                foreach (var f in folders.EnumerateArray())
                                    if (f.TryGetProperty("uri", out var fu) && fu.ValueKind == JsonValueKind.String)
                                        ScanWorkspace(fu.GetString()!);
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
                            PublishDiagnostics(openUri, openText);
                        }
                        break;

                    case "textDocument/didChange":
                        if (TryGetChange(root, out var changeUri, out var changeText))
                        {
                            _docs[changeUri] = changeText;
                            PublishDiagnostics(changeUri, changeText);
                        }
                        break;

                    case "textDocument/didSave":
                        if (TryGetSave(root, out var saveUri, out var saveText) && saveText is not null)
                        {
                            _docs[saveUri] = saveText;
                            PublishDiagnostics(saveUri, saveText);
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
                            Respond(root, CompletionResult(root));
                        break;

                    case "textDocument/hover":
                        if (root.TryGetProperty("id", out _))
                            Respond(root, HoverResultJson(root));
                        break;

                    case "textDocument/definition":
                        if (root.TryGetProperty("id", out _))
                            Respond(root, DefinitionResultJson(root));
                        break;

                    case "shutdown":
                        Respond(root, result: (object?)null);
                        break;

                    case "exit":
                        return 0;

                    default:
                        // Unknown request (has an id): reply method-not-found so the
                        // client doesn't block waiting. Unknown notifications: ignore.
                        if (root.TryGetProperty("id", out _))
                            RespondError(root, -32601, "method not found: " + method);
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
            return null;

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
            return null;

        var hover = _ls.HoverAt(Workspace(), uri, line, ch);
        if (hover is null)
            return null;

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
            return null;

        var def = _ls.DefinitionAt(Workspace(), uri, line, ch);
        if (def is null)
            return null;

        // SpanOf points at the declaration keyword and Column is 1-based; the LSP
        // range is 0-based and zero-width (editor recomputes the identifier extent).
        var startLine = Math.Max(0, def.Target.Line - 1);
        var startChar = Math.Max(0, def.Target.Column - 1);
        return new Dictionary<string, object?>
        {
            // The target may live in a different file than the request (cross-file resolution).
            ["uri"] = def.Uri,
            ["range"] = new Dictionary<string, object?>
            {
                ["start"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
                ["end"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
            },
        };
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
        line = 0; character = 0;
        if (root.TryGetProperty("params", out var p)
            && p.TryGetProperty("position", out var pos)
            && pos.TryGetProperty("line", out var l)
            && pos.TryGetProperty("character", out var c)
            && l.TryGetInt32(out line)
            && c.TryGetInt32(out character))
            return true;
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

    private void PublishDiagnostics(string uri, IReadOnlyList<object> diagnostics) =>
        Notify("textDocument/publishDiagnostics", new Dictionary<string, object?>
        {
            ["uri"] = uri,
            ["diagnostics"] = diagnostics,
        });

    private static Dictionary<string, object?> ToLspDiagnostic(Diagnostic d, string[] lines)
    {
        var (startLine, startChar, endChar) = ToRange(d, lines);
        return new Dictionary<string, object?>
        {
            ["range"] = new Dictionary<string, object?>
            {
                ["start"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
                ["end"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = endChar },
            },
            ["severity"] = d.Severity == DiagnosticSeverity.Error ? 1 : 2, // 1=Error, 2=Warning
            ["code"] = d.Code,
            ["source"] = "koine",
            ["message"] = d.Message,
        };
    }

    /// <summary>
    /// Maps a 1-based Koine <see cref="Diagnostic"/> position to a 0-based LSP range,
    /// underlining the token at the position (or one character when none is found).
    /// </summary>
    internal static (int Line, int StartChar, int EndChar) ToRange(Diagnostic d, string[] lines)
    {
        var line = Math.Max(0, d.Line - 1);
        var col = Math.Max(0, d.Column - 1);
        var endCol = col + 1;

        if (line < lines.Length)
        {
            var text = lines[line];
            var e = col;
            while (e < text.Length && (char.IsLetterOrDigit(text[e]) || text[e] == '_'))
                e++;
            endCol = e > col ? e : Math.Min(col + 1, Math.Max(text.Length, col + 1));
        }

        return (line, col, endCol);
    }

    internal static string[] SplitLines(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

    // ---- JSON-RPC plumbing -----------------------------------------------

    private void Respond(JsonElement request, object? result)
    {
        var msg = new Dictionary<string, object?> { ["jsonrpc"] = "2.0", ["result"] = result };
        if (request.TryGetProperty("id", out var id))
            msg["id"] = id.Clone();
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
            msg["id"] = id.Clone();
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
                return null;
            header.Add((byte)b);
            var n = header.Count;
            if (n >= 4 && header[n - 4] == '\r' && header[n - 3] == '\n' && header[n - 2] == '\r' && header[n - 1] == '\n')
                break;
        }

        var contentLength = ParseContentLength(Encoding.ASCII.GetString(header.ToArray()));
        if (contentLength <= 0)
            return null;

        var body = new byte[contentLength];
        var read = 0;
        while (read < contentLength)
        {
            var r = _in.Read(body, read, contentLength - read);
            if (r <= 0)
                return null;
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
                return len;
        }
        return -1;
    }

    // ---- Param extraction --------------------------------------------------

    /// <summary>Merged view: on-disk workspace files overlaid by open/edited docs (open wins).</summary>
    private Dictionary<string, string> Workspace()
    {
        var merged = new Dictionary<string, string>(_workspaceFiles, StringComparer.Ordinal);
        foreach (var (uri, text) in _docs)
            merged[uri] = text;
        return merged;
    }

    private static string? PathToUri(string path)
    {
        try { return new Uri(path).AbsoluteUri; } catch { return null; }
    }

    private static string? UriToPath(string uri)
    {
        try { var u = new Uri(uri); return u.IsFile ? u.LocalPath : null; } catch { return null; }
    }

    /// <summary>Scans the workspace root for *.koi files into <see cref="_workspaceFiles"/>.</summary>
    private void ScanWorkspace(string rootUri)
    {
        var root = UriToPath(rootUri);
        if (root is null || !Directory.Exists(root))
            return;
        try
        {
            foreach (var path in Directory.EnumerateFiles(root, "*.koi", SearchOption.AllDirectories))
            {
                if (path.Contains("/bin/") || path.Contains("/obj/") || path.Contains("/.git/"))
                    continue;
                var uri = PathToUri(path);
                if (uri is null) continue;
                try { _workspaceFiles[uri] = File.ReadAllText(path); }
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
        uri = ""; text = "";
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
        uri = ""; text = "";
        if (!TryGetUri(root, out uri))
            return false;
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
            return false;
        if (root.TryGetProperty("params", out var p) && p.TryGetProperty("text", out var t))
            text = t.GetString();
        return true;
    }
}
