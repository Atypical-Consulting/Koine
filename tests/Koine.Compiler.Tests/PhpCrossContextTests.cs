using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// PHP emitter — cross-context type disambiguation (issue #394). When two bounded contexts declare a
/// type with the same short name (e.g. <c>Money</c> in both Menu and Payment), the PHP emitter must
/// resolve every reference to the FQN of the context it was <em>declared</em> in — not whichever copy a
/// flat last-writer-wins catalog happened to keep. Where a single file genuinely references two
/// same-named classes (the anti-corruption-layer <c>X -&gt; X</c> shape) PHP cannot <c>use</c> both
/// under one bare name, so the loser is imported <c>use … as &lt;Ctx&gt;&lt;Name&gt;</c> and its
/// reference sites rewritten to the alias. Emitted file names that would collide are qualified with the
/// publisher/upstream context.
/// </summary>
public class PhpCrossContextTests
{
    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string FileContent(IReadOnlyList<EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // -----------------------------------------------------------------------
    // Task 1 — per-symbol resolution against the declaring context
    // -----------------------------------------------------------------------

    /// <summary>
    /// Two contexts each declare <c>value Money</c>; Menu's <c>MenuItem</c> read model projects a
    /// Menu <c>Money</c>. Its <c>use</c> must point at Menu's copy — the flat catalog kept Payment's
    /// (declared last) and wrongly imported <c>Koine\Payment\ValueObjects\Money</c>, which fatals under
    /// <c>declare(strict_types=1)</c> when the projection runs.
    /// </summary>
    private const string SameNameFixture = """
        context Menu {
          value Money {
            amount: Decimal
            invariant amount >= 0  "a price cannot be negative"
          }
          aggregate Catalog root Pizza {
            entity Pizza identified by PizzaCode as natural(String) {
              name:      String
              basePrice: Money
            }
          }
          readmodel MenuItem from Pizza {
            name
            basePrice
          }
        }
        context Payment {
          value Money {
            amount: Decimal
          }
        }
        """;

    [Fact]
    public void Read_model_field_resolves_to_its_own_contexts_same_named_type()
    {
        var files = Emit(SameNameFixture);
        var content = FileContent(files, "src/Menu/ReadModels/MenuItem.php");

        // basePrice is a Menu Money — the import must be Menu's, never Payment's.
        content.ShouldContain("use Koine\\Menu\\ValueObjects\\Money;");
        content.ShouldNotContain("use Koine\\Payment\\ValueObjects\\Money;");
    }

    // -----------------------------------------------------------------------
    // Task 2 — `use … as` aliasing for same-named classes in one file
    // -----------------------------------------------------------------------

    /// <summary>
    /// An anti-corruption-layer mapping <c>Upstream.Customer -&gt; Downstream.Customer</c>: both sides
    /// share the short name <c>Customer</c> but are distinct classes in distinct namespaces. PHP cannot
    /// <c>use</c> both under the bare name, so the upstream copy must be imported
    /// <c>use … as UpstreamCustomer</c> and the translator's <em>param</em> hint rewritten to that alias,
    /// while the local return type keeps the bare name.
    /// </summary>
    private const string AclSameNameFixture = """
        context Upstream {
          value Customer { reference: String }
        }
        context Downstream {
          value Customer { name: String }
        }
        contextmap {
          Upstream -> Downstream : anti-corruption-layer
            acl { Upstream.Customer -> Downstream.Customer }
        }
        """;

    [Fact]
    public void Acl_same_named_mapping_aliases_the_upstream_import_and_param()
    {
        var files = Emit(AclSameNameFixture);
        var content = FileContent(files, "src/Downstream/Abstractions/UpstreamToDownstreamTranslator.php");

        // The local (file's own) Customer stays bare; the upstream copy is aliased.
        content.ShouldContain("use Koine\\Downstream\\ValueObjects\\Customer;");
        content.ShouldContain("use Koine\\Upstream\\ValueObjects\\Customer as UpstreamCustomer;");

        // The param hint is rewritten to the alias; the return keeps the bare local name.
        content.ShouldContain("public function translateCustomerToCustomer(UpstreamCustomer $source): Customer;");
    }

    [Fact]
    public Task Acl_same_named_mapping_snapshot()
    {
        var files = Emit(AclSameNameFixture);
        var content = FileContent(files, "src/Downstream/Abstractions/UpstreamToDownstreamTranslator.php");
        return Verify(content);
    }

    // -----------------------------------------------------------------------
    // Task 3 — subscriber events resolve to the publisher they were declared in
    // -----------------------------------------------------------------------
    //
    // The issue also describes a subscriber that subscribes to *two* same-named events from different
    // publishers producing two colliding Handle<Event>.php. #394 left that case rejected by KOI1417
    // (relaxing it then would have reintroduced the collision for the C#/TS seams); #420 has since made
    // every emitter collision-safe (publisher-qualified seams) and relaxed the validator — see
    // Two_same_named_events_from_different_publishers_emit_publisher_qualified_handlers below. What was
    // *also* reachable in a valid model — and was genuinely wrong — is a subscriber to one publisher's
    // event whose short name a different, non-subscribed context also declares: the flat catalog
    // imported whichever copy sorted first, not the publisher the subscription actually names.

    /// <summary>
    /// Hub subscribes only to <c>Beta.Shipped</c>, but <c>Alpha</c> also declares a same-named
    /// <c>Shipped</c> event (and sorts first in the catalog). The handler must import Beta's event — the
    /// publisher the subscription names — not Alpha's, or <c>handle(Shipped $event)</c> binds the wrong
    /// class under <c>declare(strict_types=1)</c>.
    /// </summary>
    private const string SameNamedEventFixture = """
        context Alpha {
          publishes Shipped
          integration event Shipped { reference: String }
        }
        context Beta {
          publishes Shipped
          integration event Shipped { code: String }
        }
        context Hub {
          subscribes Beta.Shipped
        }
        contextmap {
          Alpha -> Hub : open-host
          Beta  -> Hub : open-host
        }
        """;

    [Fact]
    public void Subscriber_imports_the_publisher_it_subscribes_to_not_a_same_named_sibling()
    {
        var files = Emit(SameNamedEventFixture);
        var content = FileContent(files, "src/Hub/Abstractions/HandleShipped.php");

        // The subscription names Beta — the import must be Beta's Shipped, never Alpha's.
        content.ShouldContain("use Koine\\Beta\\Events\\Shipped;");
        content.ShouldNotContain("use Koine\\Alpha\\Events\\Shipped;");
        content.ShouldContain("public function handle(Shipped $event): void;");
    }

    [Fact]
    public void Single_publisher_subscriber_emits_the_expected_handler()
    {
        // The common (globally-unique event name) case still emits the bare handler unchanged.
        const string single = """
            context Sales {
              publishes OrderPlaced
              integration event OrderPlaced { reference: String }
            }
            context Shipping {
              subscribes Sales.OrderPlaced
            }
            contextmap { Sales -> Shipping : open-host }
            """;
        var files = Emit(single);
        var content = FileContent(files, "src/Shipping/Abstractions/HandleOrderPlaced.php");
        content.ShouldContain("use Koine\\Sales\\Events\\OrderPlaced;");
        content.ShouldContain("public function handle(OrderPlaced $event): void;");
    }

    // -----------------------------------------------------------------------
    // #420 — subscribing to two same-named events from different publishers
    // -----------------------------------------------------------------------
    //
    // KOI1417 used to reject this model-wide, for every emitter, because the bare Handle<Event>.php
    // path would collide. #420 relaxes that validator and makes each emitter qualify the colliding
    // seam by its publisher (Handle<Pub><Event>), reusing #394's publisher-pinned import resolution so
    // each handler still binds the right publisher's event.

    [Fact]
    public void Two_same_named_events_from_different_publishers_emit_publisher_qualified_handlers()
    {
        var files = Emit(R14IntegrationEventsTests.SameNameCrossPublisher);

        // Each colliding seam is qualified by its publisher, so the two handlers no longer clobber on
        // one Handle<Event>.php path; each binds its own publisher's Shipped (the #394 import pinning).
        var sales = FileContent(files, "src/Fulfillment/Abstractions/HandleSalesShipped.php");
        sales.ShouldContain("interface HandleSalesShipped");
        sales.ShouldContain("use Koine\\Sales\\Events\\Shipped;");
        sales.ShouldContain("public function handle(Shipped $event): void;");

        var returns = FileContent(files, "src/Fulfillment/Abstractions/HandleReturnsShipped.php");
        returns.ShouldContain("interface HandleReturnsShipped");
        returns.ShouldContain("use Koine\\Returns\\Events\\Shipped;");

        // The bare HandleShipped seam must NOT be emitted — it would clobber across publishers.
        files.ShouldNotContain(f => f.RelativePath == "src/Fulfillment/Abstractions/HandleShipped.php");
    }
}
