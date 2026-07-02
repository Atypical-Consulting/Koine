using BenchmarkDotNet.Attributes;
using Koine.Compiler.Services;

namespace Koine.Compiler.Benchmarks;

/// <summary>The .koi inputs we benchmark against.</summary>
public enum Corpus
{
    /// <summary>A single small file — the lexer/parser/emit baseline (~0.8 KB).</summary>
    Billing,

    /// <summary>The full multi-file Pizzeria domain (8 files) compiled as one model,
    /// so cross-file context maps and integration events resolve — a realistic workload.</summary>
    Pizzeria,
}

/// <summary>
/// Tracks the cost of the public compile pipeline across its stages so regressions surface as the
/// codebase evolves. Each stage runs against both a small single file and a realistic multi-file model.
/// </summary>
/// <remarks>
/// Run with: <c>dotnet run -c Release --project benchmarks/Koine.Compiler.Benchmarks</c>
/// (Release is mandatory — BenchmarkDotNet refuses Debug builds).
/// </remarks>
[MemoryDiagnoser]
public class CompilerBenchmarks
{
    private readonly KoineCompiler _compiler = new();
    private IReadOnlyList<SourceFile> _sources = [];

    [Params(Corpus.Billing, Corpus.Pizzeria)]
    public Corpus Input { get; set; }

    [GlobalSetup]
    public void Setup()
    {
        var corpus = Path.Combine(AppContext.BaseDirectory, "corpus");
        _sources = Input switch
        {
            Corpus.Billing => [ReadSource(Path.Combine(corpus, "billing.koi"))],
            Corpus.Pizzeria => Directory
                .EnumerateFiles(Path.Combine(corpus, "pizzeria"), "*.koi")
                .OrderBy(p => p, StringComparer.Ordinal)
                .Select(ReadSource)
                .ToList(),
            _ => throw new ArgumentOutOfRangeException(nameof(Input)),
        };

        if (_sources.Count == 0)
        {
            throw new InvalidOperationException(
                $"No .koi corpus found under '{corpus}'. Check the csproj CopyToOutputDirectory links.");
        }
    }

    private static SourceFile ReadSource(string path) => new(path, File.ReadAllText(path));

    /// <summary>Lex + parse + model build only.</summary>
    [Benchmark]
    public object? Parse() => _compiler.Parse(_sources).Model;

    /// <summary>Parse + semantic validation (no emit).</summary>
    [Benchmark]
    public object Diagnose() => _compiler.DiagnoseWorkspace(_sources);

    /// <summary>Full pipeline: parse + validate + C# emit. The baseline the stages are measured against.</summary>
    [Benchmark(Baseline = true)]
    public object Compile() => _compiler.Compile(_sources, new CSharpEmitter());
}
