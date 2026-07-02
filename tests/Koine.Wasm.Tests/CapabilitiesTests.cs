using System.Reflection;
using System.Text.Json.Nodes;
using Koine.Compiler;
using Koine.Compiler.Emit;

namespace Koine.Wasm.Tests;

/// <summary>
/// The module self-description export (issue #330, <see cref="Koine.Wasm.CompilerInterop.Capabilities"/>):
/// its version, the names of every <c>[JSExport]</c> it ships, and the registry's emit targets — the
/// single source of truth Koine Studio verifies its surface against at boot (replacing the hand-maintained
/// export list) and the docs-site playground reads its version line from.
/// </summary>
public class CapabilitiesTests
{
    // CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary, but
    // Capabilities has no JS interop in its body — safe to call off-browser in a unit test (like the
    // ListEmitTargets parity test does).
#pragma warning disable CA1416
    private static string WasmCapabilities() => CompilerInterop.Capabilities();
#pragma warning restore CA1416

    private static JsonNode Caps() => JsonNode.Parse(WasmCapabilities())!;

    [Fact]
    public void Version_is_the_assemblys_real_informational_version()
    {
        var version = Caps()["version"]!.GetValue<string>();

        version.ShouldNotBeNullOrEmpty();
        // Not the four-part AssemblyVersion defaults the CLI's GetVersion() guards against.
        version.ShouldNotBe("0.0.0");
        version.ShouldNotBe("1.0.0");
        version.ShouldNotBe("1.0.0.0");
        // Equals the assembly's informational version with any +<commit> build-metadata suffix trimmed —
        // the same value `koine --version` reports (both read AssemblyInformationalVersionAttribute), so it
        // tracks Directory.Build.props's <Version> automatically.
        version.ShouldBe(ExpectedInformationalVersion());
    }

    [Fact]
    public void Exports_is_non_empty_and_contains_capabilities_and_known_names()
    {
        var exports = ExportNames();

        exports.ShouldNotBeEmpty();
        exports.ShouldContain("Capabilities"); // must list itself
        exports.ShouldContain("Compile");
        exports.ShouldContain("DiagnoseWorkspace");
    }

    [Fact]
    public void Exports_match_the_actual_jsexport_surface_exactly()
    {
        // The runtime list is a curated constant (reflecting [JSExport] attributes off the trimmed wasm
        // assembly is fragile under TrimMode=full); this test reflects the REAL surface — un-trimmed,
        // in-test — so the curated constant can never silently drift from the methods actually shipped.
        // Read attribute METADATA (GetCustomAttributesData), not instances: instantiating
        // JSExportAttribute off-browser throws PlatformNotSupportedException (its ctor calls into JS
        // interop), whereas the metadata reflection works on any platform.
        var declared = typeof(CompilerInterop)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.GetCustomAttributesData().Any(a => a.AttributeType.Name == "JSExportAttribute"))
            .Select(m => m.Name)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray();

        ExportNames().OrderBy(n => n, StringComparer.Ordinal).ShouldBe(declared);
    }

    [Fact]
    public void Targets_match_the_registry_supported_target_infos()
    {
        var targets = Caps()["targets"]!.AsArray();
        var expected = new EmitterRegistry(BuiltInEmitterProviders.All).SupportedTargetInfos;

        // Same list, in the same order, as ListEmitTargets / koine/emitTargets — no second target list.
        targets.Select(t => t!["id"]!.GetValue<string>())
            .ShouldBe(expected.Select(i => i.Id));

        // Each target carries the full { id, displayName, fileExtension } metadata.
        foreach (var info in expected)
        {
            var t = targets.First(n => n!["id"]!.GetValue<string>() == info.Id)!;
            t["displayName"]!.GetValue<string>().ShouldBe(info.DisplayName);
            t["fileExtension"]!.GetValue<string>().ShouldBe(info.FileExtension);
        }
    }

    private static string[] ExportNames() =>
        Caps()["exports"]!.AsArray().Select(n => n!.GetValue<string>()).ToArray();

    private static string ExpectedInformationalVersion()
    {
        var info = typeof(CompilerInterop).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";
        var plus = info.IndexOf('+');
        return plus < 0 ? info : info[..plus];
    }
}
