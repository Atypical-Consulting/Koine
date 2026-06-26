using System.Reflection;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Guards <see cref="VersionInfo.Display"/> — the single shared source of the compiler's display
/// version behind both <c>koine --version</c> and the wasm <c>Capabilities().version</c>. It must
/// return the assembly's <see cref="AssemblyInformationalVersionAttribute"/> with any SDK-appended
/// <c>+&lt;commit&gt;</c> build-metadata suffix trimmed, falling back to the four-part assembly
/// version (then <c>"0.0.0"</c>) only when the attribute is absent.
/// </summary>
public class VersionInfoTests
{
    [Fact]
    public void Display_returns_informational_version_with_build_metadata_trimmed()
    {
        var assembly = typeof(VersionInfo).Assembly;
        var info = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        info.ShouldNotBeNullOrEmpty();

        var plus = info!.IndexOf('+');
        var expected = plus < 0 ? info : info[..plus];

        var actual = VersionInfo.Display(assembly);

        actual.ShouldBe(expected);
        actual.ShouldNotContain("+");
        actual.ShouldNotBe("0.0.0");
    }
}
