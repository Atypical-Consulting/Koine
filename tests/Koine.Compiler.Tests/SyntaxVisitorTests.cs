using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Semantics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Behavior tests for the source-generated typed visitor/rewriter family
/// (<see cref="KoineSyntaxVisitor"/> / <see cref="KoineSyntaxVisitor{TResult}"/> /
/// <see cref="KoineSyntaxRewriter"/> / <c>KoineSyntaxChildEnumerator</c>), Commit 2 of the
/// Roslyn-shaped architecture. The reflection-based <see cref="NodeWalker"/> is the independent
/// oracle: the generated child enumeration must agree with it (as a reference-identity SET), and the
/// rewriter must honor the identity invariant.
/// </summary>
public class SyntaxVisitorTests
{
    private static KoineModel Parse(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return model!;
    }

    // A small but slot-shape-complete corpus: required/optional/list children, IReadOnlyList<string>
    // (ModuleNames/Names/To/etc. — must stay excluded), a regex `matches`, a state machine with a
    // guard (optional Expr child), computed/derived members, defaults, List<>, a let/conditional.
    private const string RichSrc =
        "context Shop {\n" +
        "  value Money { amount: Decimal\n" +
        "    invariant amount > 0 \"must be positive\"\n" +
        "  }\n" +
        "  enum Currency { EUR(\"€\", 2), USD(\"$\", 2) }\n" +
        "  value OrderLine {\n" +
        "    unitPrice: Decimal\n" +
        "    quantity: Int\n" +
        "    subtotal: Decimal = unitPrice * quantity\n" +
        "  }\n" +
        "  spec Positive on Money = amount > 0\n" +
        "}\n";

    public static IEnumerable<object[]> Corpus() =>
        new[]
        {
            new object[] { RichSrc },
            new object[] { TestSupport.BillingFixture },
        };

    // ------------------------------------------------------------------------
    // (1) Oracle equivalence — reference-identity SET + canonical-order pin.
    // ------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Generated_children_match_NodeWalker_as_a_reference_identity_set(string src)
    {
        var model = Parse(src);

        foreach (var node in NodeWalker.Descendants(model))
        {
            var oracle = new HashSet<KoineNode>(
                NodeWalker.ChildNodes(node), ReferenceEqualityComparer.Instance);
            var generated = new HashSet<KoineNode>(
                KoineSyntaxChildEnumerator.Children(node), ReferenceEqualityComparer.Instance);

            // SetEquals over the reference-identity comparer: value-equal-but-distinct nodes
            // (the many IdentifierExpr("amount")) are kept distinct, exactly as the graph needs.
            oracle.SetEquals(generated).ShouldBeTrue($"Child set mismatch for {node.GetType().Name}: " +
                $"oracle={oracle.Count}, generated={generated.Count}");
        }
    }

    [Fact]
    public void Generated_children_are_in_canonical_primary_ctor_order()
    {
        // BinaryExpr(Op, Left, Right): Op is a scalar (excluded), so canonical child order is Left, Right.
        var left = new IdentifierExpr("a");
        var right = new LiteralExpr(LiteralKind.Int, "1");
        var bin = new BinaryExpr(BinaryOp.Gt, left, right);
        KoineSyntaxChildEnumerator.Children(bin).ToArray().ShouldBe(new KoineNode[] { left, right });

        // ContextNode: child slots are the KoineNode lists in primary-ctor order
        // (Types, Specs, Services, Policies, Imports, Publishes, Subscribes) — ModuleNames
        // (IReadOnlyList<string>) and Name (string) are excluded.
        var ctx = new ContextNode(
            Name: "C",
            Types: new TypeDecl[] { new ValueObjectDecl("V", Array.Empty<Member>(), Array.Empty<Invariant>()) },
            Specs: Array.Empty<SpecDecl>(),
            Services: Array.Empty<ServiceDecl>(),
            Policies: Array.Empty<PolicyDecl>(),
            Imports: new[] { new ImportDecl("Other", new[] { "X" }, false) },
            ModuleNames: new[] { "m1", "m2" },
            Publishes: Array.Empty<PublishDecl>(),
            Subscribes: Array.Empty<SubscribeDecl>());

        var kids = KoineSyntaxChildEnumerator.Children(ctx).ToArray();
        kids.Length.ShouldBe(2);
        kids[0].ShouldBeOfType<ValueObjectDecl>();   // Types come before Imports in the ctor
        kids[1].ShouldBeOfType<ImportDecl>();
    }

