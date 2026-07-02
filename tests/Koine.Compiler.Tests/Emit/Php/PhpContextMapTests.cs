using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// PHP emitter — context-map slice (R14.2 / R14.3): anti-corruption-layer translator seams and
/// integration-event subscriber seams. Verifies that <see cref="PhpEmitter"/> emits a
/// <c>&lt;Up&gt;To&lt;Down&gt;Translator</c> interface (one <c>translate…</c> method per ACL mapping,
/// with qualified cross-context <c>use</c> imports) into the downstream context, and a
/// <c>Handle&lt;Event&gt;</c> subscriber interface into the subscriber context for each
/// <c>subscribes &lt;Pub&gt;.&lt;Event&gt;</c> — both as pure dependency-free PHP 8.1 interface seams.
/// </summary>
public class PhpContextMapTests
{
    /// <summary>
    /// Two contexts joined by an anti-corruption-layer relation carrying an <c>acl { … }</c> block:
    /// Legacy's types translate into Billing's.
    /// </summary>
    private const string AclFixture = """
        context Legacy {
          value Account { reference: String }
          value Charge  { amount: Decimal }
        }
        context Billing {
          value Customer { name: String }
          value Invoice  { total: Decimal }
        }
        contextmap {
          Legacy -> Billing : anti-corruption-layer
            acl { Legacy.Account -> Billing.Customer
                  Legacy.Charge  -> Billing.Invoice }
        }
        """;

    /// <summary>
    /// A publisher/subscriber pair authorized by an open-host relation: Shipping subscribes to Sales's
    /// published <c>OrderPlaced</c> integration event.
    /// </summary>
    private const string PubSubFixture = """
        context Sales {
          publishes OrderPlaced
          integration event OrderPlaced {
            orderId:  OrderId
            total:    Decimal
            placedAt: Instant
          }
        }
        context Shipping {
          subscribes Sales.OrderPlaced
        }
        contextmap {
          Sales -> Shipping : open-host
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(string source)
    {
        var result = new KoineCompiler().Compile(source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    private static string FileContent(IReadOnlyList<EmittedFile> files, string path) =>
        files.Single(f => f.RelativePath == path).Contents;

    // -----------------------------------------------------------------------
    // R14.2 — ACL translator seam
    // -----------------------------------------------------------------------

    [Fact]
    public void Acl_relation_emits_translator_interface()
    {
        var files = Emit(AclFixture);

        // Emitted into the DOWNSTREAM (Billing) context's Abstractions/ folder.
        files.ShouldContain(f => f.RelativePath == "src/Billing/Abstractions/LegacyToBillingTranslator.php");
        var content = FileContent(files, "src/Billing/Abstractions/LegacyToBillingTranslator.php");

        content.ShouldContain("<?php");
        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("namespace Koine\\Billing\\Abstractions");

        // A pure interface seam — one distinct translate method per mapping (PHP can't overload).
        content.ShouldContain("interface LegacyToBillingTranslator");
        content.ShouldContain("public function translateAccountToCustomer(Account $source): Customer;");
        content.ShouldContain("public function translateChargeToInvoice(Charge $source): Invoice;");

        // Qualified cross-context use imports — upstream types from Legacy, local types from Billing.
        content.ShouldContain("use Koine\\Legacy\\ValueObjects\\Account;");
        content.ShouldContain("use Koine\\Legacy\\ValueObjects\\Charge;");
        content.ShouldContain("use Koine\\Billing\\ValueObjects\\Customer;");
        content.ShouldContain("use Koine\\Billing\\ValueObjects\\Invoice;");
    }

    [Fact]
    public void Acl_relation_without_mapping_block_emits_no_translator()
    {
        const string noMapping = """
            context Legacy { value Account { reference: String } }
            context Billing { value Customer { name: String } }
            contextmap { Legacy -> Billing : anti-corruption-layer }
            """;
        var files = Emit(noMapping);
        files.ShouldNotContain(f => f.RelativePath.Contains("Translator"));
    }

    [Fact]
    public Task Acl_translator_snapshot()
    {
        var files = Emit(AclFixture);
        var content = FileContent(files, "src/Billing/Abstractions/LegacyToBillingTranslator.php");
        return Verify(content);
    }

    // -----------------------------------------------------------------------
    // R14.3 — integration-event subscriber seam
    // -----------------------------------------------------------------------

    [Fact]
    public void Subscribes_emits_handler_interface()
    {
        var files = Emit(PubSubFixture);

        // Emitted into the SUBSCRIBER (Shipping) context's Abstractions/ folder.
        files.ShouldContain(f => f.RelativePath == "src/Shipping/Abstractions/HandleOrderPlaced.php");
        var content = FileContent(files, "src/Shipping/Abstractions/HandleOrderPlaced.php");

        content.ShouldContain("<?php");
        content.ShouldContain("declare(strict_types=1)");
        content.ShouldContain("namespace Koine\\Shipping\\Abstractions");

        // A single-method handler interface seam typed on the published event.
        content.ShouldContain("interface HandleOrderPlaced");
        content.ShouldContain("public function handle(OrderPlaced $event): void;");

        // The event resolves to a qualified import from the PUBLISHER (Sales) context.
        content.ShouldContain("use Koine\\Sales\\Events\\OrderPlaced;");
    }

    [Fact]
    public Task Subscriber_handler_snapshot()
    {
        var files = Emit(PubSubFixture);
        var content = FileContent(files, "src/Shipping/Abstractions/HandleOrderPlaced.php");
        return Verify(content);
    }
}
