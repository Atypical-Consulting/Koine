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
        Assert.Empty(diagnostics);
        Assert.NotNull(model);
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
            Assert.Equal(vo.Invariants.Count, bound.Count);

            foreach (BoundInvariant bi in bound)
            {
                any = true;
                // Every bound expression carries a non-null resolved type (ErrorType only where the
                // syntactic resolver also yields error).
                Assert.NotNull(bi.Condition.Type);

                // Every BoundReference carries the SAME interned symbol the binder hands out for its
                // syntactic origin (identity flows from the binder, not a re-lookup).
                foreach (BoundExpression bx in Descend(bi.Condition))
                {
                    Assert.NotNull(bx.Type);
                    if (bx is BoundReference r)
                    {
                        Assert.Same(sema.GetSymbolInfo(bx.Syntax), r.Symbol);
                    }
                }

                // The Syntax back-pointer is the invariant / its condition expr it was lowered from.
                Assert.IsAssignableFrom<Invariant>(bi.Syntax);
                Assert.Same(((Invariant)bi.Syntax).Condition, bi.Condition.Syntax);
            }
        }

        Assert.True(any, "the billing corpus must contain at least one value-object invariant");
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

        BoundInvariant money = Assert.Single(sema.BoundInvariantsFor(byName["Money"]));
        Assert.Equal("a monetary amount cannot be negative", money.Message);

        BoundInvariant ratio = Assert.Single(sema.BoundInvariantsFor(byName["Ratio"]));
        // The `?? SourceText(condition)` default now lives in the lowerer and round-trips the Koine source.
        Assert.Equal("value <= 1", ratio.Message);
        Assert.Equal(Lowerer.SourceText(byName["Ratio"].Invariants[0].Condition), ratio.Message);
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

        Assert.Equal(2, loRefs.Count);
        Assert.Same(loRefs[0].Symbol, loRefs[1].Symbol);
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
        Assert.Equal(2, monies.Count);
        Assert.NotSame(monies[0], monies[1]);

        BoundInvariant a = Assert.Single(sema.BoundInvariantsFor(monies[0]));
        BoundInvariant b = Assert.Single(sema.BoundInvariantsFor(monies[1]));

        // Distinct cache entries: the two synthesized messages differ (>= 0 vs >= 1). A value-keyed
        // cache would collide them to one entry and one of these assertions would fail.
        Assert.Equal("amount >= 0", a.Message);
        Assert.Equal("amount >= 1", b.Message);
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
        Assert.Equal(probe.Invariants.Count, bound.Count);

        // Every bound condition is a typed BoundExpression and every descendant has a non-null type.
        foreach (BoundInvariant bi in bound)
        {
            foreach (BoundExpression bx in Descend(bi.Condition))
            {
                Assert.NotNull(bx.Type);
            }
        }

        // At least one of each headline form was actually produced.
        var all = bound.SelectMany(b => Descend(b.Condition)).ToList();
        Assert.Contains(all, x => x is BoundBinary);
        Assert.Contains(all, x => x is BoundUnary);
        Assert.Contains(all, x => x is BoundMatch);
        Assert.Contains(all, x => x is BoundGuard);
        Assert.Contains(all, x => x is BoundMemberAccess);
        Assert.Contains(all, x => x is BoundCall);
        Assert.Contains(all, x => x is BoundConditional);
        Assert.Contains(all, x => x is BoundCoalesce);
        Assert.Contains(all, x => x is BoundLet);
        Assert.Contains(all, x => x is BoundLambda);
        Assert.Contains(all, x => x is BoundLiteral);
        Assert.Contains(all, x => x is BoundReference);
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
        Assert.Same(ErrorSymbol.Instance, reference.Symbol);
        Assert.Equal("nope >= 0", bound.Message);
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
        Assert.Equal(probe.Members.Select(m => m.Name), bound.Fields.Select(f => f.Name));

        // Kind matches the shared MemberAnalysis classification the emitter used to re-derive.
        var memberNames = new HashSet<string>(probe.Members.Select(m => m.Name), StringComparer.Ordinal);
        foreach ((Member m, BoundField f) in probe.Members.Zip(bound.Fields))
        {
            FieldKind expected = MemberAnalysis.IsDerived(m, memberNames) ? FieldKind.Derived : FieldKind.CtorParam;
            Assert.Equal(expected, f.Kind);
            // Every field carries a resolved type and back-points to its member.
            Assert.NotNull(f.Type);
            Assert.Same(m, f.Syntax);
        }

        Assert.Equal(FieldKind.Derived, bound.Fields.Single(f => f.Name == "doubled").Kind);
    }

    [Fact]
    public void Ctor_params_put_defaulted_and_optional_fields_last_preserving_declaration_order()
    {
        var sema = Build(ProjectionSrc);
        var order = Probe(sema).CtorParams.Select(f => f.Name).ToList();

        // Required fields (declaration order) first; defaulted/optional (declaration order) last.
        // 'doubled' is derived and excluded entirely.
        Assert.Equal(new[] { "amount", "tags", "codes", "meta", "note", "qty", "status" }, order);
    }

    [Fact]
    public void Default_kind_classifies_required_optional_constant_and_enum_defaults()
    {
        var sema = Build(ProjectionSrc);
        var byName = Probe(sema).Fields.ToDictionary(f => f.Name);

        Assert.Equal(DefaultKind.None, byName["amount"].DefaultKind);   // required, no initializer
        Assert.Equal(DefaultKind.OptionalNull, byName["note"].DefaultKind); // optional, no initializer
        Assert.Equal(DefaultKind.ConstantDefault, byName["qty"].DefaultKind); // non-enum initializer
        Assert.Equal(DefaultKind.EnumDefault, byName["status"].DefaultKind);  // enum-typed initializer
        Assert.Equal(DefaultKind.None, byName["doubled"].DefaultKind);  // derived => no ctor default
    }

    [Fact]
    public void Collection_shape_classifies_list_set_map_and_scalar()
    {
        var sema = Build(ProjectionSrc);
        var byName = Probe(sema).Fields.ToDictionary(f => f.Name);

        Assert.Equal(CollectionShape.List, byName["tags"].CollectionShape);
        Assert.Equal(CollectionShape.Set, byName["codes"].CollectionShape);
        Assert.Equal(CollectionShape.Map, byName["meta"].CollectionShape);
        Assert.Equal(CollectionShape.None, byName["amount"].CollectionShape);
    }

    [Fact]
    public void Derived_field_carries_its_lowered_initializer_and_ctor_fields_do_not()
    {
        var sema = Build(ProjectionSrc);
        ValueObjectDecl probe = ValueObjects(sema).Single(v => v.Name == "Probe");
        var byName = sema.BoundValueObjectFor(probe).Fields.ToDictionary(f => f.Name);

        BoundField doubled = byName["doubled"];
        Assert.NotNull(doubled.DerivedInitializer);
        // The lowered initializer back-points to the member's syntactic initializer.
        Assert.Same(probe.Members.Single(m => m.Name == "doubled").Initializer, doubled.DerivedInitializer!.Syntax);

        Assert.Null(byName["amount"].DerivedInitializer);
        Assert.Null(byName["qty"].DerivedInitializer); // a constant default is NOT a derived initializer
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
        BoundInvariant folded = Assert.Single(bound.Invariants);
        // The folded invariants are the same projection the Commit-4 entry point exposes.
        Assert.Equal(sema.BoundInvariantsFor(money), bound.Invariants);
        Assert.Equal("amount >= 0", folded.Message);
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
        Assert.Equal(2, monies.Count);

        BoundValueObject a = sema.BoundValueObjectFor(monies[0]);
        BoundValueObject b = sema.BoundValueObjectFor(monies[1]);

        // Distinct projections: A has a derived field, B does not (a value-keyed cache would collide them).
        Assert.Contains(a.Fields, f => f.Kind == FieldKind.Derived);
        Assert.DoesNotContain(b.Fields, f => f.Kind == FieldKind.Derived);
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
