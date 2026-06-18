using System.Diagnostics;
using System.Reflection;
using System.Text;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;
using Xunit.Abstractions;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Cross-emitter BEHAVIORAL conformance: for a small corpus of <c>.koi</c> models the C# and
/// TypeScript backends must AGREE on observable domain semantics — for the same input, both must
/// either accept it (no invariant violation) or reject it (a <c>DomainInvariantViolation*</c> is
/// thrown). Per-backend snapshots can prove each emitter is stable, but only running the SAME model
/// through BOTH targets can prove they encode the SAME domain.
/// </summary>
/// <remarks>
/// <para>
/// Each <see cref="Scenario"/> is expressed twice — once as a C# expression, once as a TypeScript
/// expression — that exercises the emitted domain and returns <c>true</c> when the operation was
/// accepted. The harness:
/// </para>
/// <list type="number">
///   <item>emits C# for the model, injects a generated driver, compiles it in-memory with Roslyn
///   (the existing meta-test plumbing) and invokes the driver via reflection to get accept/reject
///   per scenario;</item>
///   <item>emits TypeScript for the same model, writes a generated driver module, transpiles
///   everything with <c>tsc</c> and runs the driver under <c>node</c> (an ESM resolve hook supplies
///   the <c>.js</c> extension the emitted extensionless imports omit), reading accept/reject from
///   stdout;</item>
///   <item>asserts, per scenario, that the C# outcome, the TypeScript outcome, and the declared
///   expected outcome all agree.</item>
/// </list>
/// <para>
/// The C# half always runs (Roslyn ships with the test host). The TypeScript half needs a Node +
/// <c>tsc</c> toolchain; when none is present locally the TS comparison is reported as INCONCLUSIVE
/// (a logged notice, no assertion) so <c>dotnet test</c> stays green without a Node toolchain — but
/// the C#-vs-expected assertions still run, and a real cross-emitter divergence is asserted whenever
/// the toolchain IS present (as it is in CI). It NEVER silently passes a genuine mismatch.
/// </para>
/// </remarks>
public class CrossEmitterConformanceTests
{
    private readonly ITestOutputHelper _output;

    public CrossEmitterConformanceTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no Node/TypeScript toolchain (tsc + node) available locally; the TypeScript " +
        "half of the cross-emitter comparison was not run. The C#-vs-expected outcomes were still " +
        "asserted. Install Node + TypeScript (or set KOINE_TSC) — CI runs the full comparison.";

    // ---- The corpus -----------------------------------------------------------------------------

