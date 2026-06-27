using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Grammar;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Wasm;

// Call-hierarchy and type-hierarchy surface of the in-browser language service: prepare/incoming/
// outgoing calls and prepare/supertypes/subtypes, plus their item (de)serialization helpers.
// See CompilerInterop.LanguageService.cs.
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
    /// <summary>
    /// Prepare call hierarchy at a 0-based position in <paramref name="activeUri"/> (LSP
    /// <c>textDocument/prepareCallHierarchy</c>): the command/event under the cursor, as a JSON array of
    /// LSP CallHierarchyItem. Parity with the stdio LSP's <c>CallHierarchyPrepareJson</c>.
    /// </summary>
    [JSExport]
    public static string PrepareCallHierarchy(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var items = LanguageService.PrepareCallHierarchy(comp, activeUri, line, character)
                .Select(MapCallHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WCallHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Incoming calls (LSP <c>callHierarchy/incomingCalls</c>): <paramref name="itemJson"/> is the LSP
    /// CallHierarchyItem; its <c>name</c> + <c>data</c> reconstruct the in-process item. Returns a JSON
    /// array of <c>{ from, fromRanges }</c> (fromRanges empty). Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string IncomingCalls(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeCallHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var calls = LanguageService.IncomingCalls(comp, item)
                .Select(c => new WCallHierarchyIncomingCall(MapCallHierarchyItem(c.From), []))
                .ToArray();
            return JsonSerializer.Serialize(calls, LangJson.Default.WCallHierarchyIncomingCallArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Outgoing calls (LSP <c>callHierarchy/outgoingCalls</c>): <paramref name="itemJson"/> is the LSP
    /// CallHierarchyItem. Returns a JSON array of <c>{ to, fromRanges }</c> (fromRanges empty). Parity
    /// with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string OutgoingCalls(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeCallHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var calls = LanguageService.OutgoingCalls(comp, item)
                .Select(c => new WCallHierarchyOutgoingCall(MapCallHierarchyItem(c.To), []))
                .ToArray();
            return JsonSerializer.Serialize(calls, LangJson.Default.WCallHierarchyOutgoingCallArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Maps a <see cref="CallHierarchyItem"/> to the wire <see cref="WCallHierarchyItem"/>: kind is an
    /// LSP SymbolKind number (Method=6 Command / Event=24); range + selectionRange are both the item's
    /// 0-based name span; the <c>data</c> blob carries chKind + owningType (mirrors LspServer).
    /// </summary>
    private static WCallHierarchyItem MapCallHierarchyItem(CallHierarchyItem item)
    {
        var range = SpanRange(item.Span);
        return new WCallHierarchyItem(
            item.Name,
            item.Kind == CallHierarchyItemKind.Command ? 6 : 24, // LSP SymbolKind: Method=6, Event=24
            item.Uri,
            range,
            range,
            new WCallHierarchyData(
                item.Kind == CallHierarchyItemKind.Command ? "Command" : "Event",
                item.OwningType));
    }

    /// <summary>
    /// Reconstructs a <see cref="CallHierarchyItem"/> from an LSP CallHierarchyItem JSON: only
    /// <c>name</c> + <c>data.chKind</c>/<c>data.owningType</c> are read (the incoming/outgoing calls use
    /// just those three fields; the span/uri are placeholders). Returns <c>null</c> when malformed.
    /// </summary>
    private static CallHierarchyItem? DeserializeCallHierarchyItem(string itemJson)
    {
        WCallHierarchyItem? dto = JsonSerializer.Deserialize(itemJson, LangJson.Default.WCallHierarchyItem);
        // Require a non-empty chKind, exactly like the stdio server's ReadCallHierarchyItem — so a
        // malformed item (missing data/chKind) yields the SAME empty result on both backends rather
        // than the WASM side silently defaulting to Command and diverging from the stdio LSP.
        if (dto is null || string.IsNullOrEmpty(dto.Name) || dto.Data is null || string.IsNullOrEmpty(dto.Data.ChKind))
        {
            return null;
        }

        var kind = string.Equals(dto.Data.ChKind, "Event", StringComparison.Ordinal)
            ? CallHierarchyItemKind.Event
            : CallHierarchyItemKind.Command;
        return new CallHierarchyItem(dto.Name, kind, dto.Data.OwningType, "", SourceSpan.None);
    }

    /// <summary>
    /// Prepare type hierarchy at a 0-based position in <paramref name="activeUri"/> (LSP
    /// <c>textDocument/prepareTypeHierarchy</c>): the declared type under the cursor, as a JSON array of
    /// LSP TypeHierarchyItem. Parity with the stdio LSP's <c>TypeHierarchyPrepareJson</c>.
    /// </summary>
    [JSExport]
    public static string PrepareTypeHierarchy(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var items = LanguageService.PrepareTypeHierarchy(comp, activeUri, line, character)
                .Select(MapTypeHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WTypeHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Supertypes (LSP <c>typeHierarchy/supertypes</c>): <paramref name="itemJson"/> is the LSP
    /// TypeHierarchyItem; its <c>name</c> + <c>data</c> reconstruct the in-process item. Returns a JSON
    /// array of the declared types it points at. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string Supertypes(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeTypeHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var items = LanguageService.Supertypes(comp, item)
                .Select(MapTypeHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WTypeHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Subtypes (LSP <c>typeHierarchy/subtypes</c>): <paramref name="itemJson"/> is the LSP
    /// TypeHierarchyItem. Returns a JSON array of the declared types that point at it (the inverse edges).
    /// Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string Subtypes(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeTypeHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            var items = LanguageService.Subtypes(comp, item)
                .Select(MapTypeHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WTypeHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Maps a <see cref="TypeHierarchyItem"/> to the wire <see cref="WTypeHierarchyItem"/>: kind is an LSP
    /// SymbolKind number; range + selectionRange are both the declaration's 0-based name span; the
    /// <c>data</c> blob carries the in-process kind (<c>thKind</c>) so a supertypes/subtypes request can
    /// reconstruct the item. Mirrors LspServer's <c>TypeHierarchyItemJson</c>.
    /// </summary>
    private static WTypeHierarchyItem MapTypeHierarchyItem(TypeHierarchyItem item)
    {
        var range = SpanRange(item.Span);
        return new WTypeHierarchyItem(
            item.Name,
            LspTypeHierarchyKind(item.Kind),
            item.Uri,
            range,
            range,
            new WTypeHierarchyData(item.Kind.ToString()));
    }

    /// <summary>
    /// Reconstructs a <see cref="TypeHierarchyItem"/> from an LSP TypeHierarchyItem JSON: only <c>name</c> +
    /// <c>data.thKind</c> are read (the supertypes/subtypes resolution keys off the name; the span/uri are
    /// placeholders). Returns <c>null</c> when malformed — the SAME empty result the stdio LSP produces.
    /// </summary>
    private static TypeHierarchyItem? DeserializeTypeHierarchyItem(string itemJson)
    {
        WTypeHierarchyItem? dto = JsonSerializer.Deserialize(itemJson, LangJson.Default.WTypeHierarchyItem);
        if (dto is null || string.IsNullOrEmpty(dto.Name) || dto.Data is null || string.IsNullOrEmpty(dto.Data.ThKind))
        {
            return null;
        }

        var kind = Enum.TryParse<TypeHierarchyItemKind>(dto.Data.ThKind, out var k) ? k : TypeHierarchyItemKind.Other;
        return new TypeHierarchyItem(dto.Name, kind, "", SourceSpan.None);
    }

    /// <summary>Maps a <see cref="TypeHierarchyItemKind"/> to the numeric LSP <c>SymbolKind</c> (mirrors LspServer).</summary>
    private static int LspTypeHierarchyKind(TypeHierarchyItemKind kind) => kind switch
    {
        TypeHierarchyItemKind.Aggregate => 5,  // Class
        TypeHierarchyItemKind.Entity => 5,     // Class
        TypeHierarchyItemKind.Value => 23,     // Struct
        TypeHierarchyItemKind.ReadModel => 11, // Interface
        TypeHierarchyItemKind.Enum => 10,      // Enum
        TypeHierarchyItemKind.Event => 24,     // Event
        _ => 13,                               // Variable
    };

}
