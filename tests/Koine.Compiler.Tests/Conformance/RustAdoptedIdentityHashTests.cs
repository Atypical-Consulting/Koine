using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Follow-up to #1848/PR #1869: that fix made a Rust declared, adopted identity value object derive
/// <c>Hash</c> unconditionally, without checking whether its own field types actually support it. A
/// field that is another plain (non-adopted) value object, or a <c>List</c>/<c>Set</c>/<c>Map</c>,
/// breaks the derive. The fix has two parts: <see cref="RustEmitter"/>'s Hash-derive gate (#1848) is
/// extended to propagate transitively to any nested value object reached from an identity (so a
/// FIXABLE case — a nested value object built only from primitives/enums — now actually compiles,
/// see <see cref="Nested_hashable_value_object_identity_emits_and_compiles"/>), while
/// <c>EntityBehaviorValidator.ValidateIdentityHashCompatibility</c> (KOI1108, Semantics/) rejects the
/// UNFIXABLE case — a <c>List</c>/<c>Set</c>/<c>Map</c> anywhere in that graph, which Rust's
/// <c>Vec</c>/<c>HashSet</c>/<c>HashMap</c> can never derive <c>Hash</c> for — before emission ever
/// runs.
/// </summary>
public class RustAdoptedIdentityHashTests
{
    private const string NoToolchainNotice =
        "No usable Rust toolchain (cargo, networked) available; compile not run. " +
        "Install Rust (or set KOINE_CARGO) — CI runs this for real.";

    // The issue's own minimal repro: OrderId is explicitly declared (not synthesized) and its sole
    // field is another plain value object built only from a String.
    private const string NestedHashableIdentityModel = """
        context Ordering {
          value Note { text: String }
          value OrderId { note: Note }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              shipped: Bool = false
            }
          }
        }
        """;

    // A List member reached through the identity's own field graph — never Hash-compatible on
    // Rust, whatever the emitter does, since Vec/HashSet/HashMap never implement Hash.
    private const string CollectionBackedIdentityModel = """
        context Ordering {
          value Tag { text: String }
          value OrderId { tags: List<Tag> }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              shipped: Bool = false
            }
          }
        }
        """;

    /// <summary>
    /// Task 3 — Green: a declared identity whose nested value object is itself built only from
    /// hashable primitives must emit Rust that actually compiles (a real <c>cargo check</c>), not
    /// merely pass semantic validation. Before the RustEmitter fix this failed with
    /// <c>error[E0277]: the trait bound `Note: Hash` is not satisfied</c> — <c>Note</c> derived no
    /// `Hash` at all, since only #1848's adopted-identity gate derived it, and `Note` is never itself
    /// adopted as an identity.
    /// </summary>
    [Fact]
    public void Nested_hashable_value_object_identity_emits_and_compiles()
    {
        var result = new KoineCompiler().Compile(NestedHashableIdentityModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var noteStruct = result.Files.Single(f => f.RelativePath == "src/ordering.rs").Contents;
        noteStruct.ShouldContain("#[derive(Debug, Clone, PartialEq, Eq, Hash)]\npub struct Note {");
        noteStruct.ShouldContain("#[derive(Debug, Clone, PartialEq, Eq, Hash)]\npub struct OrderId {");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Task 2 — a declared identity that reaches a <c>List</c>/<c>Set</c>/<c>Map</c> member (directly
    /// or through a nested value object) is rejected by semantic validation (KOI1108) — emission never
    /// runs, so this can never reach a <c>cargo check</c> failure in the first place.
    /// </summary>
    [Fact]
    public void Collection_backed_identity_is_rejected_before_emission()
    {
        var result = new KoineCompiler().Compile(CollectionBackedIdentityModel, new RustEmitter());

        result.Success.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.IdentityNotHashCompatible);
        result.Files.ShouldBeEmpty();
    }
}
