using Koine.Compiler.Emit.Php;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="PhpNaming"/> — the pure, table-driven naming helpers
/// for the PHP emitter. Covers PascalCase (class names), camelCase (methods/properties),
/// UPPER_SNAKE (constants), namespace shape, and reserved-word escaping.
/// </summary>
public class PhpNamingTests
{
    // =========================================================================
    // ClassName — PascalCase + reserved-word escaping
    // =========================================================================

    [Theory]
    [InlineData("OrderLine", "OrderLine")]
    [InlineData("order_line", "OrderLine")]
    [InlineData("unitPrice", "UnitPrice")]
    [InlineData("subtotal", "Subtotal")]
    [InlineData("order_id", "OrderId")]
    public void ClassName_returns_PascalCase(string input, string expected)
    {
        PhpNaming.ClassName(input).ShouldBe(expected);
    }

    [Theory]
    // PHP class-name reserved words — must be escaped with trailing underscore
    [InlineData("class", "class_")]
    [InlineData("interface", "interface_")]
    [InlineData("trait", "trait_")]
    [InlineData("enum", "enum_")]
    [InlineData("namespace", "namespace_")]
    [InlineData("fn", "fn_")]
    [InlineData("match", "match_")]
    [InlineData("list", "list_")]
    [InlineData("echo", "echo_")]
    [InlineData("array", "array_")]
    [InlineData("null", "null_")]
    [InlineData("true", "true_")]
    [InlineData("false", "false_")]
    [InlineData("string", "string_")]
    [InlineData("int", "int_")]
    [InlineData("float", "float_")]
    [InlineData("bool", "bool_")]
    [InlineData("void", "void_")]
    [InlineData("object", "object_")]
    [InlineData("callable", "callable_")]
    [InlineData("iterable", "iterable_")]
    [InlineData("mixed", "mixed_")]
    [InlineData("never", "never_")]
    [InlineData("readonly", "readonly_")]
    [InlineData("use", "use_")]
    // Normal identifiers — must NOT be escaped
    [InlineData("Order", "Order")]
    [InlineData("Amount", "Amount")]
    [InlineData("Status", "Status")]
    public void ClassName_escapes_reserved_words(string input, string expected)
    {
        PhpNaming.ClassName(input).ShouldBe(expected);
    }

    // =========================================================================
    // MethodName — camelCase
    // =========================================================================

    [Theory]
    [InlineData("UnitPrice", "unitPrice")]
    [InlineData("unitPrice", "unitPrice")]
    [InlineData("unit_price", "unitPrice")]
    [InlineData("subtotal", "subtotal")]
    [InlineData("OrderLine", "orderLine")]
    [InlineData("getHTTPCode", "getHTTPCode")]
    [InlineData("ID", "id")]
    [InlineData("OrderID", "orderId")]
    public void MethodName_returns_camelCase(string input, string expected)
    {
        PhpNaming.MethodName(input).ShouldBe(expected);
    }

    [Theory]
    // A derived member or param whose camelCase form is a PHP reserved word must be escaped
    // so it can appear as a bare method name (e.g. `public function match_()`).
    [InlineData("match", "match_")]
    [InlineData("list", "list_")]
    [InlineData("fn", "fn_")]
    [InlineData("default", "default_")]
    [InlineData("echo", "echo_")]
    [InlineData("print", "print_")]
    public void MethodName_escapes_reserved_words(string input, string expected)
    {
        PhpNaming.MethodName(input).ShouldBe(expected);
    }

    // =========================================================================
    // PropertyName — camelCase
    // =========================================================================

    [Theory]
    [InlineData("UnitPrice", "unitPrice")]
    [InlineData("unit_price", "unitPrice")]
    [InlineData("subtotal", "subtotal")]
    [InlineData("OrderLine", "orderLine")]
    public void PropertyName_returns_camelCase(string input, string expected)
    {
        PhpNaming.PropertyName(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("match", "match_")]
    [InlineData("list", "list_")]
    [InlineData("default", "default_")]
    public void PropertyName_escapes_reserved_words(string input, string expected)
    {
        PhpNaming.PropertyName(input).ShouldBe(expected);
    }

    // =========================================================================
    // ConstName — UPPER_SNAKE
    // =========================================================================

    [Theory]
    [InlineData("OrderStatus", "ORDER_STATUS")]
    [InlineData("unitPrice", "UNIT_PRICE")]
    [InlineData("STATUS", "STATUS")]
    [InlineData("TotalAmount", "TOTAL_AMOUNT")]
    public void ConstName_returns_UPPER_SNAKE(string input, string expected)
    {
        PhpNaming.ConstName(input).ShouldBe(expected);
    }

    [Fact]
    public void ConstName_from_spec_OrderStatus()
    {
        PhpNaming.ConstName("OrderStatus").ShouldBe("ORDER_STATUS");
    }

    // =========================================================================
    // Namespace — Koine\<Context> shape with PascalCase segments
    // =========================================================================

    [Fact]
    public void Namespace_wraps_context_in_Koine_prefix()
    {
        PhpNaming.Namespace("Billing").ShouldBe(@"Koine\Billing");
    }

    [Fact]
    public void Namespace_pascalcases_context_name()
    {
        PhpNaming.Namespace("catalog").ShouldBe(@"Koine\Catalog");
    }

    [Fact]
    public void Namespace_handles_snake_case_context()
    {
        PhpNaming.Namespace("order_management").ShouldBe(@"Koine\OrderManagement");
    }

    // =========================================================================
    // EscapeIdentifier — PHP reserved words
    // =========================================================================

    [Theory]
    [InlineData("class", "class_")]
    [InlineData("function", "function_")]
    [InlineData("list", "list_")]
    [InlineData("echo", "echo_")]
    [InlineData("match", "match_")]
    [InlineData("fn", "fn_")]
    [InlineData("enum", "enum_")]
    [InlineData("readonly", "readonly_")]
    [InlineData("interface", "interface_")]
    [InlineData("trait", "trait_")]
    [InlineData("namespace", "namespace_")]
    [InlineData("use", "use_")]
    [InlineData("array", "array_")]
    [InlineData("string", "string_")]
    [InlineData("int", "int_")]
    [InlineData("float", "float_")]
    [InlineData("bool", "bool_")]
    [InlineData("void", "void_")]
    [InlineData("null", "null_")]
    [InlineData("true", "true_")]
    [InlineData("false", "false_")]
    [InlineData("iterable", "iterable_")]
    [InlineData("object", "object_")]
    [InlineData("callable", "callable_")]
    [InlineData("mixed", "mixed_")]
    [InlineData("never", "never_")]
    // Normal identifiers — must NOT be escaped
    [InlineData("amount", "amount")]
    [InlineData("quantity", "quantity")]
    [InlineData("order", "order")]
    [InlineData("status", "status")]
    public void EscapeIdentifier_handles_keyword_and_non_keyword(string input, string expected)
    {
        PhpNaming.EscapeIdentifier(input).ShouldBe(expected);
    }

    [Fact]
    public void EscapeIdentifier_from_spec_match()
    {
        PhpNaming.EscapeIdentifier("match").ShouldBe("match_");
    }

    [Fact]
    public void EscapeIdentifier_from_spec_amount()
    {
        PhpNaming.EscapeIdentifier("amount").ShouldBe("amount");
    }
}
