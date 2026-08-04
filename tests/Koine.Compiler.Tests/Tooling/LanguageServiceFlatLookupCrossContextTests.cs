using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1870, the LSP/tooling cluster: six <see cref="KoineLanguageService"/> call sites asked
/// <see cref="Ast.ModelIndex"/> "what kind of type is this name?" / "give me this name's declaration"
/// through the FLAT, last-declaration-wins <c>Classify(string)</c> / <c>TryGetDecl(string, out TypeDecl)</c>
/// overloads while the cursor's own bounded context (<c>TokenContext.EnclosingContextName</c>, or a
/// <c>context</c> parameter already in the method's signature) was in scope. R13.2 lets two contexts
/// legally declare a type with the same simple name, so the answer — and therefore what the EDITOR shows —
/// silently depended on <c>.koi</c> source order.
/// </summary>
/// <remarks>
/// <para>Unlike the compiler-side clusters, a collision here misdirects the editor rather than the build:
/// completion offers the wrong members, call hierarchy refuses to anchor on an event, type hierarchy
/// labels an enum as a value. Nothing fails a build, which is exactly why it went unnoticed — so every
/// test here drives the real public entry point (<see cref="KoineLanguageService.CompleteAt"/>,
/// <see cref="KoineLanguageService.PrepareCallHierarchy"/>,
/// <see cref="KoineLanguageService.PrepareTypeHierarchy"/>) rather than the underlying index call.</para>
/// <para>Every fixture ships in BOTH context declaration orders and asserts the SAME answer in each. A
/// single-order test proves luck, not correctness: the flat table is filled by walking
/// <c>model.Contexts</c> in order, so whichever context is declared LAST wins it, and a one-order
/// assertion can pass purely because that order happens to be the lucky one.</para>
/// </remarks>
public class LanguageServiceFlatLookupCrossContextTests
{
    private static readonly KoineLanguageService Svc = new();

    private const string Uri = "file:///dup.koi";

    /// <summary>The colliding context: it declares <c>Status</c> as a <c>value</c>, which wins the flat
    /// table whenever this context is declared last.</summary>
    private const string ZetaStatusValue = """
        context Zeta {
          value Status { code: String }
        }
        """;

    /// <summary>Assembles a model with the colliding context either before or after <paramref name="alpha"/>.</summary>
    private static string Model(string alpha, bool zetaLast, string zeta = ZetaStatusValue) =>
        zetaLast ? alpha + "\n\n" + zeta : zeta + "\n\n" + alpha;

    /// <summary>The 0-based LSP line/character immediately AFTER the first occurrence of
    /// <paramref name="marker"/> — completion's <c>(start, end]</c> bias puts that caret on the marker's
    /// last token, which is what a trigger character (<c>.</c>, <c>=</c>) needs.</summary>
    private static (int Line, int Character) PosAfter(string source, string marker)
    {
        var index = source.IndexOf(marker, StringComparison.Ordinal);
        index.ShouldBeGreaterThanOrEqualTo(0, $"marker not found: {marker}");
        return LineChar(source, index + marker.Length);
    }

    /// <summary>The 0-based LSP line/character ONE column into <paramref name="needle"/>, searched from the
    /// first occurrence of <paramref name="anchor"/> — the navigation (<c>[start, end]</c>) cursor shape
    /// hover / call hierarchy / type hierarchy use.</summary>
    private static (int Line, int Character) PosInside(string source, string anchor, string needle)
    {
        var start = source.IndexOf(anchor, StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, $"anchor not found: {anchor}");
        var index = source.IndexOf(needle, start, StringComparison.Ordinal);
        index.ShouldBeGreaterThanOrEqualTo(0, $"needle not found: {needle}");
        return LineChar(source, index + 1);
    }

    /// <summary>
    /// Like <see cref="PosInside"/>, but the whole (anchor, needle) search starts only after the FIRST
    /// occurrence of <paramref name="section"/> — for a fixture where <paramref name="anchor"/> itself
    /// (e.g. <c>"command ship"</c>) is declared once per bounded context, so plain <see cref="PosInside"/>
    /// would always land in whichever context happens to come first in <paramref name="source"/>.
    /// </summary>
    private static (int Line, int Character) PosInsideSection(string source, string section, string anchor, string needle)
    {
        var sectionStart = source.IndexOf(section, StringComparison.Ordinal);
        sectionStart.ShouldBeGreaterThanOrEqualTo(0, $"section not found: {section}");
        var start = source.IndexOf(anchor, sectionStart, StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, $"anchor not found after section: {anchor}");
        var index = source.IndexOf(needle, start, StringComparison.Ordinal);
        index.ShouldBeGreaterThanOrEqualTo(0, $"needle not found: {needle}");
        return LineChar(source, index + 1);
    }

