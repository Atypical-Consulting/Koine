using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Ast;

// ============================================================================
// Model coverage: which of a model's declared types a given target actually
// emitted. TARGET-AGNOSTIC — this lives in Ast/ and references only the
// target-agnostic EmittedFile record (namespace Koine.Compiler.Emit) plus a
// free-form target string. No concrete emitter internals leak in here.
// ============================================================================

/// <summary>Whether a declared type was emitted by a target.</summary>
public enum CoverageState
{
    /// <summary>The target emitted this type.</summary>
    Covered,

    /// <summary>
    /// The target emitted this type only in part. Reserved for a future per-target
    /// Phase-1 scope; v1 emits only <see cref="Covered"/>/<see cref="Missing"/>.
    /// </summary>
    Partial,

    /// <summary>The target did not emit this type.</summary>
    Missing
}

/// <summary>
/// One declared type's coverage entry: its <see cref="Kind"/> (e.g. <c>value</c>,
/// <c>entity</c>), its <see cref="Name"/>, its owning context, and whether the
/// target emitted it.
/// </summary>
public sealed record CoverageItem(string Kind, string Name, string Context, CoverageState State);

/// <summary>
/// A coverage report for one target: every declared type with its
/// <see cref="CoverageState"/>, plus rollups.
/// </summary>
public sealed record CoverageReport(string Target, IReadOnlyList<CoverageItem> Items)
{
    /// <summary>The number of declared types considered.</summary>
    public int Total => Items.Count;

    /// <summary>How many declared types the target emitted.</summary>
    public int Covered => Items.Count(i => i.State == CoverageState.Covered);

    /// <summary>True when no declared type is <see cref="CoverageState.Missing"/>.</summary>
    public bool IsComplete => Items.All(i => i.State != CoverageState.Missing);
}

