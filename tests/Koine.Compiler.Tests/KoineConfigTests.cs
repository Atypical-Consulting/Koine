using Koine.Cli;

namespace Koine.Compiler.Tests;

/// <summary>
/// The koine.config reader, including the R16.1 structured per-target block
/// (<c>targets.&lt;name&gt;.{out,instantMode,layout,namespaces.&lt;Context&gt;}</c>).
/// </summary>
public class KoineConfigTests
{
    [Fact]
    public void Parses_flat_keys()
    {
        var cfg = KoineConfig.Parse("target = csharp\nout = generated\nbaseline = ./prev\n");
        Assert.Equal("csharp", cfg.Target);
        Assert.Equal("generated", cfg.OutDir);
        Assert.Equal("./prev", cfg.Baseline);
    }

    [Fact]
    public void Parses_per_target_out_and_options()
    {
        var cfg = KoineConfig.Parse(
            "target = csharp\n" +
            "targets.csharp.out = generated/cs\n" +
            "targets.csharp.instantMode = nodatime\n" +
            "targets.csharp.layout = filePerType\n" +
            "targets.typescript.out = generated/ts\n");

        var cs = cfg.OptionsFor("csharp");
        Assert.Equal("generated/cs", cs.OutDir);
        Assert.Equal("nodatime", cs.InstantMode);
        Assert.Equal("filePerType", cs.Layout);
        Assert.Equal("generated/ts", cfg.OptionsFor("typescript").OutDir);
    }

    [Fact]
    public void Parses_namespace_map()
    {
        var cfg = KoineConfig.Parse(
            "targets.csharp.namespaces.Catalog = Acme.Catalog\n" +
            "targets.csharp.namespaces.Ordering = Acme.Ordering\n");

        var map = cfg.OptionsFor("csharp").NamespaceMap;
        Assert.Equal("Acme.Catalog", map["Catalog"]);
        Assert.Equal("Acme.Ordering", map["Ordering"]);
    }

    [Fact]
    public void Unknown_target_yields_empty_options()
    {
        var cfg = KoineConfig.Parse("target = csharp\n");
        var opts = cfg.OptionsFor("rust");
        Assert.Same(TargetOptions.Empty, opts);
        Assert.Null(opts.OutDir);
        Assert.Empty(opts.NamespaceMap);
    }

    [Fact]
    public void Forward_compatible_unknown_and_malformed_keys_are_ignored()
    {
        // An unknown structured key and a partial targets key must not throw and must not
        // pollute a target's options.
        var cfg = KoineConfig.Parse(
            "future.feature = on\n" +
            "targets.csharp = oops\n" +      // missing .<rest>
            "targets..out = nope\n" +         // empty name
            "targets.csharp.out = generated/cs\n");
        Assert.Equal("generated/cs", cfg.OptionsFor("csharp").OutDir);
    }
}