    /// <summary>
    /// A value object whose constructor enforces an invariant. The simplest cross-emitter contract:
    /// the same numeric input must be accepted or rejected identically by both backends.
    /// </summary>
    private const string MoneyModel = """
        context Sales {
          value Money {
            amount: Int
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// An aggregate with a state-machine command that BOTH guards a precondition AND raises a domain
    /// event (the rec #2 event-raising case). Exercises: factory invariant, command guard accept,
    /// command guard reject, and that a successful command records exactly one event in both targets.
    /// </summary>
    private const string OrderModel = """
        context Sales {
          enum OrderStatus { Draft, Placed }

          aggregate Order root Order {
            event OrderPlaced {
              lineCount: Int
            }

            entity Order identified by OrderId {
              lineCount: Int
              status:    OrderStatus = Draft

              invariant lineCount >= 1 "an order must have at least one line"

              command place {
                requires status == Draft "only a draft order can be placed"
                status -> Placed
                emit OrderPlaced(lineCount: lineCount)
              }
            }
          }
        }
        """;

    /// <summary>
    /// A command that BOTH returns a <c>result</c> AND <c>emit</c>s a domain event whose payload
    /// reuses that result (<c>tax</c>) ALONGSIDE a sibling argument whose rendering shares the
    /// result's prefix (<c>taxRate</c>). This is the result/emit hoisting case (issue #60) plus the
    /// regression guard for the substring-splice bug found in review: the hoist must rewrite only
    /// the whole-argument match (<c>tax</c> → the hoisted local) and leave <c>taxRate</c> intact. A
    /// blind substring replace would emit <c>__resultRate</c> and the generated code would not
    /// compile — so this fixture fails the harness in BOTH backends if the bug ever returns.
    /// </summary>
    private const string QuoteModel = """
        context Sales {
          event Quoted {
            amount: Int
            rate:   Int
          }

          aggregate Order root Order {
            entity Order identified by OrderId {
              tax:     Int = 0
              taxRate: Int = 0

              command quote(): Int {
                emit Quoted(amount: tax, rate: taxRate)
                result tax
              }
            }
          }
        }
        """;

    public static IEnumerable<object[]> Corpus()
    {
        yield return ["Money invariant", MoneyModel, MoneyScenarios()];
        yield return ["Order command + event", OrderModel, OrderScenarios()];
        yield return ["Quote result + emit hoist (prefix-safe)", QuoteModel, QuoteScenarios()];
    }

    /// <summary>Money(amount): accepted iff amount &gt;= 0.</summary>
    private static IReadOnlyList<Scenario> MoneyScenarios() =>
    [
        new("Money(0) accepted", Accept: true,
            Cs: "new Sales.Money(0)",
            Ts: "new Money(0)",
            TsImports: "import { Money } from './Sales/value-objects/Money';"),
        new("Money(5) accepted", Accept: true,
            Cs: "new Sales.Money(5)",
            Ts: "new Money(5)",
            TsImports: "import { Money } from './Sales/value-objects/Money';"),
        new("Money(-1) rejected", Accept: false,
            Cs: "new Sales.Money(-1)",
            Ts: "new Money(-1)",
            TsImports: "import { Money } from './Sales/value-objects/Money';"),
    ];

    /// <summary>
    /// Order construction + the <c>place</c> command. The "place records one event" scenario asserts
    /// the event-raising parity from rec #2: a successful command must leave exactly one domain event
    /// recorded in BOTH targets (the expression evaluates to that boolean, which must be <c>true</c>).
    /// </summary>
    private static IReadOnlyList<Scenario> OrderScenarios()
    {
        // In C# the identity factory is a static `OrderId.New()`; in TS it is a standalone function
        // `OrderIdNew()` (emitted alongside the OrderId class) — both mint a fresh identity.
        const string tsImports =
            "import { Order } from './Sales/Order';\n" +
            "import { OrderIdNew } from './Sales/value-objects/OrderId';";

        return
        [
            // Factory/constructor invariant: an order needs at least one line.
            new("Order(1 line) accepted", Accept: true,
                Cs: "new Sales.Order(Sales.OrderId.New(), 1)",
                Ts: "new Order(OrderIdNew(), 1)",
                TsImports: tsImports),
            new("Order(0 lines) rejected", Accept: false,
                Cs: "new Sales.Order(Sales.OrderId.New(), 0)",
                Ts: "new Order(OrderIdNew(), 0)",
                TsImports: tsImports),

            // Command guard: a Draft order can be placed; a non-Draft order cannot.
            new("place() on Draft accepted", Accept: true,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 1); o.Place(); }",
                Ts: "{ const o = new Order(OrderIdNew(), 1); o.place(); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
            new("place() twice rejected", Accept: false,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 1); o.Place(); o.Place(); }",
                Ts: "{ const o = new Order(OrderIdNew(), 1); o.place(); o.place(); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),

            // Event-raising parity (rec #2): a successful place() records exactly one domain event.
            new("place() records exactly one event", Accept: true,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 1); o.Place(); " +
                    "if (o.DomainEvents.Count != 1) throw new System.Exception(\"expected one event\"); }",
                Ts: "{ const o = new Order(OrderIdNew(), 1); o.place(); " +
                    "if (o.domainEvents.length !== 1) throw new Error('expected one event'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
        ];
    }

    /// <summary>
    /// The <c>quote</c> command (result + emit reusing <c>tax</c>, beside the prefix-sharing sibling
    /// <c>taxRate</c>). The scenario reads BOTH event payload fields back: the hoisted result must
    /// flow into <c>amount</c> while <c>rate</c> keeps the un-rewritten <c>taxRate</c>. A
    /// substring-splice regression would emit uncompilable code or the wrong <c>rate</c>: the C#
    /// half (Roslyn) catches it on every run, and the TypeScript half catches it whenever the
    /// Node/tsc toolchain is present (CI). The unconditional TS guard is the text-shape unit test in
    /// <c>TypeScriptCommandReturnTests</c>.
    /// </summary>
    private static IReadOnlyList<Scenario> QuoteScenarios()
    {
        const string tsImports =
            "import { Order } from './Sales/Order';\n" +
            "import { OrderIdNew } from './Sales/value-objects/OrderId';\n" +
            "import { Quoted } from './Sales/events/Quoted';";

        return
        [
            // The returned result is `tax`; the event records `amount: tax` (hoisted) and
            // `rate: taxRate` (NOT hoisted). All three must read back uncorrupted in both targets.
            new("quote() returns tax and records both args uncorrupted", Accept: true,
                Cs: "{ var o = new Sales.Order(Sales.OrderId.New(), 5, 2); var r = o.Quote(); " +
                    "if (r != 5) throw new System.Exception(\"wrong result\"); " +
                    "var ev = (Sales.Quoted)o.DomainEvents[0]; " +
                    "if (ev.Amount != 5 || ev.Rate != 2) throw new System.Exception(\"payload corrupted\"); }",
                Ts: "{ const o = new Order(OrderIdNew(), 5, 2); const r = o.quote(); " +
                    "if (r !== 5) throw new Error('wrong result'); " +
                    "const ev = o.domainEvents[0] as Quoted; " +
                    "if (ev.amount !== 5 || ev.rate !== 2) throw new Error('payload corrupted'); }",
                TsImports: tsImports,
                CsIsStatement: true,
                TsIsStatement: true),
        ];
    }

    // ---- The test -------------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(Corpus))]
    public void Csharp_and_typescript_agree_on_domain_semantics(
        string name, string koi, IReadOnlyList<Scenario> scenarios)
    {
        _ = name; // surfaced in the test display name only.

        bool[] csOutcomes = RunCsharp(koi, scenarios);
        TsRun ts = RunTypeScript(koi, scenarios);

        for (int i = 0; i < scenarios.Count; i++)
        {
            Scenario s = scenarios[i];

            // 1) C# must match the declared expected outcome.
            Assert.True(csOutcomes[i] == s.Accept,
                $"C#: scenario '{s.Name}' expected {Verb(s.Accept)} but got {Verb(csOutcomes[i])}.");

            // 2) When the TS toolchain ran, TS must match C# (the cross-emitter assertion).
            if (ts.ToolchainAvailable)
            {
                Assert.True(ts.Outcomes[i] == csOutcomes[i],
                    $"CROSS-EMITTER DIVERGENCE on '{s.Name}': C# {Verb(csOutcomes[i])} but " +
                    $"TypeScript {Verb(ts.Outcomes[i])} the same input.");
            }
        }

        if (!ts.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
        }
    }

    private static string Verb(bool accepted) => accepted ? "ACCEPTED" : "REJECTED";

    // ---- C# side: Roslyn compile + reflective invoke --------------------------------------------

    private static bool[] RunCsharp(string koi, IReadOnlyList<Scenario> scenarios)
    {
        CompileResult emit = new KoineCompiler().Compile(koi, new CSharpEmitter());
        Assert.True(emit.Success, "C# emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        var driver = new StringBuilder();
        driver.Append("namespace __Conformance { public static class Driver {\n");
        driver.Append("  public static bool[] Run() => new bool[] {\n");
        foreach (Scenario s in scenarios)
        {
            // Each scenario becomes a lambda that returns true if no exception escaped.
            string body = s.CsIsStatement ? s.Cs : "_ = " + s.Cs + ";";
            driver.Append("    ((System.Func<bool>)(() => { try { ")
                  .Append(body)
                  .Append(" return true; } catch { return false; } }))(),\n");
        }
        driver.Append("  };\n} }\n");

        var files = emit.Files.ToList();
        files.Add(new EmittedFile("__ConformanceDriver.cs", driver.ToString()));

        var (asm, errors) = TestSupport.Compile(files);
        Assert.True(asm is not null, "generated C# (with driver) failed to compile:\n" + string.Join("\n", errors));

        MethodInfo run = asm!.GetType("__Conformance.Driver")!.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)!;
        return (bool[])run.Invoke(null, null)!;
    }

    // ---- TypeScript side: tsc transpile + node run ----------------------------------------------

    private readonly record struct TsRun(bool ToolchainAvailable, bool[] Outcomes);

    private TsRun RunTypeScript(string koi, IReadOnlyList<Scenario> scenarios)
    {
        if (ResolveNodeTool("tsc") is not { } tsc || ResolveNodeTool("node") is not { } node)
        {
            return new TsRun(ToolchainAvailable: false, Outcomes: Array.Empty<bool>());
        }

        CompileResult emit = new KoineCompiler().Compile(koi, new TypeScriptEmitter());
        Assert.True(emit.Success, "TS emit failed:\n" + string.Join("\n", emit.Diagnostics.Select(d => d.ToString())));

        string root = Path.Combine(Path.GetTempPath(), "koine-xemit-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (EmittedFile f in emit.Files)
            {
                // Skip the emitter's tsconfig.json: we transpile by passing the .ts files explicitly
                // on the command line (with flags mirroring that tsconfig), and a present-but-unused
                // tsconfig.json makes tsc error (TS5112). The shipped tsconfig is exercised separately
                // by TypeScriptConformanceTests.
                if (string.Equals(f.RelativePath, "tsconfig.json", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
            }

            // The emitted code uses ESM with extensionless relative imports; mark the dir as ESM and
            // supply a resolve hook that appends `.js` so Node can load the transpiled output as-is.
            File.WriteAllText(Path.Combine(root, "package.json"), "{ \"type\": \"module\" }\n");
            File.WriteAllText(Path.Combine(root, "__loader.mjs"), EsmExtensionLoader);
            File.WriteAllText(Path.Combine(root, "__register.mjs"),
                "import { register } from 'node:module';\nregister('./__loader.mjs', import.meta.url);\n");

            // The driver prints one ACCEPT/REJECT line per scenario, in order. A scenario that throws
            // (any error — invariant violation or an explicit assertion failure) is a REJECT.
            File.WriteAllText(Path.Combine(root, "__driver.ts"), BuildTsDriver(scenarios));

            RunTsc(tsc, root);

            string stdout = RunNode(node, root);
            bool[] outcomes = ParseDriverOutput(stdout, scenarios.Count);
            return new TsRun(ToolchainAvailable: true, Outcomes: outcomes);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort */ }
        }
    }

    private static string BuildTsDriver(IReadOnlyList<Scenario> scenarios)
    {
        // Collect the union of imports the scenarios need (dedupe identical import lines).
        var imports = scenarios
            .SelectMany(s => s.TsImports.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Distinct()
            .ToList();

        var sb = new StringBuilder();
        foreach (string imp in imports)
        {
            sb.Append(imp).Append('\n');
        }
        sb.Append('\n');
        sb.Append("const results: string[] = [];\n");
        foreach (Scenario s in scenarios)
        {
            string body = s.TsIsStatement ? s.Ts : "void (" + s.Ts + ");";
            sb.Append("try { ").Append(body).Append(" results.push('ACCEPT'); } ")
              .Append("catch { results.push('REJECT'); }\n");
        }
        sb.Append("console.log(results.join('\\n'));\n");
        return sb.ToString();
    }

    private static bool[] ParseDriverOutput(string stdout, int expected)
    {
        var lines = stdout
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(l => l is "ACCEPT" or "REJECT")
            .ToList();

        Assert.True(lines.Count == expected,
            $"TS driver printed {lines.Count} ACCEPT/REJECT lines, expected {expected}. Raw output:\n{stdout}");

        return lines.Select(l => l == "ACCEPT").ToArray();
    }

    private static void RunTsc(string tsc, string root)
    {
        // Transpile in place to .js with the same target/module/strict settings the emitter's shipped
        // tsconfig uses (we pass them explicitly rather than via `-p .` so we can emit, not --noEmit).
        // The emitted runtime/types must therefore also type-check cleanly under --strict.
        var psi = NewPsi(tsc, root);
        psi.ArgumentList.Add("--target");
        psi.ArgumentList.Add("ES2022");
        psi.ArgumentList.Add("--module");
        psi.ArgumentList.Add("ESNext");
        psi.ArgumentList.Add("--moduleResolution");
        psi.ArgumentList.Add("bundler");
        psi.ArgumentList.Add("--strict");
        psi.ArgumentList.Add("--skipLibCheck");
        foreach (string ts in Directory.GetFiles(root, "*.ts", SearchOption.AllDirectories))
        {
            psi.ArgumentList.Add(Path.GetRelativePath(root, ts));
        }

        using var proc = Process.Start(psi)!;
        string stdout = proc.StandardOutput.ReadToEnd();
        string stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        Assert.True(proc.ExitCode == 0, "tsc failed to transpile the emitted TypeScript:\n" + stdout + stderr);
    }

    private static string RunNode(string node, string root)
    {
        var psi = NewPsi(node, root);
        psi.ArgumentList.Add("--import");
        psi.ArgumentList.Add("./__register.mjs");
        psi.ArgumentList.Add("__driver.js");

        using var proc = Process.Start(psi)!;
        string stdout = proc.StandardOutput.ReadToEnd();
        string stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        Assert.True(proc.ExitCode == 0, "node failed to run the conformance driver:\n" + stdout + stderr);
        return stdout;
    }

    private static ProcessStartInfo NewPsi(string fileName, string workingDir) => new()
    {
        FileName = fileName,
        WorkingDirectory = workingDir,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true,
    };

    /// <summary>
    /// An ESM resolve hook that appends <c>.js</c> to extensionless relative specifiers, so Node can
    /// load the transpiled emitter output (whose imports are extensionless, e.g.
    /// <c>'./value-objects/Money'</c>) without rewriting the generated code.
    /// </summary>
    private const string EsmExtensionLoader = """
        export async function resolve(specifier, context, nextResolve) {
          if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[mc]?js$/.test(specifier)) {
            try { return await nextResolve(specifier + '.js', context); } catch { /* fall through */ }
          }
          return nextResolve(specifier, context);
        }
        """;

    /// <summary>
    /// Locates a Node toolchain binary (<c>tsc</c> or <c>node</c>): an explicit <c>KOINE_TSC</c> /
    /// <c>KOINE_NODE</c> override first, then PATH, then the repo-local install under
    /// <c>tooling/koine-textmate/node_modules/.bin</c>. Returns <c>null</c> when absent so the TS half
    /// is skipped (reported inconclusive) rather than failing.
    /// </summary>
    private static string? ResolveNodeTool(string tool)
    {
        string? overrideVar = tool == "tsc"
            ? Environment.GetEnvironmentVariable("KOINE_TSC")
            : Environment.GetEnvironmentVariable("KOINE_NODE");
        if (overrideVar is { Length: > 0 })
        {
            return overrideVar;
        }

        string[] names = OperatingSystem.IsWindows() ? [tool + ".cmd", tool + ".exe", tool] : [tool];
        string[] dirs = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        foreach (string dir in dirs)
        {
            foreach (string n in names)
            {
                string candidate = Path.Combine(dir, n);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        // Fall back to the repo-local install, mirroring TestSupport.ResolveTsc(): a dev who ran
        // `npm install` under tooling/koine-textmate gets a `.bin/tsc` even with nothing on PATH, so
        // the cross-emitter check runs for real instead of staying dormant. (`node` is not vendored
        // there, so it must still be on PATH — which it is whenever npm is available.)
        return RepoLocalBin(names);
    }

    /// <summary>
    /// Probes <c>tooling/koine-textmate/node_modules/.bin/&lt;tool&gt;</c> by walking up from the test
    /// assembly directory to the repo root (the directory containing <c>.git</c>). Returns the first
    /// existing candidate, or <c>null</c> when the repo root or the install is absent.
    /// </summary>
    private static string? RepoLocalBin(string[] names)
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (!Directory.Exists(Path.Combine(dir.FullName, ".git")) &&
                !File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                continue;
            }

            foreach (string n in names)
            {
                string candidate = Path.Combine(
                    dir.FullName, "tooling", "koine-textmate", "node_modules", ".bin", n);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            return null;
        }

        return null;
    }

    /// <summary>
    /// One cross-emitter scenario: a domain operation expressed in both C# and TypeScript, plus the
    /// outcome (<see cref="Accept"/>) both backends are expected to produce for it.
    /// </summary>
    public sealed record Scenario(
        string Name,
        bool Accept,
        string Cs,
        string Ts,
        string TsImports,
        bool CsIsStatement = false,
        bool TsIsStatement = false);
}
