using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R8 — a <c>create</c> factory auto-generates the aggregate's identity, so it requires a
/// generatable (Guid) identity. On a non-Guid key the C# emitter dangles an undefined <c>&lt;Id&gt;.New()</c>
/// (the assembly won't compile), and the Rust emitter either dangles <c>&lt;Id&gt;::generate()</c>
/// (<c>natural(Int)</c>/<c>sequence</c>) or mints a random UUID for a <c>natural(String)</c> key the user
/// declared natural (semantically wrong). A target-agnostic validator rejects every non-Guid factory
/// before any emitter runs (issue #317).
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

    [Fact]
    public void Create_factory_with_explicit_id_param_on_natural_string_is_accepted()
    {
        // #324: declaring the identity as an explicit identity-typed parameter opts out of
        // auto-generation, so a `natural(String)` key needs no client-side generator. The param
        // `id: BookId` is identity-typed, so it is the explicit id (and naming it `id` is fine).
        const string src = """
            context Catalog {
              entity Book identified by BookId as natural(String) {
                title: String
                create register(id: BookId, title: String) { title -> title }
              }
            }
            """;

        IReadOnlyList<Diagnostic> diagnostics = Diagnose(src);
        diagnostics.ShouldNotContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
        diagnostics.ShouldNotContain(d => d.Code == DiagnosticCodes.ReservedFactoryParameter);
    }

    [Fact]
    public void Create_factory_with_explicit_id_param_on_sequence_is_accepted()
    {
        // Binding is by parameter TYPE, not the literal name `id`: `no: InvoiceNo` is the
        // identity-typed parameter, so it serves as the explicit id for the sequence key.
        const string src = """
            context Billing {
              entity Invoice identified by InvoiceNo as sequence {
                amount: Int
                create raise(no: InvoiceNo, amount: Int) { amount -> amount }
              }
            }
            """;

        IReadOnlyList<Diagnostic> diagnostics = Diagnose(src);
        diagnostics.ShouldNotContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
        diagnostics.ShouldNotContain(d => d.Code == DiagnosticCodes.ReservedFactoryParameter);
    }

    [Fact]
    public void Create_factory_on_natural_int_without_id_param_still_rejected()
    {
        // No identity-typed parameter, so the factory would have to auto-generate the
        // non-generatable `natural(Int)` key: still rejected.
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
    public void Two_identity_typed_params_on_one_factory_report_ambiguity()
    {
        // Two parameters of the identity type: at most one may serve as the explicit identity,
        // so which one is the id is ambiguous.
        const string src = """
            context Catalog {
              entity Book identified by BookId as natural(String) {
                title: String
                create register(id: BookId, other: BookId, title: String) { title -> title }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.AmbiguousFactoryIdentity);
    }

    [Fact]
    public void Non_identity_param_named_id_is_still_rejected()
    {
        // A parameter literally named `id` whose type is NOT the identity type still collides
        // with the synthetic identity local, so it stays rejected (KOI0807).
        const string src = """
            context Catalog {
              entity Book identified by BookId {
                title: String
                create register(id: String, title: String) { title -> title }
              }
            }
            """;

        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ReservedFactoryParameter);
    }
}
