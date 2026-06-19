using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The bound-IR + Lowerer slice (Commit 4): value-object invariants are lowered to a resolved, desugared
/// <see cref="BoundInvariant"/> (every reference carries its Commit-3 interned <see cref="Symbol"/>, every
/// bound expression its <see cref="KoineType"/>, and the C# message default already applied). The slice is
/// proven byte-identical by the Verify snapshot suite and the Roslyn meta-test elsewhere; this suite proves
/// the layer is real (resolution + message desugaring), reference-keyed (the value-equality-record hazard),
/// and total over the reachable expression forms.
/// </summary>
public class BoundIrLoweringTests
{
    private static SemanticModel Build(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model!);
    }

    private static IEnumerable<ValueObjectDecl> ValueObjects(SemanticModel sema) =>
        NodeWalker.Descendants(sema.Model).OfType<ValueObjectDecl>();

    // ----------------------------------------------------------------------
    // 1. Bound-tree resolution — the layer is real, not dead.
    // ----------------------------------------------------------------------

    [Fact]
    public void Lowered_invariant_condition_is_typed_and_references_carry_interned_symbols()
    {
        var sema = Build(TestSupport.BillingFixture);

        var any = false;
        foreach (ValueObjectDecl vo in ValueObjects(sema))
        {
            IReadOnlyList<BoundInvariant> bound = sema.BoundInvariantsFor(vo);
            bound.Count.ShouldBe(vo.Invariants.Count);

            foreach (BoundInvariant bi in bound)
            {
                any = true;
                // Every bound expression carries a non-null resolved type (ErrorType only where the
                // syntactic resolver also yields error).
                bi.Condition.Type.ShouldNotBeNull();

                // Every BoundReference carries the SAME interned symbol the binder hands out for its
                // syntactic origin (identity flows from the binder, not a re-lookup).
                foreach (BoundExpression bx in Descend(bi.Condition))
                {
                    bx.Type.ShouldNotBeNull();
                    if (bx is BoundReference r)
                    {
                        r.Symbol.ShouldBeSameAs(sema.GetSymbolInfo(bx.Syntax));
                    }
                }

                // The Syntax back-pointer is the invariant / its condition expr it was lowered from.
                bi.Syntax.ShouldBeAssignableTo<Invariant>();
                bi.Condition.Syntax.ShouldBeSameAs(((Invariant)bi.Syntax).Condition);
            }
        }

        any.ShouldBeTrue("the billing corpus must contain at least one value-object invariant");
    }

    // ----------------------------------------------------------------------
    // 2. Message-default lowering — the desugaring is absorbed.
    // ----------------------------------------------------------------------

    [Fact]
    public void Explicit_message_is_preserved_and_missing_message_is_synthesized()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0   "a monetary amount cannot be negative"
              }
              value Ratio {
                value: Decimal
                invariant value <= 1
              }
            }
            """;
        var sema = Build(src);

        var byName = ValueObjects(sema).ToDictionary(v => v.Name);

        BoundInvariant money = sema.BoundInvariantsFor(byName["Money"]).ShouldHaveSingleItem();
        money.Message.ShouldBe("a monetary amount cannot be negative");

        BoundInvariant ratio = sema.BoundInvariantsFor(byName["Ratio"]).ShouldHaveSingleItem();
        // The `?? SourceText(condition)` default now lives in the lowerer and round-trips the Koine source.
        ratio.Message.ShouldBe("value <= 1");
        ratio.Message.ShouldBe(Lowerer.SourceText(byName["Ratio"].Invariants[0].Condition));
    }

    // ----------------------------------------------------------------------
    // 3. Reference-key identity — the value-equality-record hazard (4th incarnation).
    // ----------------------------------------------------------------------

    [Fact]
    public void Two_references_to_one_member_bind_to_the_same_interned_symbol()
    {
        const string src = """
            context Shop {
              value Span {
                lo: Int
                hi: Int
                invariant lo >= 0
                invariant lo <= hi
              }
            }
            """;
        var sema = Build(src);
        ValueObjectDecl span = ValueObjects(sema).Single();

        IReadOnlyList<BoundInvariant> bound = sema.BoundInvariantsFor(span);
        var loRefs = bound
            .SelectMany(b => Descend(b.Condition))
            .OfType<BoundReference>()
            .Where(r => r.Symbol.Name == "lo")
            .ToList();

        loRefs.Count.ShouldBe(2);
        loRefs[1].Symbol.ShouldBeSameAs(loRefs[0].Symbol);
    }

    [Fact]
    public void Cache_is_reference_keyed_so_same_named_value_objects_across_contexts_do_not_collide()
    {
        // Two value objects named `Money` in different contexts are value-equal as records EXCEPT for
        // their distinct member spans; the BoundModel cache must key by reference, never value.
        const string src = """
            context A {
              value Money { amount: Decimal  invariant amount >= 0 }
            }
            context B {
              value Money { amount: Decimal  invariant amount >= 1 }
            }
            """;
        var sema = Build(src);
        List<ValueObjectDecl> monies = ValueObjects(sema).Where(v => v.Name == "Money").ToList();
        monies.Count.ShouldBe(2);
        monies[1].ShouldNotBeSameAs(monies[0]);

        BoundInvariant a = sema.BoundInvariantsFor(monies[0]).ShouldHaveSingleItem();
        BoundInvariant b = sema.BoundInvariantsFor(monies[1]).ShouldHaveSingleItem();

        // Distinct cache entries: the two synthesized messages differ (>= 0 vs >= 1). A value-keyed
        // cache would collide them to one entry and one of these assertions would fail.
        a.Message.ShouldBe("amount >= 0");
        b.Message.ShouldBe("amount >= 1");
    }

    // ----------------------------------------------------------------------
    // 6. Lowerer coverage / no-throw across every reachable expression form.
    // ----------------------------------------------------------------------

    [Fact]
    public void Every_reachable_expression_form_lowers_without_throwing()
    {
        // A single value object whose (artificial) invariants exercise binary/unary/comparison, match,
        // when-guard, member access, built-in call, conditional, coalesce, let, and literals.
        const string src = """
            context Shop {
              value Probe {
                amount:   Decimal
                code:     String
                discount: Decimal?
                tags:     List<String>
                invariant amount >= 0 && !(amount > 1000000)
                invariant code matches /^[A-Z]+$/
                invariant amount > 0 when amount > 0
                invariant code.startsWith("X")
                invariant !tags.isEmpty
                invariant tags.all(t => t != "")
                invariant (if amount > 0 then amount else 0) >= 0
                invariant (discount ?? 0) >= 0
                invariant (let x = amount in x) >= 0
              }
            }
            """;
        var sema = Build(src);
        ValueObjectDecl probe = ValueObjects(sema).Single();

        IReadOnlyList<BoundInvariant> bound = sema.BoundInvariantsFor(probe);
        bound.Count.ShouldBe(probe.Invariants.Count);

        // Every bound condition is a typed BoundExpression and every descendant has a non-null type.
        foreach (BoundInvariant bi in bound)
        {
            foreach (BoundExpression bx in Descend(bi.Condition))
            {
                bx.Type.ShouldNotBeNull();
            }
        }

        // At least one of each headline form was actually produced.
        var all = bound.SelectMany(b => Descend(b.Condition)).ToList();
        all.ShouldContain(x => x is BoundBinary);
        all.ShouldContain(x => x is BoundUnary);
        all.ShouldContain(x => x is BoundMatch);
        all.ShouldContain(x => x is BoundGuard);
        all.ShouldContain(x => x is BoundMemberAccess);
        all.ShouldContain(x => x is BoundCall);
        all.ShouldContain(x => x is BoundConditional);
        all.ShouldContain(x => x is BoundCoalesce);
        all.ShouldContain(x => x is BoundLet);
        all.ShouldContain(x => x is BoundLambda);
        all.ShouldContain(x => x is BoundLiteral);
        all.ShouldContain(x => x is BoundReference);
    }

    [Fact]
    public void Unknown_name_lowers_to_an_error_reference_without_throwing()
    {
        // A reference to a name that resolves to nothing must lower to BoundReference(ErrorSymbol),
        // mirroring the binder — lowering never throws on an unresolved reference.
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
            }
            """;
        var sema = Build(src);
        ValueObjectDecl money = ValueObjects(sema).Single();

        // Hand-build an invariant referencing an unknown name and lower it through the same model.
        var unknown = new IdentifierExpr("nope");
        var condition = new BinaryExpr(BinaryOp.Ge, unknown, new LiteralExpr(LiteralKind.Int, "0"));
        var inv = new Invariant(condition, Message: null);

        var lowerer = new Lowerer(sema, TypeScope.FromMembers(money.Members, sema.Index), context: null);
        BoundInvariant bound = lowerer.LowerInvariant(inv);

        var reference = Descend(bound.Condition).OfType<BoundReference>().Single();
        reference.Symbol.ShouldBeSameAs(ErrorSymbol.Instance);
        bound.Message.ShouldBe("nope >= 0");
    }

    // ----------------------------------------------------------------------
    // 7. Value-object field projection (Commit 5) — the widened slice.
    // ----------------------------------------------------------------------

    private const string ProjectionSrc = """
        context Shop {
          enum Status { Draft, Active }
          value Probe {
            amount:  Decimal
            tags:    List<String>
            codes:   Set<String>
            meta:    Map<String, String>
            note:    String?
            qty:     Int = 1
            status:  Status = Draft
            doubled: Decimal = amount * 2
          }
        }
        """;

    private static BoundValueObject Probe(SemanticModel sema) =>
        sema.BoundValueObjectFor(ValueObjects(sema).Single(v => v.Name == "Probe"));

    [Fact]
    public void Projection_has_one_field_per_member_in_declaration_order_with_matching_kind()
    {
        var sema = Build(ProjectionSrc);
        ValueObjectDecl probe = ValueObjects(sema).Single(v => v.Name == "Probe");
        BoundValueObject bound = sema.BoundValueObjectFor(probe);

        // One bound field per declared member, same order, same name.
        bound.Fields.Select(f => f.Name).ShouldBe(probe.Members.Select(m => m.Name));

        // Kind matches the shared MemberAnalysis classification the emitter used to re-derive.
        var memberNames = new HashSet<string>(probe.Members.Select(m => m.Name), StringComparer.Ordinal);
        foreach ((Member m, BoundField f) in probe.Members.Zip(bound.Fields))
        {
            FieldKind expected = MemberAnalysis.IsDerived(m, memberNames) ? FieldKind.Derived : FieldKind.CtorParam;
            f.Kind.ShouldBe(expected);
            // Every field carries a resolved type and back-points to its member.
            f.Type.ShouldNotBeNull();
            f.Syntax.ShouldBeSameAs(m);
        }

        bound.Fields.Single(f => f.Name == "doubled").Kind.ShouldBe(FieldKind.Derived);
    }

    [Fact]
    public void Ctor_params_put_defaulted_and_optional_fields_last_preserving_declaration_order()
    {
        var sema = Build(ProjectionSrc);
        var order = Probe(sema).CtorParams.Select(f => f.Name).ToList();

        // Required fields (declaration order) first; defaulted/optional (declaration order) last.
        // 'doubled' is derived and excluded entirely.
        order.ShouldBe(new[] { "amount", "tags", "codes", "meta", "note", "qty", "status" });
    }

    [Fact]
    public void Default_kind_classifies_required_optional_constant_and_enum_defaults()
    {
        var sema = Build(ProjectionSrc);
        var byName = Probe(sema).Fields.ToDictionary(f => f.Name);

        byName["amount"].DefaultKind.ShouldBe(DefaultKind.None);   // required, no initializer
        byName["note"].DefaultKind.ShouldBe(DefaultKind.OptionalNull); // optional, no initializer
        byName["qty"].DefaultKind.ShouldBe(DefaultKind.ConstantDefault); // non-enum initializer
        byName["status"].DefaultKind.ShouldBe(DefaultKind.EnumDefault);  // enum-typed initializer
        byName["doubled"].DefaultKind.ShouldBe(DefaultKind.None);  // derived => no ctor default
    }

    [Fact]
    public void Collection_shape_classifies_list_set_map_and_scalar()
    {
        var sema = Build(ProjectionSrc);
        var byName = Probe(sema).Fields.ToDictionary(f => f.Name);

        byName["tags"].CollectionShape.ShouldBe(CollectionShape.List);
        byName["codes"].CollectionShape.ShouldBe(CollectionShape.Set);
        byName["meta"].CollectionShape.ShouldBe(CollectionShape.Map);
        byName["amount"].CollectionShape.ShouldBe(CollectionShape.None);
    }

    [Fact]
    public void Derived_field_carries_its_lowered_initializer_and_ctor_fields_do_not()
    {
        var sema = Build(ProjectionSrc);
        ValueObjectDecl probe = ValueObjects(sema).Single(v => v.Name == "Probe");
        var byName = sema.BoundValueObjectFor(probe).Fields.ToDictionary(f => f.Name);

        BoundField doubled = byName["doubled"];
        doubled.DerivedInitializer.ShouldNotBeNull();
        // The lowered initializer back-points to the member's syntactic initializer.
        doubled.DerivedInitializer!.Syntax.ShouldBeSameAs(probe.Members.Single(m => m.Name == "doubled").Initializer);

        byName["amount"].DerivedInitializer.ShouldBeNull();
        byName["qty"].DerivedInitializer.ShouldBeNull(); // a constant default is NOT a derived initializer
    }

    [Fact]
    public void Projection_folds_in_the_lowered_invariants()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
            }
            """;
        var sema = Build(src);
        ValueObjectDecl money = ValueObjects(sema).Single();

        BoundValueObject bound = sema.BoundValueObjectFor(money);
        BoundInvariant folded = bound.Invariants.ShouldHaveSingleItem();
        // The folded invariants are the same projection the Commit-4 entry point exposes.
        bound.Invariants.ShouldBe(sema.BoundInvariantsFor(money));
        folded.Message.ShouldBe("amount >= 0");
    }

    [Fact]
    public void Projection_cache_is_reference_keyed_across_same_named_value_objects()
    {
        const string src = """
            context A {
              value Money { amount: Decimal  half: Decimal = amount / 2 }
            }
            context B {
              value Money { amount: Decimal }
            }
            """;
        var sema = Build(src);
        List<ValueObjectDecl> monies = ValueObjects(sema).Where(v => v.Name == "Money").ToList();
        monies.Count.ShouldBe(2);

        BoundValueObject a = sema.BoundValueObjectFor(monies[0]);
        BoundValueObject b = sema.BoundValueObjectFor(monies[1]);

        // Distinct projections: A has a derived field, B does not (a value-keyed cache would collide them).
        a.Fields.ShouldContain(f => f.Kind == FieldKind.Derived);
        b.Fields.ShouldNotContain(f => f.Kind == FieldKind.Derived);
    }

    [Fact]
    public void Derived_initializer_carries_resolved_types_the_emitter_consumes_for_rendering()
    {
        // Commit 6: the C# emitter renders a derived body from its lowered BoundExpression, reading
        // resolved types (e.g. the enum type of a member reference, for enum-member qualification) off the
        // bound tree instead of re-inferring them. This proves that payload is present and correct.
        const string src = """
            context Shop {
              enum Status { Draft, Active }
              value Sale {
                status: Status
                isActive: Bool = status == Active
              }
            }
            """;
        var sema = Build(src);
        ValueObjectDecl sale = ValueObjects(sema).Single();
        BoundField isActive = sema.BoundValueObjectFor(sale).Fields.Single(f => f.Name == "isActive");

        isActive.Kind.ShouldBe(FieldKind.Derived);
        isActive.DerivedInitializer.ShouldNotBeNull();

        // The `status` reference inside the body resolves to the Status enum on the bound node — the type
        // the translator's enum-hint logic now consumes rather than re-deriving.
        BoundReference statusRef = Descend(isActive.DerivedInitializer!)
            .OfType<BoundReference>()
            .Single(r => r.Symbol.Name == "status");
        statusRef.Type.Name.ShouldBe("Status");
        statusRef.Type.Kind.ShouldBe(TypeKind.Enum);
    }

    // ----------------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------------

    /// <summary>Every bound expression at or under <paramref name="root"/> (pre-order).</summary>
    private static IEnumerable<BoundExpression> Descend(BoundExpression root)
    {
        yield return root;
        foreach (BoundExpression child in ChildExprs(root))
        {
            foreach (BoundExpression d in Descend(child))
            {
                yield return d;
            }
        }
    }

    private static IEnumerable<BoundExpression> ChildExprs(BoundExpression e) => e switch
    {
        BoundBinary b => new[] { b.Left, b.Right },
        BoundUnary u => new[] { u.Operand },
        BoundMemberAccess m => new[] { m.Receiver },
        BoundCall c => new[] { c.Receiver }.Concat(c.Args),
        BoundConditional cd => new[] { cd.Condition, cd.Then, cd.Else },
        BoundCoalesce co => new[] { co.Left, co.Right },
        BoundMatch ma => new[] { ma.Target },
        BoundGuard g => new[] { g.Body, g.Condition },
        BoundLambda l => new[] { l.Body },
        BoundLet let => let.Bindings.Select(bn => bn.Value).Append(let.Body),
        _ => Enumerable.Empty<BoundExpression>()
    };
}
