// ---------------------------------------------------------------------------------------------
// Shared-helper decision for the result/emit hoist (issue #1838) — RECORDED, not re-litigated.
//
// The port added a `ResultHoist` static helper to `src/Koine.Emit.Common` holding exactly
// two things:
//   (a) the `__result` local-name constant, and
//   (b) the Ordinal WHOLE-argument matcher — a rendered argument participates in the hoist only
//       when it is string-equal (Ordinal) to the rendered result expression, NEVER when it merely
//       contains it as a substring.
// Each emitter keeps its own target-specific rendering AND its own binding syntax (`var __result =`,
// `const __result =`, `$__result =`, `let __result =`, `__result =`, …).
//
// Rationale: the match is performed on the *rendered target string*, so only the DECISION is
// shareable — the rendering is not. That is the same split already used by the
// `BranchReconciliation`, `FactoryIdBinding` and `RouteDerivation` helpers in that assembly:
// the neutral policy lives in Koine.Emit.Common, the syntax stays in Koine.Emit.<Target>.
//
// Caveat to verify later — PRE-EXISTING and OUT OF SCOPE here: no emitter guards `__result` against
// colliding with a model-derived identifier (a gap the C# and TypeScript emitters already had, which
// the port inherits rather than introduces). The Koine lexer allows leading underscores, so a
// member/parameter literally named `__result` would shadow (or be shadowed by) the hoisted local.
// That gap predates this issue and will be filed separately rather than fixed here.
// ---------------------------------------------------------------------------------------------

using System.Text;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1838 — when a command's <c>result</c> expression is ALSO a whole <c>emit</c>/<c>publish</c>
/// payload argument, every code emitter must evaluate it EXACTLY ONCE. Rendering the expression twice
/// is a correctness defect, not a style nit: for a non-deterministic expression such as Koine's
/// <c>now</c>, the recorded event payload and the returned value are read from the clock at two
/// different instants and can DISAGREE.
/// </summary>
/// <remarks>
/// <para>
/// All seven code emitters hoist the shared expression into a single <c>__result</c> local, bound after
/// the invariant re-check and before the event recording — C# and TypeScript always did; Python, PHP,
/// Rust, Java and Kotlin were ported in #1838. This suite is the executable statement of the contract
/// for all seven at once, so no target can silently drop back to re-rendering the expression.
/// </para>
/// <para>
/// It asserts the emitted TEXT. Its behavioral counterpart is
/// <see cref="Conformance.ResultHoistRuntimeTests"/>, which EXECUTES the emitted code on the five
/// targets whose conformance harness runs it and demands that the recorded event payload equal the
/// returned value.
/// </para>
/// <para>The fixture below covers four sub-shapes in one model:</para>
/// <list type="table">
///   <item><term>(a) <c>closeWithEmit</c></term>
///     <description><c>emit</c> + <c>result</c> share one expression.</description></item>
///   <item><term>(b) <c>closeWithPublish</c></term>
///     <description><c>publish</c> + <c>result</c> share one expression.</description></item>
///   <item><term>(c) <c>closeBoth</c></term>
///     <description><c>emit</c> AND <c>publish</c> AND <c>result</c> all share it — ONE local must
///     serve all three, so the domain event, the integration event and the return value carry the
///     identical instant.</description></item>
///   <item><term>(d) <c>quote</c></term>
///     <description>a sibling argument whose rendering SHARES THE RESULT'S PREFIX
///     (<c>taxRate</c> vs a <c>tax</c> result) must be left intact — the match is per-argument and
///     exact, never a substring. A blind substring replace would splice <c>__resultRate</c> into the
///     payload and the generated code would not compile. This mirrors the existing regression
///     fixture in <c>Conformance/CrossEmitterConformanceTests</c> (<c>QuoteModel</c>).</description></item>
/// </list>
/// <para>
/// Plus two negative shapes so the port cannot OVER-substitute: <c>touch</c> (an <c>emit</c> with no
/// <c>result</c> at all) and <c>computeSpread</c> (a <c>result</c> shared with NO payload argument);
/// neither may introduce a local.
/// </para>
/// <para>
/// Assertions count the target's own rendering of <c>now</c> INSIDE THE COMMAND METHOD BODY only —
/// never over the whole file, where a constructor or another member could legitimately read the
/// clock. Every rendering in <see cref="Profiles"/> was read off real emitter output, not guessed.
/// </para>
/// </remarks>
public class ResultHoistParityTests
{
    /// <summary>The hoisted local every emitter binds; its absence is what the negative cases assert.</summary>
    private const string HoistedLocal = "__result";

