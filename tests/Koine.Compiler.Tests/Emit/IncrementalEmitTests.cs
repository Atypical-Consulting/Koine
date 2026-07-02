using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #71, Task 9 — the content-addressed incremental emit cache on <see cref="KoineCompiler"/>.
/// Repeated compiles of unchanged input on the SAME compiler reuse the previously-emitted files
/// (the emitter's <c>Emit</c> runs ONCE); any change to the model OR the emitter's options busts the
/// cache and re-emits. Crucially, cached output is byte-for-byte identical to a single cold emit.
/// </summary>
public class IncrementalEmitTests
{
    /// <summary>A multi-context model (cross-context references) to prove whole-model caching is safe.</summary>
    private const string MultiContext = """
        context Catalog {
          value Sku {
            code: String
            invariant code != ""   "sku code is required"
          }
        }

        context Ordering {

          value Money {
            amount:   Decimal
            currency: String
            invariant amount >= 0   "amount cannot be negative"
          }

          enum OrderStatus { Draft, Placed, Cancelled }

          aggregate Order root Order {

            event OrderPlaced {
              orderId: OrderId
              total:   Money
            }

            entity Order identified by OrderId {
              total:  Money
              status: OrderStatus = Draft

              invariant total.amount >= 0   "order total cannot be negative"

              states status {
                Draft  -> Placed, Cancelled
                Placed
                Cancelled
              }

              command place {
                requires status == Draft   "order must be a draft to place"
                status -> Placed
                emit OrderPlaced(orderId: id, total: total)
              }
            }
          }
        }
        """;

    /// <summary>An <see cref="IEmitter"/> decorator that counts how many times the inner emit actually runs.</summary>
    private sealed class CountingEmitter(IEmitter inner) : IEmitter
    {
        public int EmitCount { get; private set; }

        public string TargetName => inner.TargetName;

        // The cache key must include the inner emitter's discriminator, so delegate to it.
        public string CacheDiscriminator => inner.CacheDiscriminator;

        public IReadOnlyList<EmittedFile> Emit(KoineModel model) => Emit(model, null);

        public IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic)
        {
            EmitCount++;
            return inner.Emit(model, semantic);
        }
    }

    private static SourceFile[] Sources(string text) => [new SourceFile("model.koi", text)];

    [Fact]
    public void RepeatedCompileOfUnchangedInputEmitsOnce()
    {
        var compiler = new KoineCompiler();
        var emitter = new CountingEmitter(new CSharpEmitter());
        var files = Sources(MultiContext);

        var first = compiler.Compile(files, emitter);
        var second = compiler.Compile(files, emitter);

        first.Success.ShouldBeTrue();
        second.Success.ShouldBeTrue();

        // The second compile was a cache hit: the underlying emitter ran exactly once...
        emitter.EmitCount.ShouldBe(1);

        // ...and the second result reused the exact same EmittedFile instances.
        second.Files.ShouldBeSameAs(first.Files);
    }

    [Fact]
    public void ModelChangeBustsTheCacheAndReEmits()
    {
        var compiler = new KoineCompiler();
        var emitter = new CountingEmitter(new CSharpEmitter());

        compiler.Compile(Sources(MultiContext), emitter);
        emitter.EmitCount.ShouldBe(1);

        // A different model => different content address => re-emit.
        var changed = MultiContext.Replace("currency: String", "currency: String\n    code: String");
        var result = compiler.Compile(Sources(changed), emitter);

        result.Success.ShouldBeTrue();
        emitter.EmitCount.ShouldBe(2);
    }

    [Fact]
    public void EmitterOptionToggleBustsTheCacheAndOutputDiffers()
    {
        var compiler = new KoineCompiler();
        var files = Sources(MultiContext);

        var full = new CountingEmitter(new CSharpEmitter(CSharpEmitterOptions.Empty));
        var refOnly = new CountingEmitter(
            new CSharpEmitter(CSharpEmitterOptions.Empty with { ReferenceOnly = true }));

        var fullResult = compiler.Compile(files, full);
        var refResult = compiler.Compile(files, refOnly);

        // Same model, different option => different discriminator => the second emit was NOT a hit.
        full.EmitCount.ShouldBe(1);
        refOnly.EmitCount.ShouldBe(1);

        // And the two outputs differ appropriately (reference-only strips bodies).
        TestSupport.Render(fullResult.Files)
            .ShouldNotBe(TestSupport.Render(refResult.Files));
    }

    [Fact]
    public void CachedOutputIsByteIdenticalToAColdEmit()
    {
        var files = Sources(MultiContext);

        // Cold: a fresh compiler + fresh emitter, single emit.
        var cold = new KoineCompiler().Compile(files, new CSharpEmitter());

        // Warm: a reused compiler whose second compile is a cache hit.
        var warmCompiler = new KoineCompiler();
        warmCompiler.Compile(files, new CSharpEmitter());
        var warm = warmCompiler.Compile(files, new CSharpEmitter());

        cold.Success.ShouldBeTrue();
        warm.Success.ShouldBeTrue();

        warm.Files.Count.ShouldBe(cold.Files.Count);
        var coldByPath = cold.Files.OrderBy(f => f.RelativePath, StringComparer.Ordinal).ToList();
        var warmByPath = warm.Files.OrderBy(f => f.RelativePath, StringComparer.Ordinal).ToList();
        for (var i = 0; i < coldByPath.Count; i++)
        {
            warmByPath[i].RelativePath.ShouldBe(coldByPath[i].RelativePath);
            warmByPath[i].Contents.ShouldBe(coldByPath[i].Contents);
        }
    }

    [Fact]
    public void DifferentModelsOnTheSameCompilerDoNotCollide()
    {
        // The key must discriminate models, so reusing one compiler across two different models
        // returns each model's own (correct) output, never the first model's cached files.
        var compiler = new KoineCompiler();
        var emitter = new CSharpEmitter();

        var other = """
            context Other {
              value Name {
                text: String
                invariant text != ""   "name is required"
              }
            }
            """;

        var a = compiler.Compile(Sources(MultiContext), emitter);
        var b = compiler.Compile(Sources(other), emitter);

        TestSupport.Render(a.Files).ShouldContain("Catalog");
        TestSupport.Render(b.Files).ShouldContain("Other");
        TestSupport.Render(b.Files).ShouldNotContain("namespace Catalog");
    }
}
