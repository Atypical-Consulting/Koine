using System.Text.RegularExpressions;
using Koine.Compiler.Emit.Rust;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Regression for issue #315: two smart-enum members that differ only by the case of a NON-leading
/// character (<c>userID</c> vs <c>userId</c>) both snake_case-collapse to the same binding
/// (<c>user_id</c>). The Rust emitter derives each <c>match_</c>/<c>switch</c> closure-parameter name
/// from that snake_case form, so the collision produced two parameters named <c>user_id</c> —
/// non-compiling Rust (<c>E0415</c> identifier bound more than once). The fix de-duplicates the
/// per-enum binding names so each member maps to a distinct, compiling Rust binding.
/// </summary>
public class RustSmartEnumNamingTests
{
    private readonly ITestOutputHelper _output;

    public RustSmartEnumNamingTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no usable Rust toolchain (cargo, networked) available; cargo check not run.";

    /// <summary>
    /// The minimal repro from #315: an enum with two members distinguished only by an inner
    /// character's case, referenced from a value object.
    /// </summary>
    private const string CollapsingMembersFixture = """
        context Identity {
          enum ActorKind { userID, userId, System }

          value Actor {
            kind:  ActorKind
            label: String
            isUser: Bool = kind != ActorKind.System
          }
        }
        """;

    [Fact]
    public void Smart_enum_members_that_snake_case_collapse_emit_distinct_bindings()
    {
        var result = new KoineCompiler().Compile(CollapsingMembersFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var identity = result.Files
            .Single(f => f.RelativePath.EndsWith("identity.rs", StringComparison.Ordinal)).Contents;

        // Each member contributes one `match_` closure parameter. `userID` and `userId` both
        // snake_case to `user_id`; before the fix that produced two parameters with the same name
        // (non-compiling Rust). The three members must yield three DISTINCT binding names.
        var bindings = Regex.Matches(identity, @"(\w+): impl FnOnce\(\) -> R")
            .Select(m => m.Groups[1].Value)
            .ToList();

        bindings.Count.ShouldBe(3, $"expected three match_ closure parameters, got: {string.Join(", ", bindings)}");
        bindings.Distinct(StringComparer.Ordinal).Count()
            .ShouldBe(bindings.Count, $"bindings must be injective, got: {string.Join(", ", bindings)}");
    }

    [Fact]
    public void Smart_enum_with_collapsing_members_compiles()
    {
        var result = new KoineCompiler().Compile(CollapsingMembersFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
