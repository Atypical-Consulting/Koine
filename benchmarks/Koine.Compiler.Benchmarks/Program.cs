using BenchmarkDotNet.Configs;
using BenchmarkDotNet.Jobs;
using BenchmarkDotNet.Running;
using BenchmarkDotNet.Toolchains.InProcess.Emit;
using Koine.Compiler.Benchmarks;

// `--update-docs` rewrites the results table in README.md after the run. It's our own flag, so strip
// it before handing the rest to BenchmarkDotNet (which would reject an unknown argument).
var updateDocs = args.Contains("--update-docs");
var benchArgs = args.Where(a => a != "--update-docs").ToArray();

// Run benchmarks in-process. The default toolchain generates a throwaway project and builds it by
// globbing the git root for "{assembly}.csproj" — which finds duplicate copies inside the nested
// `.claude/worktrees/*` checkouts and aborts with "more than one matching project file". The
// in-process toolchain executes in the current process, so it never searches for the csproj.
var config = DefaultConfig.Instance
    .AddJob(Job.Default.WithToolchain(InProcessEmitToolchain.Instance));

// BenchmarkSwitcher lets you filter individual benchmarks from the CLI, e.g.
//   dotnet run -c Release -- --filter '*Compile*'
//   dotnet run -c Release -- --filter '*' --job short
var summaries = BenchmarkSwitcher.FromAssembly(typeof(Program).Assembly).Run(benchArgs, config);

if (updateDocs)
{
    ReadmeUpdater.Update(summaries);
}

// Top-level statements need a partial Program type for typeof(Program) above.
public partial class Program;
