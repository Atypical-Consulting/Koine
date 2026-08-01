using System.Reflection;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1756: a value object whose <c>invariant</c> references a <b>derived</b> member used to emit
/// the member's bare camelCase name. A derived member has no constructor parameter — it is a get-only
/// property computed from the stored ones — so the guard bound to nothing (<c>CS0103</c>) and the
/// shipped <c>templates/saas-subscription</c> emitted C# that did not compile.
/// <para>
/// These are Roslyn <b>compile-and-execute</b> meta-tests on purpose: the snapshot suites happily
/// captured the broken text for months without noticing, so the decisive assertion is that the emitted
/// C# compiles AND that the guard evaluates the derivation correctly — the fix substitutes the
/// derived member's defining expression over the constructor parameters, keeping the emitter's
/// deliberate validate-before-assign ordering.
/// </para>
/// </summary>
public class DerivedMemberInvariantTests
{
    /// <summary>The issue's minimal reproduction: an invariant over a single derived member.</summary>
    private const string UsageMeterFixture = """
        context Subscription {
          value UsageMeter {
            includedQuota: Int
            consumed:      Int
            overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
            invariant overage >= 0   "overage can never be negative"
          }
        }
        """;

    /// <summary>A derived member defined over another derived member — substitution must recurse.</summary>
    private const string ChainedFixture = """
        context Subscription {
          value Ledger {
            gross:  Int
            rate:   Int
            net:    Int = gross - rate
            doubled: Int = net * 2
            invariant doubled > 0   "doubled net stays positive"
          }
        }
        """;

    /// <summary>An entity carrying the same shape — its guards run after assignment, over properties.</summary>
    private const string EntityFixture = """
        context Subscription {
          aggregate Metering root Meter {
            entity Meter identified by MeterId {
              includedQuota: Int
              consumed:      Int
              overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
              invariant overage >= 0   "overage can never be negative"
            }
          }
        }
        """;

    private static Assembly CompileFixture(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm!;
    }

    [Fact]
    public void Value_object_invariant_over_a_derived_member_compiles()
    {
        Assembly asm = CompileFixture(UsageMeterFixture);
        asm.GetType("Subscription.UsageMeter").ShouldNotBeNull();
    }

    [Fact]
    public void Value_object_invariant_over_a_derived_member_evaluates_the_derivation()
    {
        Assembly asm = CompileFixture(UsageMeterFixture);
        Type meter = asm.GetType("Subscription.UsageMeter")!;

        // The derivation is non-negative for every input, so construction always succeeds — and the
        // derived property must agree with what the guard computed over the constructor parameters.
        object underQuota = Activator.CreateInstance(meter, new object[] { 100, 40 })!;
        meter.GetProperty("Overage")!.GetValue(underQuota).ShouldBe(0);

        object overQuota = Activator.CreateInstance(meter, new object[] { 100, 175 })!;
        meter.GetProperty("Overage")!.GetValue(overQuota).ShouldBe(75);
    }

    [Fact]
    public void Chained_derived_members_substitute_recursively()
    {
        Assembly asm = CompileFixture(ChainedFixture);
        Type ledger = asm.GetType("Subscription.Ledger")!;

        object ok = Activator.CreateInstance(ledger, new object[] { 10, 4 })!;
        ledger.GetProperty("Doubled")!.GetValue(ok).ShouldBe(12);

        // gross - rate = -1 -> doubled = -2, so the guard must reject it *before* assignment.
        TargetInvocationException ex = Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(ledger, new object[] { 3, 4 }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Entity_invariant_over_a_derived_member_compiles()
    {
        Assembly asm = CompileFixture(EntityFixture);
        asm.GetType("Subscription.Meter").ShouldNotBeNull();
    }
}