    /// <summary>
    /// One model, six commands: the four hoisting sub-shapes (a)–(d) and the two negatives. <c>now</c>
    /// is the shared expression on purpose — it is the observable non-deterministic case that turns a
    /// duplicated rendering into two disagreeing readings of the clock.
    /// </summary>
    private const string Source = """
        context Sales {
          publishes Settled

          integration event Settled {
            at: Instant
          }

          aggregate Ordering root Order {
            event ClosedInternally { at: Instant }
            event Quoted { amount: Int  rate: Int }

            entity Order identified by OrderId {
              tax:     Int = 0
              taxRate: Int = 0

              command closeWithEmit: Instant {
                emit ClosedInternally(at: now)
                result now
              }

              command closeWithPublish: Instant {
                publish Settled(at: now)
                result now
              }

              command closeBoth: Instant {
                emit ClosedInternally(at: now)
                publish Settled(at: now)
                result now
              }

              command quote: Int {
                emit Quoted(amount: tax, rate: taxRate)
                result tax
              }

              command touch {
                emit ClosedInternally(at: now)
              }

              command computeSpread: Int {
                emit Quoted(amount: tax, rate: taxRate)
                result tax + taxRate
              }
            }
          }
        }
        """;

    /// <summary>Everything that differs per backend, so the assertions themselves stay target-neutral.</summary>
    /// <param name="Id">The registry target id.</param>
    /// <param name="CreateEmitter">Builds the backend under test.</param>
    /// <param name="EntityFileSuffix">Path suffix of the emitted file that carries the <c>Order</c> commands.</param>
    /// <param name="ClockRead">This target's rendering of Koine's <c>now</c> — the string that must appear ONCE.</param>
    /// <param name="MethodName">Maps a Koine command name to this target's method-name casing.</param>
    /// <param name="SiblingArgTail">The prefix-sharing sibling argument, rendered in FULL and closing the call.</param>
    /// <param name="UnsharedResult">This target's rendering of the unshared <c>tax + taxRate</c> result.</param>
    private sealed record TargetProfile(
        string Id,
        Func<IEmitter> CreateEmitter,
        string EntityFileSuffix,
        string ClockRead,
        Func<string, string> MethodName,
        string SiblingArgTail,
        string UnsharedResult);

    private static readonly IReadOnlyDictionary<string, TargetProfile> Profiles =
        new TargetProfile[]
        {
            new("csharp", () => new CSharpEmitter(), "/Order.cs",
                "DateTimeOffset.UtcNow", Pascal,
                ", TaxRate)", "Tax + TaxRate"),
            new("typescript", () => new TypeScriptEmitter(), "/Order.ts",
                "Instant.now()", Camel,
                ", this.taxRate)", "this.tax + this.taxRate"),
            new("python", () => new PythonEmitter(), "/order.py",
                "Instant.now()", Snake,
                "rate=self.tax_rate)", "self.tax + self.tax_rate"),
            new("php", () => new PhpEmitter(), "/Order.php",
                @"new \DateTimeImmutable('now')", Camel,
                ", $this->taxRate)", "$this->tax + $this->taxRate"),
            new("rust", () => new RustEmitter(), "/sales.rs",
                "crate::koine_runtime::now()", Snake,
                ", self.tax_rate)", "self.tax + self.tax_rate"),
            new("java", () => new JavaEmitter(), "/Order.java",
                "java.time.Instant.now()", Camel,
                ", this.taxRate)", "this.tax + this.taxRate"),
            new("kotlin", () => new KotlinEmitter(), "/Order.kt",
                "java.time.Instant.now()", Camel,
                ", this.taxRate)", "this.tax + this.taxRate"),
        }.ToDictionary(p => p.Id, StringComparer.Ordinal);

