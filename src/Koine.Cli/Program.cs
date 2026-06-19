using System.Reflection;
using Koine.Cli.Commands;
using Spectre.Console;
using Spectre.Console.Cli;

namespace Koine.Cli;

internal static class Program
{
    private static int Main(string[] args) => Run(args);

    /// <summary>
    /// The CLI entry point, factored out of <see cref="Main"/> so tests can drive argument
    /// handling directly (internals are visible to Koine.Compiler.Tests) and assert exit codes.
    /// </summary>
    internal static int Run(string[] args)
    {
        // `--version`/`-v` is handled here so it prints exactly the informational version (and
        // nothing else), independent of Spectre's own help/version formatting.
        if (args.Length == 1 && args[0] is "--version" or "-v")
        {
            Console.WriteLine(GetVersion());
            return 0;
        }

        var app = new CommandApp();
        app.Configure(config =>
        {
            config.SetApplicationName("koine");

            // Reject unknown options/arguments instead of silently collecting them, so a typo'd
            // flag is a hard error (exit 1) rather than a no-op.
            config.UseStrictParsing();

            // Route Spectre's own output (help, parse errors) through the ambient Console so
            // tests that redirect Console.Out/Error still capture it, and disable ANSI styling
            // so the output stays plain/scriptable.
            config.Settings.Console = AnsiConsole.Create(new AnsiConsoleSettings
            {
                Ansi = AnsiSupport.No,
                ColorSystem = ColorSystemSupport.NoColors,
                Out = new AnsiConsoleOutput(Console.Out),
            });

            config.AddCommand<BuildCommand>("build")
                .WithDescription("Compile a .koi model and (optionally) emit code.")
                .WithExample("build", "domain.koi")
                .WithExample("build", "domain.koi", "--out", "generated")
                .WithExample("build", "./model", "--target", "glossary", "--out", "docs");

            config.AddCommand<WatchCommand>("watch")
                .WithDescription("Rebuild on every .koi change until Ctrl+C.")
                .WithExample("watch", "domain.koi", "--out", "generated")
                .WithExample("watch", "./model", "--clear");

            config.AddCommand<FmtCommand>("fmt")
                .WithDescription("Canonically format .koi source (--check: verify only).")
                .WithExample("fmt", "domain.koi")
                .WithExample("fmt", "./model", "--check");

            config.AddCommand<InitCommand>("init")
                .WithDescription("Scaffold a starter Koine project.")
                .WithExample("init")
                .WithExample("init", "./catalog", "--force");

            config.AddCommand<CheckCommand>("check")
                .WithDescription("Flag breaking changes vs a published baseline.")
                .WithExample("check", "domain.koi", "--baseline", "./published");

            config.AddCommand<LspCommand>("lsp")
                .WithDescription("Language Server (stdio) for editor diagnostics.");

            config.AddCommand<McpCommand>("mcp")
                .WithDescription("MCP server exposing the compiler tools to AI agents (stdio, or --http by URL).")
                .WithExample("mcp", "--http")
                .WithExample("mcp", "--http", "--port", "3001");
        });

        // Spectre returns -1 for its own parse/validation/usage failures; the commands return
        // 0 or 1. Normalize any negative framework code to 1 so the CLI's contract stays
        // "0 success, 1 any failure" (no shell sees -1 as 255).
        var code = app.Run(args);
        return code < 0 ? 1 : code;
    }

    /// <summary>
    /// The display version, read from <see cref="AssemblyInformationalVersionAttribute"/>
    /// (set from <c>Version</c> in Directory.Build.props) rather than the four-part
    /// <c>AssemblyVersion</c>, which defaults to <c>1.0.0.0</c>. The SDK may append a
    /// <c>+&lt;commit&gt;</c> build-metadata suffix, which we trim off.
    /// </summary>
    internal static string GetVersion()
    {
        var info = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(info))
        {
            return Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";
        }

        var plus = info.IndexOf('+');
        return plus < 0 ? info : info[..plus];
    }

    // ---- init scaffold (R17.3) ---------------------------------------------

    /// <summary>The starter domain model written by <c>koine init</c>. It must build end-to-end.</summary>
    internal const string ScaffoldModel =
        """
        /// The Catalog bounded context: the products available for sale.
        context Catalog {

          /// A monetary amount in a given currency. Amounts are never negative.
          value Money {
            amount:   Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }

          /// The currencies the catalog supports.
          enum Currency { EUR, USD, GBP }

          /// A product offered in the catalog, identified by a generated id.
          entity Product identified by ProductId {
            name:  String
            price: Money
          }
        }
        """ + "\n";

    /// <summary>A forward-compatible <c>koine.config</c>; only <c>target</c>/<c>out</c> are read today.</summary>
    internal const string ScaffoldConfig =
        """
        # koine.config — build defaults for this domain model (R17.3).
        # `koine build` / `koine watch` use these when the matching flag is omitted.

        target = csharp
        out = generated

        # Forward-compatible (R16, not yet implemented): structured per-target emitter
        # options such as namespace mapping, Instant handling, and output layout, e.g.
        #   targets.csharp = { namespaces = { Catalog = "Acme.Catalog" }, instantMode = dateTimeOffset, layout = filePerType }
        """ + "\n";

    private const string ScaffoldReadme =
        """
        # Koine domain model

        This project models a bounded context with [Koine](https://github.com/Atypical-Consulting/Koine).

        ## Build

        ```bash
        koine build domain.koi          # emits C# into ./generated (see koine.config)
        koine watch domain.koi          # re-emits on every save
        koine fmt domain.koi            # canonically formats the model
        ```

        Edit `domain.koi` to describe your own value objects, entities, aggregates,
        and the invariants that must always hold.
        """ + "\n";

    /// <summary>
    /// Scaffolds <c>domain.koi</c>, <c>koine.config</c>, and <c>README.md</c> in
    /// <paramref name="dir"/>. Refuses to overwrite any existing scaffold file unless
    /// <paramref name="force"/>. Returns whether the project was written.
    /// </summary>
    internal static bool InitProject(string dir, bool force, TextWriter stdout, TextWriter stderr)
    {
        var files = new (string Name, string Content)[]
        {
            ("domain.koi", ScaffoldModel),
            (KoineConfig.FileName, ScaffoldConfig),
            ("README.md", ScaffoldReadme),
        };

        Directory.CreateDirectory(dir);

        if (!force)
        {
            var existing = files
                .Where(f => File.Exists(Path.Combine(dir, f.Name)))
                .Select(f => f.Name)
                .ToList();
            if (existing.Count > 0)
            {
                stderr.WriteLine($"error: refusing to overwrite existing file(s): {string.Join(", ", existing)} (use --force)");
                return false;
            }
        }

        foreach (var (name, content) in files)
        {
            File.WriteAllText(Path.Combine(dir, name), content);
        }

        stdout.WriteLine($"initialized koine project in {dir}");
        stdout.WriteLine("  domain.koi     starter model");
        stdout.WriteLine("  koine.config   build defaults");
        stdout.WriteLine("  README.md      project notes");
        stdout.WriteLine($"next: koine build {Path.Combine(dir, "domain.koi")}");
        return true;
    }
}