/// <summary>
/// Computes and renders <see cref="CoverageReport"/>s. Target-agnostic: it walks the
/// semantic model's declared types and checks each against the raw text of the
/// emitted files, with no knowledge of any specific emitter.
/// </summary>
public static class ModelCoverage
{
    /// <summary>
    /// Builds the coverage report for <paramref name="target"/>: enumerates every declared
    /// type across the model's contexts (flattening aggregate nestings via
    /// <see cref="AstExtensions.AllTypeDecls(ContextNode)"/> so each type keeps its owning
    /// context), classifies each by its <see cref="TypeDecl"/> subtype, and marks it
    /// <see cref="CoverageState.Covered"/> when any emitted file's contents contain its name
    /// (ordinal) — otherwise <see cref="CoverageState.Missing"/>. An aggregate boundary is not
    /// emitted as a type, so it is matched on its ROOT entity's name instead of its own. Items are
    /// returned in a deterministic order: by context, then kind, then name (all ordinal).
    /// </summary>
    public static CoverageReport Compute(KoineModel model, IReadOnlyList<EmittedFile> emitted, string target)
    {
        var items = new List<CoverageItem>();

        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl decl in ctx.AllTypeDecls())
            {
                if (KindOf(decl) is not { } kind)
                {
                    continue;
                }

                // An aggregate boundary is not itself emitted as a type (it has no sub-namespace);
                // it is realized when its ROOT entity is emitted. Match it on the root name so the
                // recommended distinct-boundary shape (`aggregate Sales root Order`) is not spuriously
                // reported as missing. All other kinds match on their own emitted name.
                string emittedName = decl is AggregateDecl agg ? agg.RootName : decl.Name;
                CoverageState state = emitted.Any(f => f.Contents.Contains(emittedName, StringComparison.Ordinal))
                    ? CoverageState.Covered
                    : CoverageState.Missing;

                items.Add(new CoverageItem(kind, decl.Name, ctx.Name, state));
            }
        }

        items.Sort(static (a, b) =>
        {
            int byContext = string.CompareOrdinal(a.Context, b.Context);
            if (byContext != 0)
            {
                return byContext;
            }

            int byKind = string.CompareOrdinal(a.Kind, b.Kind);
            return byKind != 0 ? byKind : string.CompareOrdinal(a.Name, b.Name);
        });

        return new CoverageReport(target, items);
    }

    /// <summary>
    /// Serializes a report to stable, indented JSON: <c>Target</c>, the <c>Total</c>/<c>Covered</c>
    /// rollups, <c>IsComplete</c>, and the <c>Items</c> array. <see cref="CoverageState"/> is
    /// rendered as its name (e.g. <c>"Covered"</c>) by the source-generated <see cref="CoverageJson"/> context.
    /// </summary>
    public static string ToJson(CoverageReport report)
    {
        var dto = new CoverageJsonDto(report.Target, report.Total, report.Covered, report.IsComplete, report.Items);
        return JsonSerializer.Serialize(dto, CoverageJson.Default.CoverageJsonDto);
    }

    /// <summary>
    /// Renders a human-readable summary grouped by context, with a per-kind
    /// <c>covered/total</c> line, ending in a single ✅/⚠️ status line.
    /// </summary>
    public static string RenderText(CoverageReport report)
    {
        var sb = new StringBuilder();
        sb.Append("Coverage for ").Append(report.Target).Append(": ")
          .Append(report.Covered).Append('/').Append(report.Total)
          .Append(" types covered").Append('\n');

        foreach (IGrouping<string, CoverageItem> ctx in report.Items
            .GroupBy(i => i.Context, StringComparer.Ordinal)
            .OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            sb.Append('\n').Append(ctx.Key).Append('\n');

            foreach (IGrouping<string, CoverageItem> kind in ctx
                .GroupBy(i => i.Kind, StringComparer.Ordinal)
                .OrderBy(g => g.Key, StringComparer.Ordinal))
            {
                int covered = kind.Count(i => i.State == CoverageState.Covered);
                int total = kind.Count();
                sb.Append("  ").Append(kind.Key).Append(": ")
                  .Append(covered).Append('/').Append(total).Append('\n');
            }
        }

        sb.Append('\n');
        if (report.IsComplete)
        {
            sb.Append("✅ All declared types are covered by the ")
              .Append(report.Target).Append(" target.");
        }
        else
        {
            int missing = report.Total - report.Covered;
            sb.Append("⚠️ ").Append(missing)
              .Append(missing == 1 ? " declared type is" : " declared types are")
              .Append(" not covered by the ").Append(report.Target).Append(" target.");
        }

        return sb.ToString();
    }

    /// <summary>
    /// Maps a <see cref="TypeDecl"/> subtype to its coverage kind string, or <c>null</c> for an
    /// unrecognized subtype (which the caller skips). There is no discriminator enum on
    /// <see cref="TypeDecl"/>, so this pattern-matches the concrete record.
    /// </summary>
    private static string? KindOf(TypeDecl decl) => decl switch
    {
        ValueObjectDecl => "value",
        EntityDecl => "entity",
        AggregateDecl => "aggregate",
        EnumDecl => "enum",
        EventDecl => "event",
        IntegrationEventDecl => "integrationEvent",
        ReadModelDecl => "readModel",
        QueryDecl => "query",
        _ => null
    };
}

/// <summary>
/// The serialization shape for <see cref="ModelCoverage.ToJson"/>: the report's rollups plus its items.
/// A concrete type (not an anonymous one) so the source-generated <see cref="CoverageJson"/> context can
/// serialize it without reflection — keeps the trimmed WebAssembly build free of IL2026 warnings.
/// </summary>
internal sealed record CoverageJsonDto(
    string Target, int Total, int Covered, bool IsComplete, IReadOnlyList<CoverageItem> Items);

/// <summary>
/// Source-generated JSON context for <see cref="CoverageJsonDto"/>. <see cref="CoverageState"/> is rendered
/// as its name (e.g. <c>"Covered"</c>) and the output is indented, matching the previous reflection-based
/// serialization byte-for-byte.
/// </summary>
[JsonSourceGenerationOptions(WriteIndented = true, UseStringEnumConverter = true)]
[JsonSerializable(typeof(CoverageJsonDto))]
internal sealed partial class CoverageJson : JsonSerializerContext;
