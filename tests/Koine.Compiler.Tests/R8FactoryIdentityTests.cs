using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R8 — a <c>create</c> factory auto-generates the aggregate's identity, so it requires a
/// client-side generatable (Guid) identity. On a <c>natural</c>/<c>sequence</c> key the factory
/// would emit a call to a generator that is never produced (<c>&lt;Id&gt;::generate()</c> in Rust,
/// <c>&lt;Id&gt;.New()</c> in C#), yielding a crate/assembly that does not compile. A target-agnostic
/// validator rejects that shape before any emitter runs (issue #317).
/// </summary>
public class R8FactoryIdentityTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void Create_factory_on_a_natural_string_identity_is_rejected()
    {
        const string src = """
            context Catalog {
              entity Book identified by BookId as natural(String) {
                title: String
                create register(title: String) { title -> title }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
    }

    [Fact]
    public void Create_factory_on_a_natural_int_identity_is_rejected()
    {
        const string src = """
            context Catalog {
              entity Ticket identified by TicketNo as natural(Int) {
                subject: String
                create open(subject: String) { subject -> subject }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
    }

    [Fact]
    public void Create_factory_on_a_sequence_identity_is_rejected()
    {
        const string src = """
            context Billing {
              entity Invoice identified by InvoiceNo as sequence {
                amount: Int
                create raise(amount: Int) { amount -> amount }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
    }

    [Fact]
    public void Create_factory_on_a_guid_identity_is_allowed()
    {
        const string src = """
            context Catalog {
              entity Book identified by BookId {
                title: String
                create register(title: String) { title -> title }
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
    }

    [Fact]
    public void Natural_identity_with_only_commands_is_allowed()
    {
        // Guards the existing natural-key templates (e.g. library `Book`, pizzeria `Pizza`) which
        // deliberately carry no `create` factory: a non-Guid identity is fine without one.
        const string src = """
            context Catalog {
              entity Book identified by BookId as natural(String) {
                title: String
                command retitle(newTitle: String) { title -> newTitle }
              }
            }
            """;

        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
    }
}
