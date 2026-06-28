using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;
using Koine.Compiler.Tests.Conformance;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression guard for issue #614: PHP — like C# — forbids a required (non-defaulted) constructor
/// parameter after an optional/defaulted one. PHP only <em>deprecates</em> it (so <c>php -l</c>
/// passes), but <c>phpstan analyse --level max</c> fails with <c>parameter.requiredAfterOptional</c>
/// and the silently-dropped default breaks callers that omit it. The emitter must order
/// constructor parameters so every defaulted/optional one comes last (mirroring the C# emitter's
/// <c>OrderCtorParams</c>), and keep the positional <c>new self(...)</c> / event-construction call
/// sites lined up with the reordered signatures.
/// </summary>
public class PhpCtorParamOrderTests
{
    /// <summary>
    /// Returns the text of the <c>__construct(...)</c> parameter list in <paramref name="phpClass"/>
    /// (between <c>__construct(</c> and the closing <c>) {</c>) — scoped so positional checks see only
    /// constructor parameters, not the entity's separately-declared properties.
    /// </summary>
    private static string CtorSignature(string phpClass)
    {
        var ctor = phpClass.IndexOf("__construct(", StringComparison.Ordinal);
        ctor.ShouldBeGreaterThanOrEqualTo(0, "emitted class should declare a constructor");
        var bodyStart = phpClass.IndexOf(") {", ctor, StringComparison.Ordinal);
        bodyStart.ShouldBeGreaterThan(ctor);
        return phpClass[(ctor + "__construct(".Length)..bodyStart];
    }

    /// <summary>
    /// Extracts the parameter lines of the <c>__construct(...)</c> signature (one parameter per line).
    /// </summary>
    private static IReadOnlyList<string> CtorParamLines(string phpClass) =>
        CtorSignature(phpClass)
            .Split('\n')
            .Select(l => l.Trim().TrimEnd(','))
            .Where(l => l.Contains('$'))
            .ToList();

    /// <summary>
    /// Asserts the required parameter <paramref name="required"/> precedes the defaulted parameter
    /// <paramref name="defaulted"/> within the constructor signature.
    /// </summary>
    private static void AssertParamPrecedes(string phpClass, string required, string defaulted)
    {
        var sig = CtorSignature(phpClass);
        sig.IndexOf(required, StringComparison.Ordinal)
            .ShouldBeGreaterThanOrEqualTo(0, $"expected `{required}` in ctor signature:\n{sig}");
        sig.IndexOf(required, StringComparison.Ordinal)
            .ShouldBeLessThan(sig.IndexOf(defaulted, StringComparison.Ordinal),
                $"`{required}` should precede `{defaulted}` in:\n{sig}");
    }

    /// <summary>
    /// Asserts that, scanning the constructor's parameter list left-to-right, no parameter WITHOUT a
    /// default value follows one that has a default — the exact shape phpstan rejects.
    /// </summary>
    private static void AssertNoRequiredAfterDefaulted(string phpClass)
    {
        var seenDefaulted = false;
        foreach (var line in CtorParamLines(phpClass))
        {
            var hasDefault = line.Contains(" = ", StringComparison.Ordinal);
            if (hasDefault)
            {
                seenDefaulted = true;
            }
            else
            {
                seenDefaulted.ShouldBeFalse(
                    $"required parameter '{line}' follows a defaulted one in:\n{phpClass}");
            }
        }
    }

    private static string EmitClassNamed(string source, string classKeyword, string className)
    {
        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        // Anchor on the trailing newline so `class Customer` does not also match `class CustomerId`
        // (the entity's branded-id value object, emitted to a separate file).
        var marker = $"{classKeyword} {className}\n";
        var file = result.Files.SingleOrDefault(f => f.Contents.Contains(marker, StringComparison.Ordinal));
        file.ShouldNotBeNull($"expected an emitted file declaring `{classKeyword} {className}`");
        return file.Contents;
    }

    [Fact]
    public void ValueObject_optional_before_required_orders_required_first()
    {
        // nickname (optional) is declared BEFORE email (required) — the emitted ctor must put $email first.
        const string source =
            "context C { value Contact { nickname: String?  email: String } }";

        var contact = EmitClassNamed(source, "class", "Contact");
        AssertNoRequiredAfterDefaulted(contact);
        AssertParamPrecedes(contact, "$email", "$nickname");
    }

    [Fact]
    public void ValueObject_defaulted_enum_before_required_orders_required_first()
    {
        const string source =
            "context C { enum Color { Red, Green } value Tag { color: Color = Green  label: String } }";

        var tag = EmitClassNamed(source, "class", "Tag");
        AssertNoRequiredAfterDefaulted(tag);
        AssertParamPrecedes(tag, "$label", "$color");
    }

    [Fact]
    public void Event_defaulted_before_required_orders_required_first()
    {
        const string source =
            "context C { enum Color { Red, Green } event ColorChanged { color: Color = Green  label: String } }";

        var ev = EmitClassNamed(source, "class", "ColorChanged");
        AssertNoRequiredAfterDefaulted(ev);
        AssertParamPrecedes(ev, "$label", "$color");
    }

    [Fact]
    public void Entity_optional_before_required_orders_required_first()
    {
        // note (optional) declared before name (required); entity ctor takes $id first, then fields.
        const string source =
            "context C { entity Customer identified by CustomerId { note: String?  name: String } }";

        var customer = EmitClassNamed(source, "class", "Customer");
        AssertNoRequiredAfterDefaulted(customer);
        AssertParamPrecedes(customer, "$name", "$note");
    }

    /// <summary>
    /// End-to-end phpstan gate (skip-if-absent): a model exhibiting the optional-before-required and
    /// defaulted-before-required patterns across a value object, an entity, and an event must
    /// type-check at <c>--level max</c> with no <c>parameter.requiredAfterOptional</c> finding.
    /// </summary>
    [Fact]
    public void Emitted_model_with_optional_before_required_typechecks_at_phpstan_level_max()
    {
        const string source =
            "context C {\n" +
            "  enum Color { Red, Green }\n" +
            "  value Contact { nickname: String?  email: String }\n" +
            "  value Tag { color: Color = Green  label: String }\n" +
            "  event ColorChanged { color: Color = Green  label: String }\n" +
            "  entity Customer identified by CustomerId { note: String?  name: String }\n" +
            "}";

        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable,
            "No PHP toolchain (phpstan) available locally; type-check not run. " +
            "Install phpstan (or set KOINE_PHPSTAN) — CI runs this for real.");

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