    public static TheoryData<string> AllTargets()
    {
        var data = new TheoryData<string>();
        foreach (var id in Profiles.Keys)
        {
            data.Add(id);
        }

        return data;
    }

    // ---- (a) emit + result --------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(AllTargets))]
    public void A_result_shared_with_an_emit_payload_reads_the_clock_once(string target)
    {
        TargetProfile profile = Profiles[target];
        var body = CommandBody(profile, "closeWithEmit");

        Occurrences(body, profile.ClockRead).ShouldBe(1, Because(target, "closeWithEmit", body));
    }

    // ---- (b) publish + result -----------------------------------------------------------------

    [Theory]
    [MemberData(nameof(AllTargets))]
    public void A_result_shared_with_a_publish_payload_reads_the_clock_once(string target)
    {
        TargetProfile profile = Profiles[target];
        var body = CommandBody(profile, "closeWithPublish");

        Occurrences(body, profile.ClockRead).ShouldBe(1, Because(target, "closeWithPublish", body));
    }

    // ---- (c) emit + publish + result, one local ------------------------------------------------

    [Theory]
    [MemberData(nameof(AllTargets))]
    public void A_result_shared_with_both_an_emit_and_a_publish_payload_reads_the_clock_once(string target)
    {
        TargetProfile profile = Profiles[target];
        var body = CommandBody(profile, "closeBoth");

        // ONE local serves the domain event, the integration event AND the return: three readings of
        // `now` here would let the two recorded events and the caller disagree about the instant.
        Occurrences(body, profile.ClockRead).ShouldBe(1, Because(target, "closeBoth", body));
    }

    // ---- (d) the prefix-sharing sibling ---------------------------------------------------------

    [Theory]
    [MemberData(nameof(AllTargets))]
    public void A_sibling_argument_sharing_the_results_prefix_is_never_rewritten(string target)
    {
        TargetProfile profile = Profiles[target];
        var body = CommandBody(profile, "quote");

        // `taxRate` renders with the `tax` result's rendering as a PREFIX. The match is per whole
        // argument, so the sibling must survive verbatim and close the constructor call untouched.
        body.ShouldContain(profile.SiblingArgTail, Case.Sensitive, Because(target, "quote", body));

        // What a substring splice would produce, in either casing convention.
        body.ShouldNotContain("__resultRate", Case.Sensitive, Because(target, "quote", body));
        body.ShouldNotContain("__result_rate", Case.Sensitive, Because(target, "quote", body));
    }

    // ---- negatives: the hoist must not over-substitute -----------------------------------------

    [Theory]
    [MemberData(nameof(AllTargets))]
    public void A_command_with_an_emit_but_no_result_introduces_no_local(string target)
    {
        TargetProfile profile = Profiles[target];
        var body = CommandBody(profile, "touch");

        body.ShouldNotContain(HoistedLocal, Case.Sensitive, Because(target, "touch", body));
        Occurrences(body, profile.ClockRead).ShouldBe(1, Because(target, "touch", body));
    }

    [Theory]
    [MemberData(nameof(AllTargets))]
    public void A_result_shared_with_no_payload_argument_stays_inline(string target)
    {
        TargetProfile profile = Profiles[target];
        var body = CommandBody(profile, "computeSpread");

        // `tax + taxRate` is not a whole argument of the emitted payload, so nothing is hoisted and
        // the result renders inline at the return — while both payload arguments stay untouched.
        body.ShouldNotContain(HoistedLocal, Case.Sensitive, Because(target, "computeSpread", body));
        body.ShouldContain(profile.UnsharedResult, Case.Sensitive, Because(target, "computeSpread", body));
        body.ShouldContain(profile.SiblingArgTail, Case.Sensitive, Because(target, "computeSpread", body));
    }

