using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// A <c>Set&lt;T&gt;</c> maps to <c>ReadonlySet&lt;T&gt;</c> and a <c>Map&lt;K,V&gt;</c> to
/// <c>ReadonlyMap&lt;K,V&gt;</c> — neither of which exposes the JS <b>Array</b> surface
/// (<c>every</c>/<c>some</c>/<c>map</c>/<c>reduce</c>/<c>includes</c>/<c>length</c>). The TypeScript
/// emitter must therefore lower collection ops on a Set/Map receiver to a Set/Map-correct form, not
/// blindly to Array methods, or the emitted <c>.ts</c> fails <c>tsc --strict</c> (TS2339/TS7006) and
/// throws at runtime. This locks the fix for the shared defect behind issues #608 (lambda/aggregate
/// ops), #607 (<c>contains</c>), and #606 (<c>isEmpty</c>/<c>isNotEmpty</c>):
/// <list type="bullet">
///   <item>lambda/aggregate ops on a Set normalize the receiver to an array (<c>[...this.tags]</c>);</item>
///   <item><c>contains</c> on a Set emits <c>.has(x)</c> (not <c>.includes</c>);</item>
///   <item><c>isEmpty</c>/<c>isNotEmpty</c> on a Set/Map emit <c>.size</c> (not <c>.length</c>).</item>
/// </list>
/// List/String receivers keep the Array/string forms unchanged.
/// </summary>
public class TypeScriptCollectionOpsTests
{
    // A value object whose derived members exercise every collection op over a Set, a Map, and (as a
    // regression baseline) a List. `scores: Set<Int>` drives the numeric aggregates min/max/sum.
    private const string Fixture = """
        context D {
          value T {
            tags:   Set<String>
            scores: Set<Int>
            counts: Map<String, Int>
            items:  List<String>

            allOk:      Bool = tags.all(t => t.length > 0)
            anyOk:      Bool = tags.any(t => t.length > 0)
            noneOk:     Bool = tags.none(t => t.length > 0)
            hasX:       Bool = tags.contains("x")
            emptyS:     Bool = tags.isEmpty
            notEmptyS:  Bool = tags.isNotEmpty
            emptyM:     Bool = counts.isEmpty
            notEmptyM:  Bool = counts.isNotEmpty
            distinctT:  Bool = tags.distinctBy(t => t)
            maxScore:   Int  = scores.max(s => s)
            minScore:   Int  = scores.min(s => s)
            totalScore: Int  = scores.sum(s => s)

            allItems:   Bool = items.all(i => i.length > 0)
            hasItem:    Bool = items.contains("x")
            emptyL:     Bool = items.isEmpty
          }
        }
        """;

    private static string CompileTs()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath == "D/value-objects/T.ts").Contents;
    }

    [Fact]
    public void Set_lambda_ops_normalize_the_receiver_to_an_array()
    {
        var ts = CompileTs();
        // all/any/none over a Set spread it to an array first, so the Array methods exist.
        ts.ShouldContain("[...this.tags].every((t) => (t.length > 0))");
        ts.ShouldContain("[...this.tags].some((t) => (t.length > 0))");
        ts.ShouldContain("![...this.tags].some((t) => (t.length > 0))");
        // The bug: Array methods called straight on a ReadonlySet.
        ts.ShouldNotContain("this.tags.every(");
        ts.ShouldNotContain("this.tags.some(");
    }

    [Fact]
    public void Set_aggregate_ops_normalize_the_receiver_to_an_array()
    {
        var ts = CompileTs();
        // min/max over a Set normalize the receiver to an array, then guard emptiness and fold with a
        // seedless reduce (issue #610) — never a bare `Math.min/max(...spread)`, which returns
        // ±Infinity on empty. sum keeps its neutral-zero reduce.
        ts.ShouldContain("([...this.scores].map((s) => s) as readonly number[]).length === 0");
        ts.ShouldContain("[...this.scores].map((s) => s).reduce((__mm0a, __mm0b) => Math.max(__mm0a, __mm0b))");
        ts.ShouldContain("[...this.scores].map((s) => s).reduce((__mm1a, __mm1b) => Math.min(__mm1a, __mm1b))");
        ts.ShouldContain("[...this.scores].map((s) => s).reduce((a, b) => a + b, 0)");
        ts.ShouldNotContain("this.scores.map(");
        // The old, unguarded spread form is gone (issue #610).
        ts.ShouldNotContain("Math.max(...");
        ts.ShouldNotContain("Math.min(...");
    }

    [Fact]
    public void Set_distinctBy_normalizes_the_receiver_to_an_array()
    {
        var ts = CompileTs();
        ts.ShouldContain("new Set([...this.tags].map((t) => t)).size === [...this.tags].length");
        ts.ShouldNotContain("=== this.tags.length");
    }

    [Fact]
    public void Set_contains_emits_has_not_includes()
    {
        var ts = CompileTs();
        ts.ShouldContain("this.tags.has('x')");
        ts.ShouldNotContain("this.tags.includes(");
    }

    [Fact]
    public void Set_and_Map_emptiness_emit_size_not_length()
    {
        var ts = CompileTs();
        ts.ShouldContain("this.tags.size === 0");
        ts.ShouldContain("this.tags.size !== 0");
        ts.ShouldContain("this.counts.size === 0");
        ts.ShouldContain("this.counts.size !== 0");
        ts.ShouldNotContain("this.tags.length");
        ts.ShouldNotContain("this.counts.length");
    }

    [Fact]
    public void List_receivers_keep_array_and_length_forms_unchanged()
    {
        var ts = CompileTs();
        // A List maps to readonly T[], so the Array/length forms are correct and must not change.
        ts.ShouldContain("this.items.every((i) => (i.length > 0))");
        ts.ShouldContain("this.items.includes('x')");
        ts.ShouldContain("this.items.length === 0");
        // No spread normalization for a List receiver.
        ts.ShouldNotContain("[...this.items]");
    }
}
