using System.Text.RegularExpressions;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Rust;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Regression guard for issue #317: a <c>create</c> factory mints the new aggregate's identity with
/// <c>&lt;Id&gt;.New()</c> (C#) / <c>&lt;Id&gt;::generate()</c> (Rust), but that generator is only emitted for a
/// Guid-backed id. The fix rejects a factory on a non-generatable (<c>natural</c>/<c>sequence</c>) key at
/// the semantic layer, so the bad shape never reaches an emitter. This suite proves the invariant two
/// ways: (1) across the real template corpus and a Guid-factory model, every emitted <c>generate()</c> /
/// <c>New()</c> *call* has a matching *definition* — no dangling reference survives; and (2) the issue's
/// exact repro model is rejected before emission with <c>KOI0808</c>.
/// </summary>
public class FactoryGeneratorConformanceTests
{
    private readonly ITestOutputHelper _output;

    public FactoryGeneratorConformanceTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no usable Rust toolchain (cargo) available; emitted crate not cargo-checked.";

    /// <summary>A Guid-identity aggregate with a <c>create</c> factory — the path that legitimately
    /// emits both a generator definition and a call to it.</summary>
    private const string GuidFactoryModel = """
        context Sales {
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>

              create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
                requires !lines.isEmpty "cannot open an empty order"
                emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
              }
            }
            event OrderOpened {
              orderId:   OrderId
              customer:  CustomerId
              lineCount: Int
            }
          }
        }
        """;

    /// <summary>The exact repro from issue #317: a <c>create</c> factory on a <c>natural(String)</c> key.</summary>
    private const string NaturalFactoryRepro = """
        context Catalog {
          entity Book identified by BookId as natural(String) {
            title:  String
            author: String
            invariant title.trim.length > 0 "a book needs a title"
            create register(title: String, author: String) {
              title  -> title
              author -> author
            }
          }
        }
        """;

    /// <summary>
    /// A Guid-identity factory emits a real <c>generate()</c>/<c>New()</c> definition AND a call to it;
    /// the scan sees the pair and confirms nothing dangles. This also proves the scan has teeth (the
    /// call sets are non-empty), so an all-green result is not a vacuous one.
    /// </summary>
    [Fact]
    public void Guid_factory_emits_matched_identity_generators()
    {
        var rust = new KoineCompiler().Compile(GuidFactoryModel, new RustEmitter());
        rust.Success.ShouldBeTrue(string.Join("\n", rust.Diagnostics.Select(d => d.ToString())));
        var rustCrate = Crate(rust.Files);
        GenerateCalls(rustCrate).ShouldNotBeEmpty("the Guid factory should emit a `::generate()` call");
        DanglingRustGenerators(rustCrate).ShouldBeEmpty();

        var cs = new KoineCompiler().Compile(GuidFactoryModel, new CSharpEmitter());
        cs.Success.ShouldBeTrue(string.Join("\n", cs.Diagnostics.Select(d => d.ToString())));
        var assembly = Crate(cs.Files);
        NewCalls(assembly).ShouldNotBeEmpty("the Guid factory should emit a `.New()` identity call");
        DanglingCsharpNewCalls(assembly).ShouldBeEmpty();
    }

    /// <summary>
    /// Across the full multi-context template corpus — the domains that actually carry factories — no
    /// emitted Rust crate or C# assembly references a generator that was never defined. The bug would
    /// surface here as a dangling <c>&lt;Id&gt;::generate()</c> / <c>&lt;Id&gt;.New()</c>.
    /// </summary>
    [Theory]
    [InlineData("pizzeria")]
    [InlineData("library")]
    [InlineData("ticketing")]
    [InlineData("saas-subscription")]
    public void Template_corpus_has_no_dangling_identity_generator(string folder)
    {
        if (FindTemplateDir(folder) is not { } sources)
        {
            _output.WriteLine($"INCONCLUSIVE: template '{folder}' not found from the test assembly.");
            return;
        }

        var rust = new KoineCompiler().Compile(sources, new RustEmitter());
        rust.Success.ShouldBeTrue(string.Join("\n", rust.Diagnostics.Select(d => d.ToString())));
        DanglingRustGenerators(Crate(rust.Files))
            .ShouldBeEmpty($"emitted Rust for '{folder}' calls a `::generate()` with no matching definition");

        var cs = new KoineCompiler().Compile(sources, new CSharpEmitter());
        cs.Success.ShouldBeTrue(string.Join("\n", cs.Diagnostics.Select(d => d.ToString())));
        DanglingCsharpNewCalls(Crate(cs.Files))
            .ShouldBeEmpty($"emitted C# for '{folder}' calls a `.New()` with no matching definition");
    }