    // ---- drift guard ----------------------------------------------------------------------------

    [Fact]
    public void Every_code_target_the_registry_offers_is_covered_by_this_suite()
    {
        // A new code backend must be added to Profiles too, or it would silently ship the defect.
        // Only the non-code targets (documentation / API specs) are legitimately absent.
        string[] nonCode = { "glossary", "docs", "asyncapi", "openapi" };

        new EmitterRegistry(BuiltInEmitterProviders.All).SupportedTargets
            .Except(nonCode, StringComparer.Ordinal)
            .ShouldBe(Profiles.Keys, ignoreOrder: true);
    }

    // ---- helpers ---------------------------------------------------------------------------------

    /// <summary>Compiles <see cref="Source"/> with <paramref name="profile"/>'s backend and returns the entity file.</summary>
    private static string EmitEntityFile(TargetProfile profile)
    {
        CompileResult result = new KoineCompiler().Compile(Source, profile.CreateEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return result.Files
            .Single(f => f.RelativePath.EndsWith(profile.EntityFileSuffix, StringComparison.Ordinal))
            .Contents;
    }

    /// <summary>The body of <paramref name="command"/> as emitted for <paramref name="profile"/>'s target.</summary>
    private static string CommandBody(TargetProfile profile, string command)
        => MethodBody(EmitEntityFile(profile), profile.MethodName(command) + "(");

    /// <summary>
    /// The lines of the method whose signature line contains <paramref name="signature"/>, using the one
    /// layout rule all seven targets obey: a body is the run of lines indented DEEPER than its signature
    /// line, ending at the first line back at (or above) that indent — the closing brace for the six
    /// brace languages, the next <c>def</c> for Python. An Allman brace alone on the next line belongs to
    /// the header, not the body. Scoping to the body matters: a clock read elsewhere in the file (a
    /// constructor, another command) must not be counted.
    /// </summary>
    private static string MethodBody(string code, string signature)
    {
        var lines = code.Replace("\r\n", "\n").Split('\n');
        var start = Array.FindIndex(lines, l => l.Contains(signature, StringComparison.Ordinal));
        start.ShouldBeGreaterThanOrEqualTo(0, $"no emitted line contains '{signature}':\n{code}");

        var headerIndent = IndentOf(lines[start]);
        var i = start + 1;
        if (i < lines.Length && lines[i].Trim() == "{")
        {
            i++;
        }

        var body = new StringBuilder();
        for (; i < lines.Length; i++)
        {
            if (lines[i].Trim().Length == 0)
            {
                continue;
            }

            if (IndentOf(lines[i]) <= headerIndent)
            {
                break;
            }

            body.Append(lines[i]).Append('\n');
        }

        return body.ToString();
    }

    private static int IndentOf(string line) => line.Length - line.TrimStart().Length;

    /// <summary>Non-overlapping Ordinal occurrences of <paramref name="needle"/>.</summary>
    private static int Occurrences(string haystack, string needle)
    {
        var count = 0;
        for (var i = haystack.IndexOf(needle, StringComparison.Ordinal); i >= 0;
             i = haystack.IndexOf(needle, i + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static string Because(string target, string command, string body)
        => $"{target}: `{command}` must evaluate a shared result expression exactly once. Emitted body:\n{body}";

    private static string Camel(string command) => command;

    private static string Pascal(string command) => char.ToUpperInvariant(command[0]) + command[1..];

    private static string Snake(string command)
        => string.Concat(command.Select(c => char.IsUpper(c) ? "_" + char.ToLowerInvariant(c) : c.ToString()));
}
