using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// PHP emitter — the <c>now</c> built-in (issue #395). Koine's nullary <c>now</c> value op must
/// render to a valid, dependency-free PHP 8.1 timestamp expression
/// (<c>new \DateTimeImmutable('now')</c>, matching the <c>Instant</c> → <c>\DateTimeImmutable</c>
/// type mapping), never the undefined variable <c>$now</c> the bare-identifier fall-through emitted.
/// Mirrors the C# (<c>DateTimeOffset.UtcNow</c>) / Python / TypeScript (<c>Instant.now()</c>)
/// nullary-value-op tables.
/// </summary>
public class PhpNowBuiltinTests
{
    /// <summary>
    /// An entity command that stamps a timestamp field with <c>now</c>. Emitted PHP must assign a
    /// real timestamp expression — the original defect emitted <c>$this-&gt;startedAt = $now;</c>
    /// (an undefined variable that leaves the field silently null under strict types).
    /// </summary>
    private const string EntityCommandFixture = """
        context Scheduling {
          enum MeetingStatus { Draft, Started }

          aggregate Scheduling root Meeting {
            entity Meeting identified by MeetingId {
              status:    MeetingStatus = Draft
              startedAt: Instant?

              /// Start the meeting, stamping the time.
              command start {
                requires status == Draft   "only a draft meeting can start"
                status    -> Started
                startedAt -> now
              }
            }
          }
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    [Fact]
    public void Command_assigning_now_emits_a_real_timestamp_expression()
    {
        var files = Emit(EntityCommandFixture);
        var meeting = files.Single(f => f.Contents.Contains("$this->startedAt ="));

        // `now` maps to the dependency-free stdlib timestamp matching the `Instant` type hint.
        meeting.Contents.ShouldContain(@"$this->startedAt = new \DateTimeImmutable('now');");
    }

    [Fact]
    public void Command_assigning_now_never_emits_the_undefined_variable()
    {
        var files = Emit(EntityCommandFixture);
        var meeting = files.Single(f => f.Contents.Contains("$this->startedAt ="));

        // Regression guard for issue #395: the bare-identifier fall-through rendered `$now`.
        meeting.Contents.ShouldNotContain("$now");
    }

    [Fact]
    public void Bare_now_identifier_translates_to_the_php_timestamp_expression()
    {
        var result = new KoineCompiler().Compile(EntityCommandFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var index = new SemanticModel(model).Index;
        var translator = new PhpExpressionTranslator(
            index, members: [], index.EnumMemberToType, context: "Scheduling");

        translator.Translate(new IdentifierExpr("now")).ShouldBe(@"new \DateTimeImmutable('now')");
    }
}