    private static (int Line, int Character) LineChar(string source, int offset)
    {
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < offset; i++)
        {
            if (source[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return (line, offset - lineStart);
    }

    private static IReadOnlyList<string> Labels(string source, (int Line, int Character) at) =>
        Svc.CompleteAt(source, at.Line, at.Character).Select(i => i.Label).ToList();

    private static KoineCompilation Compile(string source) =>
        KoineCompilation.Create(new[] { new SourceFile(Uri, source) });

    // ------------------------------------------------------------------
    // KoineLanguageService.cs DotCandidates — the `EnumType.` single-hop fallback
    // ------------------------------------------------------------------

    /// <summary>
    /// <c>Status.</c> inside <c>Alpha</c>, where <c>Alpha.Status</c> is an enum and <c>Zeta.Status</c> is a
    /// value. Mis-resolved, the enum branch declines and the "declared type name" fallback two steps later
    /// offers ZETA's members instead — the editor lists <c>code</c> where the user expects
    /// <c>Draft</c>/<c>Active</c>.
    /// </summary>
    private const string EnumReceiverAlpha = """
        context Alpha {
          enum Status { Draft, Active }

          value Ticket {
            lifecycle: Status
            invariant Status.
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Enum_receiver_completion_resolves_in_the_cursors_own_context(bool zetaLast)
    {
        var source = Model(EnumReceiverAlpha, zetaLast);

        var labels = Labels(source, PosAfter(source, "invariant Status."));

        labels.ShouldContain("Draft");
        labels.ShouldContain("Active");
        labels.ShouldNotContain("code");
    }

    // ------------------------------------------------------------------
    // KoineLanguageService.cs BinderReceiverMembers — the enclosing type's own declaration
    // ------------------------------------------------------------------

    /// <summary>
    /// <c>total.</c> inside <c>Alpha.Order</c>, where <c>Zeta</c> declares a DIFFERENT <c>Order</c>. The
    /// binder route builds its in-scope member set from the enclosing type's declaration; resolved flat it
    /// gets Zeta's <c>Order</c>, whose members don't include <c>total</c>, so the receiver types to an
    /// error and the editor offers nothing at all.
    /// </summary>
    private const string BinderScopeAlpha = """
        context Alpha {
          value Money { amount: Decimal }

          entity Order identified by OrderId {
            total: Money
            invariant total.
          }
        }
        """;

    private const string ZetaOrderEntity = """
        context Zeta {
          entity Order identified by OrderId {
            label: String
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Binder_receiver_members_resolve_the_enclosing_types_own_context(bool zetaLast)
    {
        var source = Model(BinderScopeAlpha, zetaLast, ZetaOrderEntity);

        var labels = Labels(source, PosAfter(source, "invariant total."));

        labels.ShouldContain("amount");
        labels.ShouldNotContain("label");
    }

    // ------------------------------------------------------------------
    // KoineLanguageService.cs EnumMemberCandidates — the governing enum at `= `
    // ------------------------------------------------------------------

    /// <summary>
    /// The enum-value position after <c>lifecycle: Status =</c>. Mis-resolved, the governing-enum branch
    /// declines and the method falls back to EVERY enum member declared anywhere in the model — so the
    /// editor offers <c>Red</c> (a member of an unrelated enum in another context) alongside the two that
    /// actually fit.
    /// </summary>
    private const string EnumDefaultAlpha = """
        context Alpha {
          enum Status { Draft, Active }

          value Ticket {
            lifecycle: Status = Draft
          }
        }
        """;

    private const string ZetaStatusValueAndColorEnum = """
        context Zeta {
          value Status { code: String }
          enum Color { Red, Green }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Enum_default_completion_resolves_the_governing_enum_in_its_own_context(bool zetaLast)
    {
        var source = Model(EnumDefaultAlpha, zetaLast, ZetaStatusValueAndColorEnum);

        var labels = Labels(source, PosAfter(source, "lifecycle: Status ="));

        labels.ShouldContain("Draft");
        labels.ShouldContain("Active");
        labels.ShouldNotContain("Red");
    }

    // ------------------------------------------------------------------
    // KoineLanguageService.cs PrepareCallHierarchy + FindEvent
    // ------------------------------------------------------------------

    /// <summary>
    /// The cursor on <c>OrderPlaced</c> in <c>Alpha</c>'s <c>emit</c> clause, where <c>Zeta</c> declares a
    /// value of the same simple name. Mis-classified, the event branch never fires and the command branch
    /// finds nothing either — call hierarchy silently refuses to anchor anywhere.
    /// </summary>
    private const string CallHierarchyAlpha = """
        context Alpha {
          event OrderPlaced {
            order: OrderId
          }

          entity Order identified by OrderId {
            total: Int

            command place {
              emit OrderPlaced(order: id)
            }
          }
        }
        """;

    private const string ZetaOrderPlacedValue = """
        context Zeta {
          value OrderPlaced { code: String }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Call_hierarchy_anchors_on_an_event_declared_in_the_cursors_context(bool zetaLast)
    {
        var source = Model(CallHierarchyAlpha, zetaLast, ZetaOrderPlacedValue);
        var (line, character) = PosInside(source, "emit OrderPlaced", "OrderPlaced");

        var item = Svc.PrepareCallHierarchy(Compile(source), Uri, line, character).ShouldHaveSingleItem();

        item.Name.ShouldBe("OrderPlaced");
        item.Kind.ShouldBe(CallHierarchyItemKind.Event);
    }

    // ------------------------------------------------------------------
    // KoineLanguageService.cs IncomingCalls -> FindEvent
    // ------------------------------------------------------------------

    /// <summary>
    /// The OTHER <c>FindEvent</c> caller: incoming calls on a COMMAND are the events whose policies react
    /// with that <c>(type, command)</c> pair, and each policy's event name is resolved in the context that
    /// DECLARES the policy. Resolved flat, <c>Zeta</c>'s same-named <c>value</c> wins whenever it is
    /// declared last, <c>FindEvent</c> returns null (the decl is not an <see cref="Ast.EventDecl"/>), and
    /// call hierarchy reports NO incoming edge for a command a policy plainly triggers.
    /// </summary>
    private const string PolicyIncomingAlpha = """
        context Alpha {
          event OrderPlaced {
            order: OrderId
          }

          entity Shipment identified by ShipmentId {
            order: OrderId

            command ship(order: OrderId) {
              order -> order
            }
          }

          policy ShipOnOrder when OrderPlaced then Shipment.ship(order: order)
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Incoming_calls_resolve_a_policys_event_in_the_policys_own_context(bool zetaLast)
    {
        var source = Model(PolicyIncomingAlpha, zetaLast, ZetaOrderPlacedValue);
        var compilation = Compile(source);
        var (line, character) = PosInside(source, "command ship", "ship");

        var command = Svc.PrepareCallHierarchy(compilation, Uri, line, character).ShouldHaveSingleItem();
        command.Kind.ShouldBe(CallHierarchyItemKind.Command);
        command.OwningType.ShouldBe("Shipment");

        var incoming = Svc.IncomingCalls(compilation, command).ShouldHaveSingleItem();

        incoming.From.Name.ShouldBe("OrderPlaced");
        incoming.From.Kind.ShouldBe(CallHierarchyItemKind.Event);
    }

    // ------------------------------------------------------------------
    // KoineLanguageService.cs IncomingCalls -> `seen` de-dup key (#1901)
    // ------------------------------------------------------------------

    /// <summary>
    /// Two contexts each declare their OWN <c>Shipment.ship</c> reacting to their OWN <c>OrderPlaced</c>
    /// event (R13.2). <c>IncomingCalls</c>' <c>item.OwningType</c>/<c>item.Name</c> filter is itself
    /// context-blind, so BOTH policies legitimately match a query anchored on either context's
    /// <c>ship</c> — the two-edge answer is correct here. Before #1901 the `seen` de-dup keyed only on
    /// the bare event name, so the second context's edge was silently swallowed as a "duplicate" of the
    /// first, no matter which context is declared first.
    /// </summary>
    private const string ShipOnOrderAlpha = """
        context Alpha {
          event OrderPlaced {
            order: OrderId
          }

          entity Shipment identified by ShipmentId {
            order: OrderId

            command ship(order: OrderId) {
              order -> order
            }
          }

          policy ShipOnOrderAlpha when OrderPlaced then Shipment.ship(order: order)
        }
        """;

    private const string ShipOnOrderZeta = """
        context Zeta {
          event OrderPlaced {
            order: OrderId
          }

          entity Shipment identified by ShipmentId {
            order: OrderId

            command ship(order: OrderId) {
              order -> order
            }
          }

          policy ShipOnOrderZeta when OrderPlaced then Shipment.ship(order: order)
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Incoming_calls_report_a_distinct_edge_per_context_for_a_same_named_triggering_event(bool zetaFirst)
    {
        var source = zetaFirst
            ? ShipOnOrderZeta + "\n\n" + ShipOnOrderAlpha
            : ShipOnOrderAlpha + "\n\n" + ShipOnOrderZeta;
        var compilation = Compile(source);
        var (line, character) = PosInsideSection(source, "context Alpha", "command ship", "ship");

        var command = Svc.PrepareCallHierarchy(compilation, Uri, line, character).ShouldHaveSingleItem();
        command.Kind.ShouldBe(CallHierarchyItemKind.Command);
        command.OwningType.ShouldBe("Shipment");

        var incoming = Svc.IncomingCalls(compilation, command);

        incoming.Count.ShouldBe(2);
        incoming.ShouldAllBe(c => c.From.Kind == CallHierarchyItemKind.Event && c.From.Name == "OrderPlaced");
        incoming.Select(c => c.From.Span).Distinct().Count().ShouldBe(2);
    }

    /// <summary>
    /// The de-dup set exists to collapse GENUINE repeats: two differently-named policies in the SAME
    /// context both reacting to the same event with the same reaction target still describe a single
    /// edge. #1901 context-qualifies the key but must not stop collapsing this case.
    /// </summary>
    private const string DuplicatePoliciesWithinOneContext = """
        context Gamma {
          event OrderPlaced {
            order: OrderId
          }

          entity Shipment identified by ShipmentId {
            order: OrderId

            command ship(order: OrderId) {
              order -> order
            }
          }

          policy ShipOnOrderFirst when OrderPlaced then Shipment.ship(order: order)
          policy ShipOnOrderSecond when OrderPlaced then Shipment.ship(order: order)
        }
        """;

    [Fact]
    public void Incoming_calls_still_collapse_duplicate_policies_within_one_context()
    {
        var compilation = Compile(DuplicatePoliciesWithinOneContext);
        var (line, character) = PosInside(DuplicatePoliciesWithinOneContext, "command ship", "ship");

        var command = Svc.PrepareCallHierarchy(compilation, Uri, line, character).ShouldHaveSingleItem();

        var incoming = Svc.IncomingCalls(compilation, command);

        var single = incoming.ShouldHaveSingleItem();
        single.From.Name.ShouldBe("OrderPlaced");
    }

    // ------------------------------------------------------------------
    // KoineLanguageService.cs ItemFor (type hierarchy)
    // ------------------------------------------------------------------

    /// <summary>
    /// <c>Alpha</c> declares <c>Status</c> as an enum, <c>Zeta</c> as a value. <c>ResolveDecl</c> already
    /// picks the right DECLARATION per cursor; only the item's KIND was classified flat, so the editor
    /// labelled one of the two with the other's icon.
    /// </summary>
    private const string TypeHierarchyAlpha = """
        context Alpha {
          enum Status { Draft, Active }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Type_hierarchy_item_kind_is_classified_in_the_declarations_own_context(bool zetaLast)
    {
        var source = Model(TypeHierarchyAlpha, zetaLast);
        var compilation = Compile(source);

        var (enumLine, enumChar) = PosInside(source, "enum Status", "Status");
        var alphaStatus = Svc.PrepareTypeHierarchy(compilation, Uri, enumLine, enumChar).ShouldHaveSingleItem();

        var (valueLine, valueChar) = PosInside(source, "value Status", "Status");
        var zetaStatus = Svc.PrepareTypeHierarchy(compilation, Uri, valueLine, valueChar).ShouldHaveSingleItem();

        alphaStatus.Context.ShouldBe("Alpha");
        alphaStatus.Kind.ShouldBe(TypeHierarchyItemKind.Enum);
        zetaStatus.Context.ShouldBe("Zeta");
        zetaStatus.Kind.ShouldBe(TypeHierarchyItemKind.Value);
    }
}
