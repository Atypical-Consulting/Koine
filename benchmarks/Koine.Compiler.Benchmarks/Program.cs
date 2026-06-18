using BenchmarkDotNet.Running;
using Koine.Compiler.Benchmarks;

// `--update-docs` rewrites the results table in README.md after the run. It's our own flag, so strip
// it before handing the rest to BenchmarkDotNet (which would reject an unknown argument).
var updateDocs = args.Contains("--update-docs");
var benchArgs = args.Where(a => a != "--update-docs").ToArray();

// BenchmarkSwitcher lets you filter individual benchmarks from the CLI, e.g.
//   dotnet run -c Release -- --filter '*Compile*'
//   dotnet run -c Release -- --filter '*' --job short
var summaries = BenchmarkSwitcher.FromAssembly(typeof(Program).Assembly).Run(benchArgs);

if (updateDocs)
{
    ReadmeUpdater.Update(summaries);
}

// Top-level statements need a partial Program type for typeof(Program) above.
public partial class Program;
