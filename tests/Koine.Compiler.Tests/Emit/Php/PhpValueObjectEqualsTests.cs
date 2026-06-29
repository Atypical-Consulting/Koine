using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression tests for #686: the PHP value-object <c>equals(self $other)</c> must compare a field
/// whose type is itself a value object / id value object (or <c>Decimal</c>) <b>structurally</b> via
/// that field's own <c>equals()</c> — not by PHP reference identity (<c>===</c>), which is wrong for
/// objects. Primitives/enums keep <c>===</c> (value equality). This gives parity with the C# record
/// equality and the structural <c>distinctBy</c> dedup the same VOs feed (#681).
/// </summary>
public class PhpValueObjectEqualsTests
{
    private static string EmitVo(string src, string voName)
    {
        var result = new KoineCompiler().Compile(src, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.Contains($"{voName}.php")).Contents;
    }

    [Fact]
    public void Nested_value_object_field_compares_structurally_via_equals()
    {
        const string src =
            """
            context Shop {
              value Money { amount: Decimal }
              value Priced { money: Money }
            }
            """;

        var php = EmitVo(src, "Priced");

        php.ShouldContain("return $this->money->equals($other->money);");
        php.ShouldNotContain("$this->money === $other->money");
    }

    [Fact]
    public void Primitive_field_still_compares_with_strict_equals()
    {
        const string src =
            """
            context Shop {
              value Tag { name: String }
            }
            """;

        var php = EmitVo(src, "Tag");

        php.ShouldContain("return $this->name === $other->name;");
    }

    [Fact]
    public void Decimal_field_compares_via_equals()
    {
        const string src =
            """
            context Shop {
              value Money { amount: Decimal }
            }
            """;

        var php = EmitVo(src, "Money");

        php.ShouldContain("return $this->amount->equals($other->amount);");
    }

    [Fact]
    public void Optional_nested_value_object_field_compares_null_safely()
    {
        const string src =
            """
            context Shop {
              value Money { amount: Decimal }
              value MaybePriced { money: Money? }
            }
            """;

        var php = EmitVo(src, "MaybePriced");

        // Two nulls are equal; a present-vs-null pair is unequal; two present compare structurally.
        php.ShouldContain(
            "return ($this->money === null ? $other->money === null "
            + ": ($other->money !== null && $this->money->equals($other->money)));");
        php.ShouldNotContain("$this->money === $other->money");
    }

    [Fact]
    public void Mixed_fields_chain_each_with_the_right_operator()
    {
        const string src =
            """
            context Shop {
              value Money { amount: Decimal }
              value Line {
                label: String
                price: Money
              }
            }
            """;

        var php = EmitVo(src, "Line");

        php.ShouldContain("$this->label === $other->label");
        php.ShouldContain("$this->price->equals($other->price)");
    }
}
