using System.Text;

namespace Koine.Compiler.Emit.OpenApi;

// ============================================================================
// A tiny, deterministic YAML block-style document model + writer, just large
// enough to render an OpenAPI 3.1 document. Hand-rolled on purpose: it adds no
// dependency to the compiler and gives the emitter total control over key order
// and quoting, so Verify snapshots are byte-reproducible.
//
// TARGET-AGNOSTIC at the Koine level (no .koi concept leaks in), but it IS an
// OpenAPI-emitter-private representation — it lives under Emit/OpenApi/, never in
// Ast/. Maps preserve INSERTION ORDER (the emitter chooses a stable order); the
// writer never sorts, so the emitter is the single source of ordering truth.
// ============================================================================

/// <summary>Base type for a node in the small YAML model.</summary>
internal abstract class Yaml
{
    /// <summary>A double-quoted/auto-quoted string scalar.</summary>
    public static Yaml Str(string value) => new YamlScalar(value, quoted: true);

    /// <summary>
    /// A raw, never-quoted token — numbers, booleans, and OpenAPI tokens such as the
    /// <c>3.1.0</c> version that must render verbatim. The caller guarantees it is YAML-safe.
    /// </summary>
    public static Yaml Raw(string token) => new YamlScalar(token, quoted: false);

    public static Yaml Int(int value) => Raw(value.ToString(System.Globalization.CultureInfo.InvariantCulture));

    public static Yaml Bool(bool value) => Raw(value ? "true" : "false");
}

/// <summary>
/// A scalar value. When <see cref="Quoted"/> is set the writer applies YAML quoting rules
/// (double-quoting and escaping when the text is not plain-safe); otherwise the text renders verbatim.
/// </summary>
internal sealed class YamlScalar(string text, bool quoted) : Yaml
{
    public string Text { get; } = text;

    public bool Quoted { get; } = quoted;
}

/// <summary>An ordered mapping (object). Entries render in insertion order — never sorted.</summary>
internal sealed class YamlObject : Yaml
{
    private readonly List<KeyValuePair<string, Yaml>> _entries = [];

    public IReadOnlyList<KeyValuePair<string, Yaml>> Entries => _entries;

    public bool IsEmpty => _entries.Count == 0;

    public YamlObject Add(string key, Yaml value)
    {
        _entries.Add(new KeyValuePair<string, Yaml>(key, value));
        return this;
    }

    public YamlObject Add(string key, string value) => Add(key, Str(value));

    /// <summary>Adds <paramref name="value"/> under <paramref name="key"/> only when it is non-null.</summary>
    public YamlObject AddIf(bool condition, string key, Yaml value) => condition ? Add(key, value) : this;
}

/// <summary>An ordered sequence (array). Items render in insertion order — never sorted.</summary>
internal sealed class YamlArray : Yaml
{
    private readonly List<Yaml> _items = [];

    public IReadOnlyList<Yaml> Items => _items;

    public bool IsEmpty => _items.Count == 0;

    public YamlArray Add(Yaml item)
    {
        _items.Add(item);
        return this;
    }
}

/// <summary>Renders a <see cref="Yaml"/> document to deterministic block-style YAML text (2-space indent).</summary>
internal static class OpenApiYamlWriter
{
    public static string Render(YamlObject document)
    {
        var sb = new StringBuilder();
        WriteMap(sb, document, indent: 0);
        return sb.ToString();
    }

    private static void WriteMap(StringBuilder sb, YamlObject map, int indent)
    {
        foreach (var (key, value) in map.Entries)
        {
            WriteEntry(sb, key, value, indent);
        }
    }

    private static void WriteEntry(StringBuilder sb, string key, Yaml value, int indent)
    {
        Pad(sb, indent).Append(KeyText(key)).Append(':');
        switch (value)
        {
            case YamlScalar scalar:
                sb.Append(' ').Append(ScalarText(scalar)).Append('\n');
                break;

            case YamlObject obj when obj.IsEmpty:
                sb.Append(" {}\n");
                break;

            case YamlArray arr when arr.IsEmpty:
                sb.Append(" []\n");
                break;

            case YamlObject obj:
                sb.Append('\n');
                WriteMap(sb, obj, indent + 1);
                break;

            case YamlArray arr:
                sb.Append('\n');
                WriteArray(sb, arr, indent + 1);
                break;
        }
    }

    private static void WriteArray(StringBuilder sb, YamlArray arr, int indent)
    {
        foreach (Yaml item in arr.Items)
        {
            WriteArrayItem(sb, item, indent);
        }
    }

    private static void WriteArrayItem(StringBuilder sb, Yaml item, int indent)
    {
        switch (item)
        {
            case YamlScalar scalar:
                Pad(sb, indent).Append("- ").Append(ScalarText(scalar)).Append('\n');
                break;

            case YamlObject obj when obj.IsEmpty:
                Pad(sb, indent).Append("- {}\n");
                break;

            case YamlArray arr when arr.IsEmpty:
                Pad(sb, indent).Append("- []\n");
                break;

            default:
                // A container item: render its body one level deeper, then splice the leading "- "
                // marker over the first line's indentation so the first key sits on the dash line.
                var inner = new StringBuilder();
                if (item is YamlObject map)
                {
                    WriteMap(inner, map, indent + 1);
                }
                else
                {
                    WriteArray(inner, (YamlArray)item, indent + 1);
                }

                string innerText = inner.ToString();
                int dashOffset = indent * 2;
                sb.Append(innerText, 0, dashOffset).Append("- ").Append(innerText, dashOffset + 2, innerText.Length - dashOffset - 2);
                break;
        }
    }

    private static StringBuilder Pad(StringBuilder sb, int indent) => sb.Append(' ', indent * 2);

    private static string ScalarText(YamlScalar scalar) =>
        scalar.Quoted && NeedsQuoting(scalar.Text) ? Quote(scalar.Text) : scalar.Text;

    /// <summary>A mapping key is quoted under the same rules as a string scalar.</summary>
    private static string KeyText(string key) => NeedsQuoting(key) ? Quote(key) : key;

    /// <summary>
    /// True when a string is not "plain-safe" and must be double-quoted: anything empty, not a bare
    /// identifier-ish token, or that collides with a YAML reserved word (<c>true/false/null/…</c>) or a
    /// number. Erring toward quoting is always safe; under-quoting is not.
    /// </summary>
    private static bool NeedsQuoting(string text)
    {
        if (text.Length == 0)
        {
            return true;
        }

        foreach (char c in text)
        {
            if (!(char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.' or '/'))
            {
                return true;
            }
        }

        char first = text[0];
        if (!(char.IsAsciiLetter(first) || first == '_' || first == '/'))
        {
            // Leads with a digit, '-', or '.': could be read as a number/date/sequence marker.
            return true;
        }

        return IsReservedWord(text);
    }

    private static bool IsReservedWord(string text) => text.ToLowerInvariant() switch
    {
        "true" or "false" or "null" or "yes" or "no" or "on" or "off" or "~" => true,
        _ => false,
    };

    private static string Quote(string text)
    {
        var sb = new StringBuilder(text.Length + 2);
        sb.Append('"');
        foreach (char c in text)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default: sb.Append(c); break;
            }
        }

        sb.Append('"');
        return sb.ToString();
    }
}
