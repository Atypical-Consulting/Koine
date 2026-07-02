namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="PythonNaming"/> — the pure, table-driven naming helpers
/// for the Python emitter. Covers snake_case, PascalCase, UPPER_SNAKE, and keyword escaping.
/// </summary>
public class PythonNamingTests
{
    // =========================================================================
    // ToSnakeCase
    // =========================================================================

    [Theory]
    [InlineData("UnitPrice", "unit_price")]
    [InlineData("unitPrice", "unit_price")]
    [InlineData("unit_price", "unit_price")]
    [InlineData("subtotal", "subtotal")]
    [InlineData("OrderLine", "order_line")]
    [InlineData("URLPath", "url_path")]
    [InlineData("myURLPath", "my_url_path")]
    [InlineData("getHTTPCode", "get_http_code")]
    [InlineData("ID", "id")]
    [InlineData("OrderID", "order_id")]
    [InlineData("quantity", "quantity")]
    [InlineData("TotalAmount", "total_amount")]
    public void ToSnakeCase_converts_correctly(string input, string expected)
    {
        PythonNaming.ToSnakeCase(input).ShouldBe(expected);
    }

    [Fact]
    public void ToSnakeCase_from_spec_UnitPrice()
    {
        PythonNaming.ToSnakeCase("UnitPrice").ShouldBe("unit_price");
    }

    // =========================================================================
    // ToUpperSnake
    // =========================================================================

    [Theory]
    [InlineData("OrderStatus", "ORDER_STATUS")]
    [InlineData("unitPrice", "UNIT_PRICE")]
    [InlineData("STATUS", "STATUS")]
    [InlineData("TotalAmount", "TOTAL_AMOUNT")]
    public void ToUpperSnake_converts_correctly(string input, string expected)
    {
        PythonNaming.ToUpperSnake(input).ShouldBe(expected);
    }

    [Fact]
    public void ToUpperSnake_from_spec_OrderStatus()
    {
        PythonNaming.ToUpperSnake("OrderStatus").ShouldBe("ORDER_STATUS");
    }

    // =========================================================================
    // ToPascalCase
    // =========================================================================

    [Theory]
    [InlineData("order_line", "OrderLine")]
    [InlineData("OrderLine", "OrderLine")]
    [InlineData("unit_price", "UnitPrice")]
    [InlineData("unitPrice", "UnitPrice")]
    [InlineData("subtotal", "Subtotal")]
    [InlineData("order_id", "OrderId")]
    public void ToPascalCase_converts_correctly(string input, string expected)
    {
        PythonNaming.ToPascalCase(input).ShouldBe(expected);
    }

    [Fact]
    public void ToPascalCase_from_spec_order_line()
    {
        PythonNaming.ToPascalCase("order_line").ShouldBe("OrderLine");
    }

    [Fact]
    public void ToPascalCase_already_pascal_unchanged()
    {
        PythonNaming.ToPascalCase("OrderLine").ShouldBe("OrderLine");
    }

    // =========================================================================
    // EscapeIdentifier — Python keywords
    // =========================================================================

    [Theory]
    // Hard keywords — must be escaped
    [InlineData("False", "False_")]
    [InlineData("None", "None_")]
    [InlineData("True", "True_")]
    [InlineData("and", "and_")]
    [InlineData("as", "as_")]
    [InlineData("assert", "assert_")]
    [InlineData("async", "async_")]
    [InlineData("await", "await_")]
    [InlineData("break", "break_")]
    [InlineData("class", "class_")]
    [InlineData("continue", "continue_")]
    [InlineData("def", "def_")]
    [InlineData("del", "del_")]
    [InlineData("elif", "elif_")]
    [InlineData("else", "else_")]
    [InlineData("except", "except_")]
    [InlineData("finally", "finally_")]
    [InlineData("for", "for_")]
    [InlineData("from", "from_")]
    [InlineData("global", "global_")]
    [InlineData("if", "if_")]
    [InlineData("import", "import_")]
    [InlineData("in", "in_")]
    [InlineData("is", "is_")]
    [InlineData("lambda", "lambda_")]
    [InlineData("nonlocal", "nonlocal_")]
    [InlineData("not", "not_")]
    [InlineData("or", "or_")]
    [InlineData("pass", "pass_")]
    [InlineData("raise", "raise_")]
    [InlineData("return", "return_")]
    [InlineData("try", "try_")]
    [InlineData("while", "while_")]
    [InlineData("with", "with_")]
    [InlineData("yield", "yield_")]
    // Soft keywords — must be escaped
    [InlineData("match", "match_")]
    [InlineData("case", "case_")]
    [InlineData("type", "type_")]
    [InlineData("_", "__")]
    // Normal identifiers — must NOT be escaped
    [InlineData("amount", "amount")]
    [InlineData("quantity", "quantity")]
    [InlineData("order", "order")]
    [InlineData("status", "status")]
    public void EscapeIdentifier_handles_keyword_and_non_keyword(string input, string expected)
    {
        PythonNaming.EscapeIdentifier(input).ShouldBe(expected);
    }

    [Fact]
    public void EscapeIdentifier_from_spec_match()
    {
        PythonNaming.EscapeIdentifier("match").ShouldBe("match_");
    }

    [Fact]
    public void EscapeIdentifier_from_spec_amount()
    {
        PythonNaming.EscapeIdentifier("amount").ShouldBe("amount");
    }
}
