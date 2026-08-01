using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="ModelIndex.AllTypes()"/> — the type-registry enumeration every
/// <c>AllTypes()</c>-derived index is built from (issue #1632). R13.2 lets two bounded contexts each
/// legally declare a type with the same simple name (uniqueness is enforced PER CONTEXT, not
/// globally), but <c>AllTypes()</c> used to walk only the flat, last-write-wins <c>_byName</c>
/// dictionary — so a same-named type in the losing context was not merely misclassified (the
/// #1560 family of bugs), it was <b>entirely absent</b> from enumeration. The enum-member index
/// (<see cref="ModelIndex.EnumsDeclaring"/> / <c>_enumMemberToType</c>) is populated by iterating
/// <c>AllTypes()</c>, so the shadowed enum's members were never registered <i>at all</i> — 0 owners,
/// not the "≥2 means ambiguous" the API's own doc comment describes.
///
/// <para><b>On the issue's headline repro.</b> #1632 reports the symptom as a false
/// <see cref="DiagnosticCodes.UnknownEnumMemberForType"/> (KOI0106) on the shadowed context's own
/// qualified reference. That no longer reproduces: the context-aware resolution that landed since
/// (#1711/#1713, #1715/#1729 and siblings) made <c>ExpressionChecker.CheckMember</c> resolve through
/// <c>ResolveDecl</c>'s per-context lookup, which is not built off the shadowed index — see the
/// remark at <c>ExpressionChecker.cs</c>'s KOI0106 report site. The KOI0106 tests here therefore pass
/// both before and after the fix and stand as <i>stays-clean guards</i>, not regression pins. What
/// actually went red before this fix, and is what these tests exist to pin, is the registry itself:
/// <see cref="AllTypes_yields_every_per_context_declaration_of_a_shared_simple_name"/>,
/// <see cref="EnumsDeclaring_sees_the_members_of_a_shadowed_same_name_enum"/>,
/// <see cref="Unreachable_transition_is_detected_through_a_shadowed_same_name_enum"/> and
/// <see cref="Same_name_entities_sharing_an_identity_name_across_contexts_still_resolve"/>.</para>
/// </summary>
public class ModelIndexAllTypesTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static ModelIndex IndexOf(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return new SemanticModel(result.Model!).Index;
    }

    private const string Shipping = """
        context Shipping {
          enum Status {
            Pending
            Delivered
          }
          value Parcel {
            status: Status
            isDefaultPending: Bool = status == Status.Pending
          }
        }
        """;

    private const string Billing = """
        context Billing {
          enum Status {
            Open
            Closed
          }
          value Invoice {
            status: Status
            isDefaultOpen: Bool = status == Status.Open
          }
        }
        """;

    private const string ShippingFirst = $"{Shipping}\n{Billing}";

    private const string BillingFirst = $"{Billing}\n{Shipping}";

    /// <summary>
    /// Both contexts' qualified <c>Status.Member</c> references must validate cleanly whichever
    /// context is declared first — declaration order decided which side occupied the flat
    /// <c>_byName["Status"]</c> slot, so an order-sensitive result is the tell-tale of the bug class.
    /// Green before this fix too (see the class remark); kept as a guard.
    /// </summary>
    [Fact]
    public void Same_name_enum_in_two_contexts_validates_regardless_of_declaration_order()
    {
        Diagnose(ShippingFirst).ShouldBeEmpty();
        Diagnose(BillingFirst).ShouldBeEmpty();
    }

    /// <summary>Red before the fix: only the flat winner's declaration was ever yielded.</summary>
    [Fact]
    public void AllTypes_yields_every_per_context_declaration_of_a_shared_simple_name()
    {
        ModelIndex index = IndexOf(ShippingFirst);

        List<EnumDecl> statuses = index.AllTypes().OfType<EnumDecl>().Where(e => e.Name == "Status").ToList();
        statuses.Count.ShouldBe(2);
        statuses.SelectMany(e => e.MemberNames).ShouldBe(
            new[] { "Pending", "Delivered", "Open", "Closed" },
            ignoreOrder: true);
    }

    /// <summary>
    /// Red before the fix: the shadowed enum's members had <b>zero</b> registered owners. Both enums
    /// are (by construction) named <c>Status</c>, so the owner NAME each assertion expects coincides;
    /// the signal being pinned is therefore <i>presence</i> — that every member of both enums resolves
    /// to an owner at all — plus that each resolves to exactly one, i.e. the union didn't
    /// double-register the same declaration.
    /// </summary>
    [Fact]
    public void EnumsDeclaring_sees_the_members_of_a_shadowed_same_name_enum()
    {
        ModelIndex index = IndexOf(ShippingFirst);

        index.EnumsDeclaring("Pending").ShouldBe(new[] { "Status" });
        index.EnumsDeclaring("Delivered").ShouldBe(new[] { "Status" });
        index.EnumsDeclaring("Open").ShouldBe(new[] { "Status" });
        index.EnumsDeclaring("Closed").ShouldBe(new[] { "Status" });
    }

    /// <summary>
    /// An end-to-end diagnostic pin for the fix's reach beyond the enum-member index.
    /// <c>EntityBehaviorValidator.CheckTransitionReachable</c> guards on
    /// <c>index.EnumsDeclaring(stateRef.Name).Contains(target.Type.Name)</c>, so while the bound
    /// enum was evicted from <c>AllTypes()</c> that guard returned early <b>every time</b> and the
    /// unreachable-transition error (KOI0703) was silently never reported. Here <c>Other</c>'s
    /// <c>S</c> is declared second and shadows <c>C</c>'s in the flat map; before the fix this model
    /// validated clean (the bug went undetected), after it the genuine KOI0703 is reported.
    /// </summary>
    [Fact]
    public void Unreachable_transition_is_detected_through_a_shadowed_same_name_enum()
    {
        const string src = """
            context C {
              enum S { Draft, Done }
              entity E identified by EId {
                s: S = Draft
                states s { Draft -> Done  Done }
                command reset { s -> Draft }
              }
            }

            context Other {
              enum S { Alpha, Beta }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnreachableTransition);
    }

    /// <summary>
    /// The only <c>AllTypes()</c> consumers that pick a SINGLE result and can see a difference now
    /// that both sides of a collision are visible are the three
    /// <c>OfType&lt;EntityDecl&gt;().FirstOrDefault(e => e.IdentityName == name)</c> lookups
    /// (<c>SymbolTable</c> ×2, <c>WorkspaceIndex</c>'s hover text). They need two same-named entities
    /// in different contexts that ALSO share an identity name before the pick can change, and either
    /// answer is equally arbitrary — they only need SOME owner for navigation/hover. This pins that
    /// such a model still indexes and validates cleanly; disambiguating the owner by the reference's
    /// own context is the follow-on tracked separately (#1632 spec, Approach 2 / non-goal).
    /// </summary>
    [Fact]
    public void Same_name_entities_sharing_an_identity_name_across_contexts_still_resolve()
    {
        const string src = """
            context Shipping {
              entity Order identified by OrderId {
                weight: Int
              }
            }

            context Billing {
              entity Order identified by OrderId {
                total: Int
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        ModelIndex index = new SemanticModel(result.Model!).Index;

        List<EntityDecl> orders = index.AllTypes().OfType<EntityDecl>().Where(e => e.Name == "Order").ToList();
        orders.Count.ShouldBe(2);

        // The IdentityName-keyed lookup still resolves to one of the two — which one is arbitrary in
        // either direction, so assert only that it picks a genuine declaration rather than nothing.
        var table = new SymbolTable(result.Model!, index);
        table.StrongSymbol("OrderId").ShouldNotBeNull();
    }

    /// <summary>
    /// The central backward-compatibility claim: with no cross-context simple-name collision the
    /// enumeration is unchanged in content AND order, across contexts and into aggregates. Both
    /// registries are built from the same context-then-declaration pre-order walk, so this holds by
    /// construction — pinned here so a future refactor of either walk can't drift silently.
    /// </summary>
    [Fact]
    public void AllTypes_enumeration_order_is_context_then_declaration_order_without_collisions()
    {
        const string src = """
            context Shipping {
              enum Carrier { Road, Air }
              aggregate Fleet root Shipment {
                entity Shipment identified by ShipmentId {
                  carrier: Carrier
                }
                value Leg {
                  distance: Int
                }
              }
            }

            context Billing {
              enum Status { Open, Closed }
              value Invoice {
                status: Status
              }
            }
            """;

        ModelIndex index = IndexOf(src);

        index.AllTypes().Select(t => t.Name).ShouldBe(
            new[] { "Carrier", "Fleet", "Shipment", "Leg", "Status", "Invoice" });
    }

    [Fact]
    public void AllTypes_does_not_duplicate_declarations_in_a_single_context_model()
    {
        const string src = """
            context Billing {
              enum Status {
                Open
                Closed
              }
              value Invoice {
                status: Status
              }
            }
            """;

        ModelIndex index = IndexOf(src);

        List<TypeDecl> all = index.AllTypes().ToList();
        all.Select(t => t.Name).ShouldBe(new[] { "Status", "Invoice" });

        // Dedup is by REFERENCE (TypeDecl is a record, so the default value equality would mask a
        // genuine double-yield of the same declaration) — assert with the same comparer production uses.
        all.Distinct(ReferenceEqualityComparer.Instance).Count().ShouldBe(all.Count);
    }
}
