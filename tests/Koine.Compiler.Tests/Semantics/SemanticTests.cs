using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class SemanticTests
{
    private static IReadOnlyList<Diagnostic> Validate(string source)
    {
        var (model, syntax) = new KoineCompiler().Parse(source);
        syntax.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticValidator().Validate(model);
    }

    [Fact]
    public void Valid_fixture_has_no_diagnostics()
    {
        Validate(TestSupport.BillingFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Unknown_type_reference_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Nope\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownType);
    }

    [Theory]
    [InlineData("id")]   // collides with the generated identity property
    [InlineData("Id")]
    [InlineData("equals")]
    [InlineData("getHashCode")]
    public void Entity_member_colliding_with_a_generated_member_is_reported(string member)
    {
        var src = $"context C {{\n  entity E identified by EId {{ {member}: Int }}\n}}\n";
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedGeneratedMember);
    }

    [Fact]
    public void Entity_member_named_like_a_generated_member_but_distinct_after_casing_is_allowed()
    {
        // `gethashcode` PascalCases to `Gethashcode`, which does NOT collide with GetHashCode.
        const string src = "context C {\n  entity E identified by EId { gethashcode: Int }\n}\n";
        Validate(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ReservedGeneratedMember);
    }

    [Theory]
    [InlineData("equals")]
    [InlineData("getHashCode")]
    [InlineData("getEqualityComponents")] // the overridden method on every value object
    public void Value_object_member_colliding_with_a_generated_member_is_reported(string member)
    {
        var src = $"context C {{\n  value V {{ {member}: Int }}\n}}\n";
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedGeneratedMember);
    }

    [Theory]
    [InlineData("equals")]
    [InlineData("toString")]
    [InlineData("printMembers")]
    public void Event_field_colliding_with_a_record_member_is_reported(string field)
    {
        var src = $"context C {{\n  event E {{ {field}: Int }}\n}}\n";
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedRecordMember);
    }

    [Fact]
    public void Duplicate_member_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Int\n    x: Int\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateMember);
    }

    [Fact]
    public void Invariant_referencing_unknown_field_is_reported()
    {
        const string src = "context C {\n  value V {\n    x: Int\n    invariant y >= 0 \"bad\"\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownField);
    }

    [Fact]
    public void Enum_member_in_invariant_is_accepted()
    {
        const string src =
            "context C {\n" +
            "  enum E { A, B }\n" +
            "  value V {\n" +
            "    state: E\n" +
            "    invariant state == A \"must start at A\"\n" +
            "  }\n" +
            "}\n";
        Validate(src).ShouldBeEmpty();
    }

    [Fact]
    public void Duplicate_enum_member_is_reported()
    {
        var diags = Validate("context C {\n  enum E { A, A, B }\n}\n");
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateEnumMember && d.Message.Contains("'A'"));
    }

    [Fact]
    public void Unknown_aggregate_root_is_reported()
    {
        const string src =
            "context C {\n  aggregate Ord root Missing {\n    entity Ord identified by OrdId { x: Int }\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownAggregateRoot);
    }

    [Fact]
    public void Aggregate_sharing_its_name_with_its_root_is_a_warning_not_an_error()
    {
        // `aggregate Order root Order` still compiles (it is NOT a duplicate-type error), but the
        // boundary reading as nothing more than its root is a code smell: it earns a KOI0109 warning.
        const string src =
            "context C {\n  aggregate Order root Order {\n    entity Order identified by OrderId { x: Int }\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.AggregateNameMatchesRoot
            && d.Severity == DiagnosticSeverity.Warning);
        diags.ShouldNotContain(d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void Aggregate_with_a_distinct_boundary_name_has_no_warning()
    {
        // Naming the boundary after the activity it groups (Sales) rather than its root (Order)
        // is the recommended shape and is completely clean.
        const string src =
            "context C {\n  aggregate Sales root Order {\n    entity Order identified by OrderId { x: Int }\n  }\n}\n";
        Validate(src).ShouldBeEmpty();
    }

    [Fact]
    public void Duplicate_type_is_reported()
    {
        const string src = "context C {\n  value Money { a: Int }\n  value Money { b: String }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateType && d.Message.Contains("Money"));
    }

    [Fact]
    public void Enum_default_must_belong_to_the_fields_enum()
    {
        // Default `Y` belongs to enum B, but the field's type is A.
        const string src =
            "context C {\n  enum A { X }\n  enum B { Y }\n  value V {\n    f: A = Y\n  }\n}\n";
        var diags = Validate(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.UnknownEnumMemberForType && d.Message.Contains("'Y'"));
    }

    /// <summary>
    /// Issue #1498 (Gap A): a bogus member access on an ENUM-typed receiver — as opposed to the
    /// qualified <c>EnumType.Member</c> form, which <c>CheckMember</c> already validates — must be
    /// rejected like any other unknown member. It is the only known way a real <c>.koi</c> model can
    /// carry a member access whose type genuinely does not resolve, which is what lets the Rust
    /// emitter's <c>EffectiveScope</c> shadow-fallthrough (Gap B) manifest.
    /// </summary>
    [Fact]
    public void Unknown_member_on_an_enum_typed_receiver_is_reported()
    {
        const string src =
            """
            context Shop {
              enum Status { Active, Inactive }

              value Widget {
                status: Status
                hasIt: Bool = status.bogusMember == 1
              }
            }
            """;
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownMember && d.Message.Contains("bogusMember"));
    }

    /// <summary>
    /// Issue #1498's companion guard: the new Enum-receiver check must not fire on a LEGITIMATE
    /// smart-enum associated-data access. <c>symbol</c> is a real parameter of <c>Currency</c>'s
    /// signature, so it resolves through <c>ModelIndex.MemberTypeOf</c> and raises nothing.
    /// </summary>
    [Fact]
    public void Smart_enum_associated_data_access_is_not_reported()
    {
        const string src =
            """
            context Shop {
              enum Currency(symbol: String, decimals: Int) {
                EUR("€", 2)
                USD("$", 2)
              }

              value Price {
                currency: Currency
                label: String = currency.symbol
              }
            }
            """;
        Validate(src).ShouldBeEmpty();
    }

    /// <summary>
    /// Issue #1498, the other receiver kind the same gap left unvalidated: a <c>Range</c> has no members
    /// at all, so — like a primitive — every member access on one names something it does not have.
    /// </summary>
    [Fact]
    public void Unknown_member_on_a_range_receiver_is_reported()
    {
        const string src =
            """
            context C {
              value V {
                r: Range<Int>
                b: Bool = r.bogus
              }
            }
            """;
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownMember && d.Message.Contains("'Range'"));
    }

    /// <summary>
    /// Issue #1498's #605 corollary: a declared member named after a built-in member-op SHADOWS the op
    /// (resolve it as an ordinary field access, no collection-op diagnostic) — a rule that until now
    /// applied only to value/entity receivers, so a smart enum whose associated data happened to be
    /// called <c>count</c> was UNUSABLE: reading it raised
    /// <c>KOI0207: collection operation 'count' cannot be applied to 'E'</c>. Extending the gate to enums
    /// makes the checker agree with <c>TypeResolver.VisitMemberAccess</c>, which already resolved any
    /// declared member ahead of the built-in ops.
    /// </summary>
    [Fact]
    public void Smart_enum_datum_named_after_a_builtin_op_shadows_the_op()
    {
        const string src =
            """
            context C {
              enum E(count: Int) {
                A(1)
                B(2)
              }
              value V {
                e: E
                n: Int = e.count
              }
            }
            """;
        Validate(src).ShouldBeEmpty();
    }

    /// <summary>
    /// Issue #1634: <c>CheckMember</c>'s qualified-enum-reference check
    /// (<c>ma.Target is IdentifierExpr typeId &amp;&amp; _index.IsEnumType(typeId.Name)</c>) must resolve
    /// context-first (R13.2), same as the context-aware <see cref="Koine.Compiler.Ast.ModelIndex.Classify(string?, string)"/>
    /// overload #1560/#1612 introduced. Billing legally declares its own <c>enum Status</c> while Shipping
    /// separately declares an unrelated, non-enum <c>Status</c> value object — R13.2 permits this since
    /// uniqueness is enforced per-context, not globally. A context-blind <c>IsEnumType("Status")</c> can
    /// answer for whichever declaration last won the flat, global lookup, wrongly treating Billing's own
    /// qualified <c>Status.Draft</c> reference as an unknown field instead of a valid enum-member access.
    /// </summary>
    [Fact]
    public void Qualified_enum_reference_resolves_against_its_own_context_despite_a_same_named_type_elsewhere()
    {
        const string src =
            """
            context Billing {
              enum Status { Draft, Paid }
              value Invoice {
                status: Status
                isDraft: Bool = status == Status.Draft
              }
            }

            context Shipping {
              value Status {
                code: Int
              }
            }
            """;
        Validate(src).ShouldBeEmpty();
    }

    /// <summary>
    /// Issue #1644: <c>ConcreteEnumType</c>'s three <c>_index.IsEnumType(...)</c> call sites are the same
    /// context-blind flat lookup #1634 fixed for <c>CheckMember</c>, just left untouched there. Billing's
    /// own <c>status: Status</c> field is genuinely enum-typed, but Shipping separately (and legally, per
    /// R13.2) declares an unrelated, non-enum <c>Status</c> value object that registers AFTER Billing's in
    /// <see cref="ModelIndex"/>'s flat, last-write-wins <c>_byName</c> map — so the blind
    /// <c>IsEnumType("Status")</c> answers for Shipping's declaration and wrongly says <c>status</c> is NOT
    /// enum-typed.
    ///
    /// <para>This can't be pinned as an end-to-end diagnostic: every diagnostic that consumes
    /// <c>ConcreteEnumType</c>'s return value (<c>CheckEnumMemberResolvable</c>, <c>ResolveEnumOperand</c>,
    /// reached via comparison/conditional/coalesce) also depends on <c>ModelIndex.EnumsDeclaring</c>/
    /// <c>EnumMemberToType</c> — built from the SAME flat <c>_byName</c>/<c>AllTypes()</c> map. Any model
    /// that collides Billing's <c>Status</c> enum by name (to trigger THIS bug) necessarily also evicts
    /// Billing's <c>Status</c> from those two dictionaries (#1632, explicitly out of this issue's scope),
    /// so the surrounding checks stay blind regardless of this fix. Verified empirically: extending this
    /// exact model with a genuinely ambiguous bare member still mis-reports KOI0210 identically whether or
    /// not <c>ConcreteEnumType</c> is fixed, because <c>EnumsDeclaring</c> never lists the evicted
    /// <c>Status</c> as an owner either way. So this test calls <c>ConcreteEnumType</c> directly (made
    /// <c>internal</c> for exactly this) to pin its own contract in isolation from #1632.</para>
    /// </summary>
    [Fact]
    public void ConcreteEnumType_resolves_every_operand_form_context_first_despite_a_same_named_type_elsewhere()
    {
        const string src =
            """
            context Billing {
              enum Status { Draft, Paid }
              entity Order identified by OrderId {
                status: Status
              }
              value Invoice {
                status: Status
                order: Order
              }
            }

            context Shipping {
              value Status {
                code: Int
              }
            }
            """;
        var (model, syntax) = new KoineCompiler().Parse(src);
        syntax.ShouldBeEmpty();
        model.ShouldNotBeNull();

        var index = new ModelIndex(model);
        var resolver = new TypeResolver(index, "Billing");
        var checker = new ExpressionChecker(index, resolver, new HashSet<string>(), new List<Diagnostic>());
        var billing = model.Contexts.Single(c => c.Name == "Billing");
        var invoice = (ValueObjectDecl)billing.Types.Single(t => t.Name == "Invoice");
        var scope = TypeScope.FromMembers(invoice.Members, index);

        // Branch 1: a bare identifier that's a field in scope (`status`) — its declared type is
        // Billing's own enum, despite Shipping's unrelated, evicting `Status` value object.
        TypeRef? fieldBranch = checker.ConcreteEnumType(new IdentifierExpr("status"), scope);
        fieldBranch.ShouldNotBeNull();
        fieldBranch!.Name.ShouldBe("Status");

        // Branch 2: a qualified `Status.Draft` reference.
        TypeRef? qualifiedBranch = checker.ConcreteEnumType(
            new MemberAccessExpr(new IdentifierExpr("Status"), "Draft"), scope);
        qualifiedBranch.ShouldNotBeNull();
        qualifiedBranch!.Name.ShouldBe("Status");

        // Branch 3: the general inferred-type fallback, via a nested member access (`order.status`)
        // whose target isn't itself a type name, so branches 1/2 don't match and it falls through here.
        TypeRef? fallbackBranch = checker.ConcreteEnumType(
            new MemberAccessExpr(new IdentifierExpr("order"), "status"), scope);
        fallbackBranch.ShouldNotBeNull();
        fallbackBranch!.Name.ShouldBe("Status");
    }

    /// <summary>
    /// Issue #1655: <c>CheckAggregateSelector</c>'s <c>sum</c>/<c>min</c>/<c>max</c> selector-kind checks
    /// called the context-blind 1-arg <c>ModelIndex.Classify(string)</c> overload directly, instead of the
    /// context-aware <see cref="ModelIndex.Classify(string?, string)"/> overload the way #1634/#1641
    /// already fixed for <c>CheckMember</c>. R13.2 lets Shop and Billing each legally declare their own
    /// <c>Status</c> type — uniqueness is enforced per-context, not globally — so <c>ModelIndex</c>'s
    /// by-name registry is last-write-wins across the whole model: whichever context is indexed last wins
    /// the context-blind classify for every other context's same-named reference too. A context-blind
    /// check answered Billing's later-declared <c>enum Status</c> even for a <c>sum(p =&gt; p)</c> fold
    /// over Shop's own, genuinely-a-value-object <c>Status</c>, wrongly rejecting a valid model with
    /// <c>KOI0212</c>.
    /// </summary>
    [Fact]
    public void Sum_fold_over_a_value_object_resolves_against_its_own_context_despite_a_same_named_type_elsewhere()
    {
        const string src =
            """
            context Shop {
              value Status {
                factor: Int
              }
              value Ticket {
                prices: List<Status>
                total:  Status = prices.sum(p => p)
              }
            }

            context Billing {
              enum Status { Open Closed }
            }
            """;
        Validate(src).ShouldBeEmpty();
    }

    /// <summary>
    /// Guards the fix's boundary: the <c>sum</c> branch must stay narrowly <see cref="TypeKind.Value"/>
    /// -only, NOT widen to <see cref="TypeResolver.IsValueLike"/> (which also accepts
    /// <see cref="TypeKind.IdValueObject"/>). <c>CSharpEmitter</c>'s ID value objects
    /// (<c>EmitIdValueObject</c>) never generate an <c>operator+</c> — only <c>CheckAggregateSelector</c>
    /// stood between an ID-selector <c>sum</c> and <c>WriteSum</c>'s value-like fold emitting
    /// uncompilable <c>a + b</c> over two <c>OrderId</c>s. Widening this check (as an earlier draft of
    /// #1655 did, mirroring the min/max branch's pre-existing <c>IsValueLike</c> call) would have let
    /// this validate with zero diagnostics, then produce a Roslyn compile error downstream.
    /// </summary>
    [Fact]
    public void Sum_fold_over_an_id_value_object_selector_is_still_rejected()
    {
        const string src =
            """
            context Shop {
              entity Order identified by OrderId {
                total: Decimal
              }
              value Batch {
                ids: List<OrderId>
                canonical: OrderId = ids.sum(x => x)
              }
            }
            """;
        Validate(src).ShouldContain(d => d.Code == DiagnosticCodes.AggregateSelector && d.Message.Contains("'OrderId'"));
    }
}
