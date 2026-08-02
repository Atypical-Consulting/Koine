using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1870, the Round-2 C#-emitter site: <c>CSharpEmitter.Infrastructure.CollectAggregateEnumTypes</c>
/// decides which smart enums a context's aggregates persist — and therefore which
/// <c>&lt;Context&gt;ValueConverters</c> entries exist — but asked <see cref="Ast.ModelIndex"/> through the
/// FLAT <c>Classify(string)</c> overload even though the owning <c>context</c> is a parameter of that very
/// method (it already uses it two branches later, for the value-object recursion). R13.2 lets two contexts
/// declare a type with the same simple name, so the converter set silently depended on <c>.koi</c> source
/// order.
/// </summary>
/// <remarks>
/// <para>The fixture ships in BOTH context declaration orders and asserts the SAME converter holder in
/// each — a one-order test proves only that the last-declared context happened to be the right one.</para>
/// <para>The converter holder is only half the story: <c>&lt;Root&gt;Configuration</c> is what REFERENCES
/// the converter, and it dispatches on <c>CSharpEmitter.ClassifyMember</c>. While that consumer stayed
/// flat, producer and consumer disagreed — the converter file was emitted while the configuration mapped
/// the very same smart enum as an empty <c>OwnsOne</c>, leaving the new converter dead. So the mapping
/// LINE is asserted here too, under both orders.</para>
/// </remarks>
public class CSharpValueConverterContextScopeTests
{
    /// <summary>The colliding context: it declares <c>Status</c> as a <c>value</c>, which wins the flat
    /// table whenever this context is declared last.</summary>
    private const string ZetaStatusValue = """
        context Zeta {
          value Status { code: String }
        }
        """;

    /// <summary>
    /// <c>Alpha</c> persists a smart-enum member, so its infrastructure layer needs an
    /// <c>AlphaValueConverters.StatusConverter</c>. Classified flat with <c>Zeta</c> declared last,
    /// <c>Status</c> reads as a value object and NO converter holder is emitted at all.
    /// </summary>
    private const string AlphaPersistsEnum = """
        context Alpha {
          enum Status { Draft, Active }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              lifecycle: Status
            }
          }
        }
        """;

    private static string Model(bool zetaLast) =>
        zetaLast ? AlphaPersistsEnum + "\n\n" + ZetaStatusValue : ZetaStatusValue + "\n\n" + AlphaPersistsEnum;

    /// <summary>The converter holder only exists in the opt-in EF Core Infrastructure layer (#128).</summary>
    private static readonly CSharpEmitterOptions Infrastructure = new(
        new Dictionary<string, string>(StringComparer.Ordinal),
        Layers: new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Infrastructure });

    private static IReadOnlyList<EmittedFile> EmitAll(string source)
    {
        CompileResult result = new KoineCompiler().Compile(source, new CSharpEmitter(Infrastructure));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Persisted_smart_enum_converters_are_collected_in_the_contexts_own_scope(bool zetaLast)
    {
        IReadOnlyList<EmittedFile> files = EmitAll(Model(zetaLast));

        EmittedFile converters = files
            .Where(f => f.RelativePath.EndsWith("/AlphaValueConverters.cs", StringComparison.Ordinal))
            .ShouldHaveSingleItem();

        converters.Contents.ShouldContain("ValueConverter<Status, string> StatusConverter");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Persisted_smart_enum_is_mapped_through_its_contexts_converter(bool zetaLast)
    {
        // The consumer half (#1870, review follow-up): WriteMemberMapping dispatches on
        // CSharpEmitter.ClassifyMember. Classified flat with Zeta declared last, `Status` reads as a value
        // object and the configuration emits `builder.OwnsOne(x => x.Lifecycle, lifecycle => { })` — a
        // smart enum mapped as an empty owned entity, with the emitted converter never referenced.
        IReadOnlyList<EmittedFile> files = EmitAll(Model(zetaLast));

        EmittedFile configuration = files
            .Where(f => f.RelativePath.EndsWith("/OrderConfiguration.cs", StringComparison.Ordinal))
            .ShouldHaveSingleItem();

        configuration.Contents.ShouldContain(
            "builder.Property(x => x.Lifecycle).HasConversion(AlphaValueConverters.StatusConverter);");
        configuration.Contents.ShouldNotContain("OwnsOne(x => x.Lifecycle");
    }
}