    // ------------------------------------------------------------------------
    // (2) Rewriter identity invariant.
    // ------------------------------------------------------------------------

    private sealed class NoOpRewriter : KoineSyntaxRewriter { }

    [Theory]
    [MemberData(nameof(Corpus))]
    public void NoOp_rewriter_returns_the_same_instance_for_root_and_every_descendant(string src)
    {
        var model = Parse(src);
        var rewritten = new NoOpRewriter().Visit(model);

        rewritten.ShouldBeSameAs(model);

        // Stronger: every descendant is reference-identical (a no-op must allocate nothing).
        var before = NodeWalker.Descendants(model).ToList();
        var after = NodeWalker.Descendants((KoineModel)rewritten!).ToList();
        after.Count.ShouldBe(before.Count);
        for (var i = 0; i < before.Count; i++)
        {
            after[i].ShouldBeSameAs(before[i]);
        }
    }

    // Replaces exactly one specific LiteralExpr instance with a different instance.
    private sealed class ReplaceLiteralRewriter : KoineSyntaxRewriter
    {
        private readonly LiteralExpr _target;
        private readonly LiteralExpr _replacement;

        public ReplaceLiteralRewriter(LiteralExpr target, LiteralExpr replacement)
        {
            _target = target;
            _replacement = replacement;
        }

        public override KoineNode? VisitLiteralExpr(LiteralExpr node) =>
            ReferenceEquals(node, _target) ? _replacement : node;
    }

    [Fact]
    public void One_leaf_rewrite_reallocates_only_the_leaf_to_root_spine()
    {
        var model = Parse(RichSrc);
        var graph = new SyntaxGraph(model);

        // The "0" literal inside Money's `invariant amount > 0`.
        var target = NodeWalker.Descendants(model)
            .OfType<LiteralExpr>()
            .First(l => l is { Kind: LiteralKind.Int, Text: "0" });

        var spine = new HashSet<KoineNode>(graph.AncestorsAndSelf(target), ReferenceEqualityComparer.Instance);

        var replacement = new LiteralExpr(LiteralKind.Int, "0");   // value-equal but a DIFFERENT instance
        replacement.ShouldNotBeSameAs(target);

        var rewritten = (KoineModel)new ReplaceLiteralRewriter(target, replacement).Visit(model)!;
        rewritten.ShouldNotBeSameAs(model);

        // Every ORIGINAL node NOT on the spine must be reference-identical in the rewritten tree.
        // Match nodes positionally against the original walk (canonical order is stable).
        var originals = NodeWalker.Descendants(model).ToList();
        var rewrittenNodes = NodeWalker.Descendants(rewritten).ToList();
        rewrittenNodes.Count.ShouldBe(originals.Count);

        var spineReallocated = false;
        for (var i = 0; i < originals.Count; i++)
        {
            if (spine.Contains(originals[i]))
            {
                if (!ReferenceEquals(originals[i], rewrittenNodes[i]))
                {
                    spineReallocated = true;
                }
            }
            else
            {
                // Off-spine subtree keeps its identity (O(depth) structural sharing).
                rewrittenNodes[i].ShouldBeSameAs(originals[i]);
            }
        }

        spineReallocated.ShouldBeTrue("expected the leaf→root spine to reallocate");
        // The leaf itself was replaced with the new instance.
        rewrittenNodes.ShouldContain(n => ReferenceEquals(n, replacement));
    }

    // ------------------------------------------------------------------------
    // (3) VisitList value-equality trap.
    // ------------------------------------------------------------------------

    // Rewrites one Member to a value-EQUAL but reference-DIFFERENT instance. A value-equality
    // comparison in VisitList would treat it as unchanged and wrongly keep the old list+spine.
    private sealed class ReplaceMemberRewriter : KoineSyntaxRewriter
    {
        private readonly Member _target;
        private readonly Member _replacement;

        public ReplaceMemberRewriter(Member target, Member replacement)
        {
            _target = target;
            _replacement = replacement;
        }

