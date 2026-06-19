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
        cfg.Target.ShouldBe("csharp");
        cfg.OutDir.ShouldBe("generated");
        cfg.Baseline.ShouldBe("./prev");
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
        cs.OutDir.ShouldBe("generated/cs");
        cs.InstantMode.ShouldBe("nodatime");
        cs.Layout.ShouldBe("filePerType");
        cfg.OptionsFor("typescript").OutDir.ShouldBe("generated/ts");
    }

    [Fact]
    public void Parses_namespace_map()
    {
        var cfg = KoineConfig.Parse(
            "targets.csharp.namespaces.Catalog = Acme.Catalog\n" +
            "targets.csharp.namespaces.Ordering = Acme.Ordering\n");

        var map = cfg.OptionsFor("csharp").NamespaceMap;
        map["Catalog"].ShouldBe("Acme.Catalog");
        map["Ordering"].ShouldBe("Acme.Ordering");
    }

    [Fact]
    public void Unknown_target_yields_empty_options()
    {
        var cfg = KoineConfig.Parse("target = csharp\n");
        var opts = cfg.OptionsFor("rust");
        opts.ShouldBeSameAs(TargetOptions.Empty);
        opts.OutDir.ShouldBeNull();
        opts.NamespaceMap.ShouldBeEmpty();
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
        cfg.OptionsFor("csharp").OutDir.ShouldBe("generated/cs");
    }
}
