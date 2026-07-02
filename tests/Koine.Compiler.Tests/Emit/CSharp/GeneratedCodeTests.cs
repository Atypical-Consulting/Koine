using System.Reflection;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Meta-tests: emit C# for the fixture, compile it in-memory with Roslyn, then
/// exercise the generated types via reflection to assert DDD semantics.
/// </summary>
public class GeneratedCodeTests
{
    private static Assembly CompileFixture()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    [Fact]
    public void Generated_csharp_compiles()
    {
        var asm = CompileFixture();
        asm.GetType("Billing.Money").ShouldNotBeNull();
        asm.GetType("Billing.Order").ShouldNotBeNull();
    }

    [Fact]
    public void Money_rejects_negative_amount_and_accepts_zero()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;
        var currency = asm.GetType("Billing.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        // Money(0, EUR) succeeds.
        var ok = Activator.CreateInstance(money, 0m, eur);
        ok.ShouldNotBeNull();

        // Money(-1, EUR) throws DomainInvariantViolationException (wrapped by reflection).
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(money, -1m, eur));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Value_object_has_value_equality()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;
        var currency = asm.GetType("Billing.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        var usd = TestSupport.EnumValue(currency, "USD");
        var a = Activator.CreateInstance(money, 10m, eur);
        var b = Activator.CreateInstance(money, 10m, eur);
        var c = Activator.CreateInstance(money, 10m, usd); // differs by a component

        // Structural equality from the ValueObject base (not a record, not reference equality).
        b.ShouldBe(a);
        b!.GetHashCode().ShouldBe(a!.GetHashCode());
        ReferenceEquals(a, b).ShouldBeFalse();
        c.ShouldNotBe(a);

        // The == / != operators (defined on the ValueObject base) compare by value too.
        var op = money.BaseType!.GetMethod("op_Equality")!;
        ((bool)op.Invoke(null, new[] { a, b })!).ShouldBeTrue();
        ((bool)op.Invoke(null, new[] { a, c })!).ShouldBeFalse();
    }

    [Fact]
    public void Value_object_is_a_class_deriving_ValueObject_not_a_record()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;