        public override KoineNode? VisitMember(Member node) =>
            ReferenceEquals(node, _target) ? _replacement : node;
    }

    [Fact]
    public void VisitList_uses_reference_equality_so_a_value_equal_replacement_reallocates()
    {
        var amount = new Member("amount", new TypeRef("Decimal"), Initializer: null);
        var vo = new ValueObjectDecl("Money", new[] { amount }, Array.Empty<Invariant>());

        // A value-equal Member, but a distinct instance.
        var replacement = new Member("amount", new TypeRef("Decimal"), Initializer: null);
        replacement.ShouldBe(amount);     // value equality holds
        replacement.ShouldNotBeSameAs(amount);

        var rewritten = (ValueObjectDecl)new ReplaceMemberRewriter(amount, replacement).Visit(vo)!;

        rewritten.ShouldNotBeSameAs(vo);                       // spine reallocated
        rewritten.Members.ShouldNotBeSameAs(vo.Members);       // list reallocated
        rewritten.Members[0].ShouldBeSameAs(replacement);      // the new instance is in place
    }

    // ------------------------------------------------------------------------
    // (4) Rewriter null / wrong-type contract.
    // ------------------------------------------------------------------------

    private sealed class NullRequiredRewriter : KoineSyntaxRewriter
    {
        // Returns null for an Expr — fed into a REQUIRED slot (BinaryExpr.Left).
        public override KoineNode? VisitIdentifierExpr(IdentifierExpr node) => null;
    }

    [Fact]
    public void Required_slot_rewritten_to_null_throws_naming_the_slot()
    {
        var bin = new BinaryExpr(BinaryOp.Gt, new IdentifierExpr("a"), new LiteralExpr(LiteralKind.Int, "0"));
        var ex = Should.Throw<InvalidOperationException>(() => new NullRequiredRewriter().Visit(bin));
        ex.Message.ShouldContain("Left");
        ex.Message.ShouldContain("BinaryExpr");
    }

    private sealed class ClearOptionalRewriter : KoineSyntaxRewriter
    {
        // Returns null for the initializer Expr — fed into an OPTIONAL slot (Member.Initializer).
        public override KoineNode? VisitLiteralExpr(LiteralExpr node) => null;
    }

    [Fact]
    public void Optional_slot_rewritten_to_null_is_cleared_without_throwing()
    {
        var member = new Member("status", new TypeRef("Int"), new LiteralExpr(LiteralKind.Int, "1"));
        var rewritten = (Member)new ClearOptionalRewriter().Visit(member)!;

        rewritten.ShouldNotBeSameAs(member);
        rewritten.Initializer.ShouldBeNull();
        rewritten.Type.ShouldBeSameAs(member.Type);   // the type slot was untouched
    }

    private sealed class NullListElementRewriter : KoineSyntaxRewriter
    {
        public override KoineNode? VisitMember(Member node) => null;
    }

    [Fact]
    public void List_element_rewritten_to_null_throws()
    {
        var member = new Member("amount", new TypeRef("Decimal"), Initializer: null);
        var vo = new ValueObjectDecl("Money", new[] { member }, Array.Empty<Invariant>());

        var ex = Should.Throw<InvalidOperationException>(() => new NullListElementRewriter().Visit(vo));
        ex.Message.ShouldContain("Members");
    }

    // Returns a non-Expr (a TypeRef) where a required Expr slot is expected — the generated cast throws.
    private sealed class WrongTypeRewriter : KoineSyntaxRewriter
    {
        public override KoineNode? VisitIdentifierExpr(IdentifierExpr node) => new TypeRef("NotAnExpr");
    }

    [Fact]
    public void Wrong_typed_slot_rewrite_throws_InvalidCastException()
    {
        var bin = new BinaryExpr(BinaryOp.Gt, new IdentifierExpr("a"), new LiteralExpr(LiteralKind.Int, "0"));
        Should.Throw<InvalidCastException>(() => new WrongTypeRewriter().Visit(bin));
    }

