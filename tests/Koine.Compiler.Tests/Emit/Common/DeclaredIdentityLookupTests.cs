using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The shared, context-aware "is this entity's identity type already declared as a <c>value</c> in
/// its own context?" decision (#1848): every code emitter's identity-synthesis site must consult this
/// before minting a conventional identity wrapper, or an explicitly declared <c>value OrderId { … }</c>
/// used as <c>identified by OrderId</c> is emitted TWICE. Routed entirely through
/// <see cref="ModelIndex.TryGetDeclIn"/> — the one context-aware resolution seam every emitter already
/// shares — so a same-named value object declared in a SIBLING context (the #1834/#1816 trap) must
/// NOT suppress synthesis it shouldn't.
/// </summary>
public class DeclaredIdentityLookupTests
{
    private static ModelIndex IndexOf(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        model.ShouldNotBeNull(string.Join("\n", diagnostics.Select(d => d.ToString())));
        return new ModelIndex(model);
    }

    [Fact]
    public void True_when_the_id_is_declared_as_a_value_object_in_its_own_context()
    {
        var index = IndexOf("""
            context Ordering {
              value OrderId { value: String }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """);

        DeclaredIdentityValueObject.IsDeclaredIn(index, "Ordering", "OrderId").ShouldBeTrue();
    }

    [Fact]
    public void False_when_a_same_named_value_object_is_declared_only_in_a_sibling_context()
    {
        // The #1834/#1816 trap: `OrderId` IS declared somewhere in the model, but not in `Ordering`
        // (no import, no map-permit) — so it must NOT suppress `Ordering`'s synthesis.
        var index = IndexOf("""
            context Ordering {
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }

            context Billing {
              value OrderId { value: String }
            }
            """);

        DeclaredIdentityValueObject.IsDeclaredIn(index, "Ordering", "OrderId").ShouldBeFalse();
    }

    [Fact]
    public void False_when_the_id_is_not_declared_anywhere()
    {
        var index = IndexOf("""
            context Ordering {
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  shipped: Bool = false
                }
              }
            }
            """);

        DeclaredIdentityValueObject.IsDeclaredIn(index, "Ordering", "OrderId").ShouldBeFalse();
    }
}
