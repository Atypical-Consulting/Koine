using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class WorkspaceSymbolTests
{
    private static readonly KoineLanguageService Svc = new();

    private const string UriA = "file:///a.koi";
    private const string UriB = "file:///b.koi";

    private const string SrcA =
        "context Sales {\n" +
        "  value Order { id: String }\n" +
        "}\n";

    private const string SrcB =
        "context Billing {\n" +
        "  value OrderLine { qty: Int }\n" +
        "}\n";

    private static IReadOnlyDictionary<string, string> Docs() =>
        new Dictionary<string, string> { [UriA] = SrcA, [UriB] = SrcB };

    [Fact]
    public void Query_subsequence_matches_across_files_with_uri_and_container()
    {
        var results = Svc.WorkspaceSymbols(Docs(), "Ord");

        // Order from file A, container is the context name.
        results.ShouldContain(s => s.Name == "Order" && s.Uri == UriA && s.ContainerName == "Sales");

        // OrderLine matched by subsequence "Ord", from file B.
        results.ShouldContain(s => s.Name == "OrderLine" && s.Uri == UriB && s.ContainerName == "Billing");

        // A non-matching declaration is excluded.
        results.ShouldNotContain(s => s.Name == "Billing");
    }

    [Fact]
    public void Empty_query_returns_every_declaration()
    {
        var results = Svc.WorkspaceSymbols(Docs(), "");

        results.ShouldContain(s => s.Name == "Sales" && s.Uri == UriA);
        results.ShouldContain(s => s.Name == "Order" && s.Uri == UriA && s.ContainerName == "Sales");
        results.ShouldContain(s => s.Name == "id" && s.ContainerName == "Order");
        results.ShouldContain(s => s.Name == "Billing" && s.Uri == UriB);
        results.ShouldContain(s => s.Name == "OrderLine" && s.Uri == UriB && s.ContainerName == "Billing");
        results.ShouldContain(s => s.Name == "qty" && s.ContainerName == "OrderLine");
    }

    [Fact]
    public void Subsequence_is_case_insensitive()
    {
        var results = Svc.WorkspaceSymbols(Docs(), "ol");
        // "ol" is a subsequence of "OrderLine" (O...L...).
        results.ShouldContain(s => s.Name == "OrderLine");
    }
}