    /// <summary>
    /// The defect's root shape — a <c>create</c> factory on a non-generatable identity — is rejected at
    /// the semantic layer (KOI0808) and never reaches an emitter, so no non-compiling crate can be
    /// produced for it in the first place.
    /// </summary>
    [Fact]
    public void Repro_model_is_rejected_before_emission()
    {
        var diags = new KoineCompiler().Diagnose(NaturalFactoryRepro);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.FactoryNeedsGeneratableIdentity);
    }

    /// <summary>
    /// The scanners themselves have teeth: a hand-crafted crate/assembly that calls a generator it never
    /// defines is flagged. Guards against the guard silently passing on everything.
    /// </summary>
    [Fact]
    public void Scanners_flag_a_hand_crafted_dangling_generator()
    {
        const string danglingRust = "let id = BookId::generate();\npub struct BookId(String);";
        DanglingRustGenerators(danglingRust).ShouldContain("BookId");

        const string danglingCs = "var id = BookId.New();\npublic sealed record BookId(string Value);";
        DanglingCsharpNewCalls(danglingCs).ShouldContain("BookId");
    }

    // ---- scanners -----------------------------------------------------------

    /// <summary>All emitted files joined into one blob — a Rust crate or a C# assembly's sources.</summary>
    private static string Crate(IReadOnlyList<EmittedFile> files) =>
        string.Join("\n", files.Select(f => f.Contents));

    /// <summary>Identity types that are *called* as <c>&lt;Id&gt;::generate()</c> in emitted Rust.</summary>
    private static ISet<string> GenerateCalls(string crate) =>
        Regex.Matches(crate, @"(\w+)::generate\(\)").Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);

    /// <summary>Rust id types whose <c>::generate()</c> is called but whose <c>pub fn generate()</c> is never emitted.</summary>
    private static ISet<string> DanglingRustGenerators(string crate)
    {
        var defined = Regex.Matches(crate, @"pub fn generate\(\)\s*->\s*Self\s*\{\s*(\w+)\(")
            .Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        var called = GenerateCalls(crate);
        called.ExceptWith(defined);
        return called;
    }

    /// <summary>Identity types that are *called* as <c>var id = &lt;Id&gt;.New()</c> in emitted C#.</summary>
    private static ISet<string> NewCalls(string assembly) =>
        Regex.Matches(assembly, @"var id = (\w+)\.New\(\)").Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);

    /// <summary>C# id types whose factory <c>.New()</c> is called but whose <c>public static &lt;Id&gt; New()</c> is never emitted.</summary>
    private static ISet<string> DanglingCsharpNewCalls(string assembly)
    {
        var defined = Regex.Matches(assembly, @"public static (\w+) New\(\)")
            .Select(m => m.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
        var called = NewCalls(assembly);
        called.ExceptWith(defined);
        return called;
    }

    // ---- template loading (mirrors RustSnapshotTests) -----------------------

    private static IReadOnlyList<SourceFile>? FindTemplateDir(string folder)
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (!Directory.Exists(Path.Combine(dir.FullName, ".git")) &&
                !File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                continue;
            }

            var templateDir = Path.Combine(dir.FullName, "templates", folder);
            return Directory.Exists(templateDir)
                ? Directory
                    .EnumerateFiles(templateDir, "*.koi", SearchOption.AllDirectories)
                    .OrderBy(p => p, StringComparer.Ordinal)
                    .Select(p => new SourceFile(p, File.ReadAllText(p)))
                    .ToList()
                : null;
        }

        return null;
    }
}