        money.BaseType!.Name.ShouldBe("ValueObject");
        (money.IsSealed && money.GetMethods().Any(m => m.Name == "<Clone>$")).ShouldBeFalse("value objects must not be compiler-generated records");
    }

    [Fact]
    public void Boolean_conditional_is_emitted_without_a_redundant_ternary()
    {
        // `if cond then true else false` must lower to the bare condition, not `cond ? true : false`.
        const string src =
            "context C {\n  enum Tier { Bronze, Gold }\n" +
            "  value V {\n    tier: Tier\n    isGold: Bool = if tier == Gold then true else false\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var file = result.Files.Single(f => f.RelativePath.EndsWith("V.cs"));
        file.Contents.ShouldContain("IsGold\n        => Tier == Tier.Gold;");
        file.Contents.ShouldNotContain("? true : false");

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void String_plus_bool_concatenation_emits_canonical_lowercase_ternary()
    {
        // Issue #806: `String + Bool` (and `Bool + String`) must emit a `(boolExpr ? "true" : "false")`
        // ternary rather than relying on `bool.ToString()` ("True"/"False"), so all three emitters
        // produce the canonical cross-target "true"/"false" strings.
        const string src =
            "context Account {\n" +
            "  value Membership {\n" +
            "    isActive: Bool\n" +
            // String-led: String + Bool
            "    label: String = \"active: \" + isActive\n" +
            // Bool-led: Bool + String
            "    caption: String = isActive + \" status\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var file = result.Files.Single(f => f.RelativePath.EndsWith("Membership.cs"));
        // The Bool operand is lowered to a ternary in both operand orders.
        file.Contents.ShouldContain("(IsActive ? \"true\" : \"false\")");
        // The native bool.ToString() path must not appear (would give "True"/"False").
        file.Contents.ShouldNotContain("+ IsActive");
        file.Contents.ShouldNotContain("IsActive +");

        // The emitted C# must compile and yield "true"/"false" (not "True"/"False") at runtime.
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        var membershipType = asm!.GetType("Account.Membership")!;
        // Explicit object[] to avoid ambiguity with Activator.CreateInstance(Type, bool nonPublic).
        var instance = Activator.CreateInstance(membershipType, new object[] { true })!;
        membershipType.GetProperty("Label")!.GetValue(instance)!.ToString().ShouldBe("active: true");
        membershipType.GetProperty("Caption")!.GetValue(instance)!.ToString().ShouldBe("true status");
    }

    [Fact]
    public void Entity_equality_uses_only_identity()
    {
        var asm = CompileFixture();
        var customer = asm.GetType("Billing.Customer")!;
        var customerId = asm.GetType("Billing.CustomerId")!;
        var email = asm.GetType("Billing.Email")!;

        var id = Activator.CreateInstance(customerId, Guid.NewGuid());
        var mail = Activator.CreateInstance(email, "a@b.co");

        var c1 = Activator.CreateInstance(customer, id, "Alice", mail);
        var c2 = Activator.CreateInstance(customer, id, "Bob", mail); // different name, same id

        c1!.Equals(c2).ShouldBeTrue(); // equal by identity only
        c2.GetHashCode().ShouldBe(c1.GetHashCode());
    }

    [Fact]
    public void Derived_subtotal_scales_money_by_quantity()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;
        var currency = asm.GetType("Billing.Currency")!;
        var line = asm.GetType("Billing.OrderLine")!;
        var productId = asm.GetType("Billing.ProductId")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        var unitPrice = Activator.CreateInstance(money, 5m, eur);
        var pid = Activator.CreateInstance(productId, Guid.NewGuid());
        var orderLine = Activator.CreateInstance(line, pid, 3, unitPrice);

        var subtotal = line.GetProperty("Subtotal")!.GetValue(orderLine);
        var amount = (decimal)money.GetProperty("Amount")!.GetValue(subtotal)!;
        amount.ShouldBe(15m); // 5 * 3
    }

    [Fact]
    public void Root_entity_implements_IAggregateRoot()
    {
        var asm = CompileFixture();
        var order = asm.GetType("Billing.Order")!;
        order.GetInterfaces().ShouldContain(i => i.Name == "IAggregateRoot");
    }

    [Fact]
    public void Keyword_field_names_emit_compiling_code()
    {
        // `base` is a C# keyword; it must be escaped (@base) so the output compiles.
        const string src =
            "context C {\n  value Weighted {\n    base: Decimal\n    factor: Decimal\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue();

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        asm.GetType("C.Weighted").ShouldNotBeNull();
    }

    [Fact]
    public void Member_less_value_object_compiles()
    {
        // GetEqualityComponents must stay a valid iterator (yield break) with no fields.
        const string src = "context Demo {\n  value Empty { }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        asm.GetType("Demo.Empty").ShouldNotBeNull();
    }

    [Fact]
    public void Cross_context_reference_compiles()
    {
        // A value object referencing a type from another context imports it (R13.2); the
        // emitted C# carries a precise `using Shared;`.
        const string src =
            "context Shared {\n  value Money { amount: Decimal }\n}\n" +
            "context Sales {\n  import Shared.{ Money }\n  value Quote { price: Money }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var quote = result.Files.Single(f => f.RelativePath == "Sales/ValueObjects/Quote.cs").Contents;
        quote.ShouldContain("using Shared;");

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        asm.GetType("Sales.Quote").ShouldNotBeNull();
    }

    [Fact]
    public void Value_object_with_collections_compares_by_content()
    {
        const string src = "context Cart {\n  value Tags {\n    labels: List<String>\n    codes:  Set<Int>\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        var tags = asm.GetType("Cart.Tags")!;

        // ctor: (IReadOnlyList<string> labels, IReadOnlySet<int> codes).
        var t1 = Activator.CreateInstance(tags, new List<string> { "a", "b" }, new HashSet<int> { 1, 2 })!;
        var sameContent = Activator.CreateInstance(tags, new List<string> { "a", "b" }, new HashSet<int> { 2, 1 })!;
        var listReordered = Activator.CreateInstance(tags, new List<string> { "b", "a" }, new HashSet<int> { 1, 2 })!;

        // List is order-sensitive, Set is order-insensitive — both compared by content, not reference.
        sameContent.ShouldBe(t1);
        sameContent.GetHashCode().ShouldBe(t1.GetHashCode());
        listReordered.ShouldNotBe(t1);
    }

    [Fact]
    public void Reemitting_is_byte_identical()
    {
        var compiler = new KoineCompiler();
        var first = compiler.Compile(TestSupport.BillingFixture, new CSharpEmitter()).Files;
        var second = compiler.Compile(TestSupport.BillingFixture, new CSharpEmitter()).Files;

        TestSupport.Render(second).ShouldBe(TestSupport.Render(first));
    }

    [Fact]
    public void Matches_invariant_emits_a_timeout_bounded_regex()
    {
        // A `matches` invariant must lower to a TIMEOUT-bounded Regex.IsMatch so a
        // catastrophic-backtracking pattern in a value object cannot become a ReDoS sink
        // (issue #641). The emitted guard carries `RegexOptions.None, TimeSpan.From...`.
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("Email.cs")).Contents;
        email.ShouldContain("Regex.IsMatch(");
        email.ShouldContain("RegexOptions.None, TimeSpan.From");

        // The bounded form still behaves identically for normal input: a valid value is
        // accepted and an invalid one is rejected (Roslyn compile + execute).
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        var type = asm.GetType("C.Email")!;

        Activator.CreateInstance(type, "a@b.co").ShouldNotBeNull();
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(type, "not-an-email"));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Multiple_matches_invariants_emit_distinctly_named_generated_regex_methods()
    {
        // Issue #795: a type may hold several `matches` invariants — including two on the SAME field — so the
        // source-generated form names each [GeneratedRegex] method with a per-type counter
        // (<PascalField>Regex<index>) to stay collision-free and deterministic. Here `raw` carries two
        // matches and `label` one: three distinctly-named partial methods.
        const string src =
            "context C {\n  value Code {\n    raw: String\n    label: String\n" +
            "    invariant raw matches /^[A-Z]/     \"must start with an uppercase letter\"\n" +
            "    invariant raw matches /[0-9]$/     \"must end with a digit\"\n" +
            "    invariant label matches /^[a-z]+$/ \"label must be lowercase letters\"\n  }\n}\n";
        var result = new KoineCompiler().Compile(
            src, new CSharpEmitter(CSharpEmitterOptions.Empty with { RegexMode = RegexMode.SourceGenerated }));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var code = result.Files.Single(f => f.RelativePath.EndsWith("Code.cs")).Contents;
        code.ShouldContain("public sealed partial class Code");

        // One [GeneratedRegex] partial method per `matches`, every name DISTINCT (the per-type counter keeps
        // the two matches on `raw` from colliding).
        var methodNames = System.Text.RegularExpressions.Regex
            .Matches(code, @"private static partial Regex (\w+)\(\);")
            .Select(m => m.Groups[1].Value)
            .ToList();
        methodNames.Count.ShouldBe(3);
        methodNames.Distinct().Count().ShouldBe(3);

        // Compiles + executes under the source generator: a value satisfying all three guards constructs;
        // violating any one throws.
        var (asm, errors) = TestSupport.Compile(result.Files, runRegexGenerator: true);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        var type = asm.GetType("C.Code")!;

        Activator.CreateInstance(type, "A1", "abc").ShouldNotBeNull();
        Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(type, "a1", "abc")) // bad raw
            .InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
        Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(type, "A1", "ABC")) // bad label
            .InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Matches_invariant_emits_a_source_generated_regex()
    {
        // Issue #795: under the opt-in RegexMode.SourceGenerated, a `matches` invariant lowers to a cached,
        // allocation-free [GeneratedRegex] partial method instead of the inline Regex.IsMatch(...) — the
        // SAME pattern, RegexOptions.None, and timeout, so match behavior is identical (only the evaluation
        // strategy differs). The containing type gains the `partial` modifier so the source generator can
        // supply the method body.
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var result = new KoineCompiler().Compile(
            src, new CSharpEmitter(CSharpEmitterOptions.Empty with { RegexMode = RegexMode.SourceGenerated }));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("Email.cs")).Contents;
        email.ShouldContain("[GeneratedRegex(");
        email.ShouldContain("private static partial Regex");
        email.ShouldContain("public sealed partial class Email");
        email.ShouldContain("matchTimeoutMilliseconds: 1000");
        email.ShouldContain(".IsMatch(");
        // UsingCollector already pulls in the namespace from the `Regex` token (no collector change needed).
        email.ShouldContain("using System.Text.RegularExpressions;");
        // The inline static call must be gone — the guard now goes through the cached matcher.
        email.ShouldNotContain("Regex.IsMatch(");

        // Run the regex source generator so the partial method gets its body, then construct instances to
        // prove the source-generated matcher accepts a valid value and rejects an invalid one — parity with
        // the inline form. A missing generator body would fail this compile, which is what proves it ran.
        var (asm, errors) = TestSupport.Compile(result.Files, runRegexGenerator: true);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        var type = asm.GetType("C.Email")!;

        Activator.CreateInstance(type, "a@b.co").ShouldNotBeNull();
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(type, "not-an-email"));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Source_generated_matches_form_has_identical_semantics_to_the_inline_form()
    {
        // Issue #795: the source-generated form is a pure optimization — it must accept/reject EXACTLY what
        // the inline form does. Compile the SAME model both ways and assert parity across a normal input matrix.
        // Issue #888: the accept/reject semantics don't depend on the match-timeout, so emit these fixtures
        // with a GENEROUS budget — a benign, matching input must never surface RegexMatchTimeoutException just
        // because the test host is loaded (the match-timeout is a wall-clock deadline, not regex work). The
        // ReDoS guard's tight-budget behaviour is proven separately in
        // Matches_invariant_still_times_out_on_a_catastrophic_pattern_under_a_tight_budget.
        const string src =
            "context C {\n  value Token {\n    raw: String\n" +
            "    invariant raw matches /^(a+)+$/  \"must be all a's\"\n  }\n}\n";
        var parityOptions = CSharpEmitterOptions.Empty with { RegexMatchTimeoutMs = GenerousMatchTimeoutMs };

        var inline = CompileMatchType(src, parityOptions with { RegexMode = RegexMode.Inline }, "C.Token", runRegexGenerator: false);
        var sourceGen = CompileMatchType(src, parityOptions with { RegexMode = RegexMode.SourceGenerated }, "C.Token", runRegexGenerator: true);

        foreach ((var value, var valid) in new[] { ("a", true), ("aaaa", true), ("aaab", false), ("b", false), ("", false) })
        {
            Accepts(inline, value).ShouldBe(valid, $"inline rejected/accepted '{value}' unexpectedly");
            Accepts(sourceGen, value).ShouldBe(valid, $"source-generated diverged from inline on '{value}'");
        }
    }

    [Fact]
    public void Matches_invariant_still_times_out_on_a_catastrophic_pattern_under_a_tight_budget()
    {
        // Issue #888 guard: de-flaking the parity test (whose benign matrix now runs under a GENEROUS
        // match-timeout so a loaded host can't trip a microsecond match) must NOT silently disable the
        // ReDoS safeguard. Prove the guard still fires: a catastrophic-backtracking input under a TIGHT
        // match-timeout must surface a contained RegexMatchTimeoutException (not hang) under BOTH the
        // inline and source-generated forms.
        const string src =
            "context C {\n  value Token {\n    raw: String\n" +
            "    invariant raw matches /^(a+)+$/  \"must be all a's\"\n  }\n}\n";
        var tight = CSharpEmitterOptions.Empty with { RegexMatchTimeoutMs = 100 };

        var inline = CompileMatchType(src, tight with { RegexMode = RegexMode.Inline }, "C.Token", runRegexGenerator: false);
        var sourceGen = CompileMatchType(src, tight with { RegexMode = RegexMode.SourceGenerated }, "C.Token", runRegexGenerator: true);

        var evil = new string('a', 48) + "!"; // exponential backtracking on `(a+)+`
        AssertTimesOut(inline, evil);
        AssertTimesOut(sourceGen, evil);
    }

    [Fact]
    public void Source_generated_mode_keeps_matches_in_specs_and_services_compiling()
    {
        // Issue #795 regression: the source-generated form (a `[GeneratedRegex]` partial-method CALL) is only
        // safe where the emitter also DECLARES the method and stamps the type `partial` — i.e. value objects
        // and entities. `matches` can also appear in a spec condition or a service operation, rendered through
        // a different translator into a class that declares no partial methods. Those must keep emitting the
        // (always-valid) inline `Regex.IsMatch` form under SourceGenerated, or the generated C# would call an
        // undeclared method (CS0103) in a non-partial class.
        const string src =
            "context C {\n" +
            "  value Code {\n    raw: String\n    invariant raw matches /^[A-Z]+$/ \"must be uppercase\"\n  }\n" +
            "  spec LooksValid on Code = raw matches /^[A-Z]+$/\n" +
            "  service Checker {\n    operation isCode(raw: String): Bool = raw matches /^[A-Z]+$/\n  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(
            src, new CSharpEmitter(CSharpEmitterOptions.Empty with { RegexMode = RegexMode.SourceGenerated }));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The value object gets the optimized [GeneratedRegex] form...
        var code = result.Files.Single(f => f.RelativePath.EndsWith("Code.cs")).Contents;
        code.ShouldContain("[GeneratedRegex(");
        code.ShouldContain("public sealed partial class Code");

        // ...while the spec and service keep the inline bounded form (no dangling generated-method call).
        var spec = result.Files.Single(f => f.RelativePath.EndsWith("Specifications.cs")).Contents;
        spec.ShouldContain("Regex.IsMatch(");
        spec.ShouldNotContain("[GeneratedRegex(");
        var service = result.Files.Single(f => f.RelativePath.EndsWith("Checker.cs")).Contents;
        service.ShouldContain("Regex.IsMatch(");
        service.ShouldNotContain("[GeneratedRegex(");

        // The whole emission must compile (with the regex generator wired in for the VO's partial method).
        var (asm, errors) = TestSupport.Compile(result.Files, runRegexGenerator: true);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    /// <summary>
    /// A deliberately generous match-timeout (10 minutes) for meta-tests that compile + execute a benign
    /// <c>matches</c> fixture. The accept/reject assertions don't depend on the timeout, so a budget far
    /// beyond any realistic host-load stall keeps them deterministic (issue #888) — a benign, matching input
    /// can never surface a <c>RegexMatchTimeoutException</c> just because the test host is contended. The real
    /// ReDoS budget is exercised separately with a tight timeout + a catastrophic pattern.
    /// </summary>
    private const int GenerousMatchTimeoutMs = 600_000;

    /// <summary>Emits <paramref name="src"/> with <paramref name="options"/>, Roslyn-compiles it (optionally running the regex source generator), and returns the named type.</summary>
    private static Type CompileMatchType(string src, CSharpEmitterOptions options, string typeName, bool runRegexGenerator)
    {
        var result = new KoineCompiler().Compile(src, new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files, runRegexGenerator);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm.GetType(typeName)!;
    }

    /// <summary>True when constructing <paramref name="type"/> with <paramref name="raw"/> succeeds; false when it throws the domain invariant violation (any other exception propagates).</summary>
    private static bool Accepts(Type type, string raw)
    {
        try
        {
            Activator.CreateInstance(type, raw);
            return true;
        }
        catch (TargetInvocationException e) when (e.InnerException?.GetType().Name == "DomainInvariantViolationException")
        {
            return false;
        }
    }

    /// <summary>Asserts that constructing <paramref name="type"/> with <paramref name="raw"/> surfaces a contained <c>RegexMatchTimeoutException</c> (the ReDoS budget tripped), not a hang.</summary>
    private static void AssertTimesOut(Type type, string raw)
    {
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(type, raw));
        ex.InnerException!.GetType().Name.ShouldBe("RegexMatchTimeoutException");
    }
}