    // ------------------------------------------------------------------------
    // (5) Round-trip through the real pipeline: no-op rewrite then validate + emit.
    // ------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(Corpus))]
    public void NoOp_rewrite_then_validate_and_emit_is_byte_identical(string src)
    {
        var model = Parse(src);

        // Baseline: validate + emit the original model.
        var (baselineDiags, baselineCSharp) = ValidateAndEmit(model);

        // No-op rewrite the model, then validate + emit the result.
        var rewritten = (KoineModel)new NoOpRewriter().Visit(model)!;
        var (rewrittenDiags, rewrittenCSharp) = ValidateAndEmit(rewritten);

        rewrittenDiags.ShouldBe(baselineDiags);
        rewrittenCSharp.ShouldBe(baselineCSharp);
    }

    private static (string Diags, string CSharp) ValidateAndEmit(KoineModel model)
    {
        var semantic = new SemanticModel(model);
        var diags = new SemanticValidator().Validate(semantic);
        var diagText = string.Join("\n",
            diags.Select(d => $"{d.Severity} {d.Code} {d.Message} @ {d.Span.Offset}")
                 .OrderBy(s => s, StringComparer.Ordinal));

        var files = new CSharpEmitter().Emit(model, semantic);
        return (diagText, TestSupport.Render(files));
    }

    // ------------------------------------------------------------------------
    // (6) Typed dispatch: Visit<int> count parity with the reflection oracle.
    // ------------------------------------------------------------------------

    private sealed class IdentifierCounter : KoineSyntaxVisitor<int>
    {
        public override int VisitIdentifierExpr(IdentifierExpr node)
        {
            // Count this node plus any nested identifiers (none, but recurse for generality).
            var nested = 0;
            foreach (var child in KoineSyntaxChildEnumerator.Children(node))
            {
                nested += Visit(child);
            }

            return 1 + nested;
        }

        public override int DefaultVisit(KoineNode node)
        {
            var sum = 0;
            foreach (var child in KoineSyntaxChildEnumerator.Children(node))
            {
                sum += Visit(child);
            }

            return sum;
        }
    }

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Typed_int_visitor_counts_identifiers_like_the_oracle(string src)
    {
        var model = Parse(src);

        var oracle = NodeWalker.Descendants(model).OfType<IdentifierExpr>().Count();
        var counted = new IdentifierCounter().Visit(model);

        counted.ShouldBe(oracle);
    }

    // ------------------------------------------------------------------------
    // (7) Optional / list edges.
    // ------------------------------------------------------------------------

    [Fact]
    public void Optional_and_list_edges_yield_no_phantom_children()
    {
        // Member with no initializer → only its TypeRef child.
        var member = new Member("amount", new TypeRef("Decimal"), Initializer: null);
        KoineSyntaxChildEnumerator.Children(member).ShouldHaveSingleItem();   // just the TypeRef

        // CallExpr with empty Args → only the Target child.
        var call = new CallExpr(new IdentifierExpr("x"), "method", Array.Empty<Expr>());
        KoineSyntaxChildEnumerator.Children(call).ShouldHaveSingleItem();     // just the Target

        // KoineModel with null ContextMap → only its Contexts.
        var model = new KoineModel(Array.Empty<ContextNode>(), ContextMap: null);
        KoineSyntaxChildEnumerator.Children(model).ShouldBeEmpty();
    }

    // ------------------------------------------------------------------------
    // (8) Generator fail-closed: a known-present node is handled.
    // ------------------------------------------------------------------------

    [Fact]
    public void Generator_emitted_handlers_for_known_present_nodes()
    {
        // A silently-empty (fail-open) generation would route everything to DefaultVisit and
        // yield no children. Assert a known node's children are enumerated by the GENERATED switch.
        var bin = new BinaryExpr(BinaryOp.Gt, new IdentifierExpr("a"), new LiteralExpr(LiteralKind.Int, "0"));
        var children = KoineSyntaxChildEnumerator.Children(bin).ToArray();
        children.Length.ShouldBe(2);

        // And a void visitor reaches the generated VisitBinaryExpr hook.
        var probe = new VisitProbe();
        probe.Visit(bin);
        probe.SawBinaryExpr.ShouldBeTrue();
    }

    private sealed class VisitProbe : KoineSyntaxVisitor
    {
        public bool SawBinaryExpr { get; private set; }

        public override void VisitBinaryExpr(BinaryExpr node)
        {
            SawBinaryExpr = true;
            base.VisitBinaryExpr(node);
        }
    }
}
