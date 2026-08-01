using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R19 — API annotations (@route / @get / @put / @auth) on commands and queries.</summary>
public class R19ApiAnnotationsTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static IReadOnlyList<Emit.EmittedFile> Build(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return result.Files;
    }

    // ---- parsing ------------------------------------------------------------

    [Fact]
    public void Annotations_on_a_command_parse_and_compile()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{id}/place")
                  @put
                  command place {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }
                }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        Build(src);
    }

    [Fact]
    public void Annotations_on_a_query_parse_and_compile()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              @auth("admin")
              @get
              query OrderById(id: OrderId): OrderSummary
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        Build(src);
    }
}
