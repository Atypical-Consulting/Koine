using System.Text;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// A minimal <a href="https://sourcemaps.info/spec.html">Source Map v3</a> builder for the
/// TypeScript backend. Declaration-granularity: one segment per mapped generated line, pointing it
/// at the originating <c>.koi</c> line/column — mirroring the C# emitter's <c>#line</c>-per-declaration
/// granularity. The <c>mappings</c> field is base64-VLQ encoded with fields delta-coded against the
/// previous segment (generated column, source index, source line, source column), segments
/// comma-separated within a generated line and lines semicolon-separated.
/// </summary>
internal static class SourceMapV3
{
    private const string Base64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// <summary>One declaration mapping: a 1-based generated line → 0-based source position.</summary>
    /// <param name="GeneratedLine">1-based generated line the segment starts on.</param>
    /// <param name="GeneratedColumn">0-based generated column.</param>
    /// <param name="SourceLine">0-based line in the source file.</param>
    /// <param name="SourceColumn">0-based column in the source file.</param>
    internal readonly record struct Mapping(int GeneratedLine, int GeneratedColumn, int SourceLine, int SourceColumn);

    /// <summary>
    /// Serializes a Source Map v3 JSON document for a single-source module. Mappings are sorted by
    /// generated line then column so the VLQ deltas are well-formed.
    /// </summary>
    public static string Build(string file, string source, IReadOnlyList<Mapping> mappings)
    {
        var json = new StringBuilder();
        json.Append("{\"version\":3,\"file\":")
            .Append(JsonString(file))
            .Append(",\"sources\":[")
            .Append(JsonString(source))
            .Append("],\"names\":[],\"mappings\":")
            .Append(JsonString(BuildMappings(mappings)))
            .Append('}');
        return json.ToString();
    }

    /// <summary>Encodes the <c>mappings</c> string (the VLQ payload), single-source (index 0).</summary>
    private static string BuildMappings(IReadOnlyList<Mapping> mappings)
    {
        var ordered = mappings
            .OrderBy(m => m.GeneratedLine)
            .ThenBy(m => m.GeneratedColumn)
            .ToList();

        var sb = new StringBuilder();

        // Delta state. Generated column resets each line; the rest are file-global per the spec.
        var prevGeneratedLine = 1; // 1-based; mappings lines are emitted relative to line 1.
        var prevGeneratedColumn = 0;
        var prevSourceIndex = 0;
        var prevSourceLine = 0;
        var prevSourceColumn = 0;
        var firstSegmentOnLine = true;

        foreach (Mapping m in ordered)
        {
            // Emit a semicolon for every generated line we advance past; reset the column delta base.
            while (prevGeneratedLine < m.GeneratedLine)
            {
                sb.Append(';');
                prevGeneratedLine++;
                prevGeneratedColumn = 0;
                firstSegmentOnLine = true;
            }

            if (!firstSegmentOnLine)
            {
                sb.Append(',');
            }

            firstSegmentOnLine = false;

            AppendVlq(sb, m.GeneratedColumn - prevGeneratedColumn);
            AppendVlq(sb, 0 - prevSourceIndex); // single source, index 0
            AppendVlq(sb, m.SourceLine - prevSourceLine);
            AppendVlq(sb, m.SourceColumn - prevSourceColumn);

            prevGeneratedColumn = m.GeneratedColumn;
            prevSourceIndex = 0;
            prevSourceLine = m.SourceLine;
            prevSourceColumn = m.SourceColumn;
        }

        return sb.ToString();
    }

    /// <summary>Appends a single base64-VLQ value: sign in the LSB, 5-bit groups, continuation in bit 6.</summary>
    private static void AppendVlq(StringBuilder sb, int value)
    {
        // Move the sign into the least-significant bit (zig-zag-style for VLQ).
        var vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
        do
        {
            var digit = vlq & 0b11111;
            vlq >>= 5;
            if (vlq > 0)
            {
                digit |= 0b100000; // continuation bit
            }
            sb.Append(Base64[digit]);
        }
        while (vlq > 0);
    }

    /// <summary>Minimal JSON string escaping (the inputs are file paths and base64 text).</summary>
    private static string JsonString(string value)
    {
        var sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        foreach (var ch in value)
        {
            switch (ch)
            {
                case '"':
                    sb.Append("\\\"");
                    break;
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '\n':
                    sb.Append("\\n");
                    break;
                case '\r':
                    sb.Append("\\r");
                    break;
                case '\t':
                    sb.Append("\\t");
                    break;
                default:
                    if (ch < 0x20)
                    {
                        sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    }
                    else
                    {
                        sb.Append(ch);
                    }
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
