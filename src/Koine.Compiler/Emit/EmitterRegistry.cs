namespace Koine.Compiler.Emit;

/// <summary>
/// The unified emitter lookup (issue #69, Task 5): the single place that maps a target name to an
/// <see cref="IEmitterProvider"/>. It holds the built-in providers first, then any externally
/// discovered ones, so the supported-target list has a stable display order. Both the CLI's
/// <c>Koine.Cli.Infrastructure.EmitterRegistry</c> and the MCP's <c>Koine.Mcp.EmitterFactory</c>
/// delegate here, so the two surfaces can never drift in which targets they support.
///
/// <para>Lookup is case-insensitive. When two providers claim the same target, the first registered
/// wins (built-ins take precedence over externals), keeping built-in behavior stable even if a
/// plugin shadows a name.</para>
/// </summary>
public sealed class EmitterRegistry
{
    private readonly IReadOnlyList<IEmitterProvider> _providers;
    private readonly IReadOnlyDictionary<string, IEmitterProvider> _byTarget;

    /// <summary>A registry of just the built-in providers.</summary>
    public EmitterRegistry() : this(externalProviders: null) { }

    /// <summary>
    /// A registry of the built-in providers plus <paramref name="externalProviders"/> (appended after
    /// the built-ins). A null/empty external list yields the built-in-only registry.
    /// </summary>
    public EmitterRegistry(IEnumerable<IEmitterProvider>? externalProviders)
    {
        var providers = new List<IEmitterProvider>(BuiltInEmitterProviders.All);
        if (externalProviders is not null)
        {
            providers.AddRange(externalProviders);
        }

        var byTarget = new Dictionary<string, IEmitterProvider>(StringComparer.OrdinalIgnoreCase);
        var targets = new List<string>(providers.Count);
        foreach (var provider in providers)
        {
            // First registration wins: built-ins are added before externals, so a plugin cannot
            // shadow a built-in target. A duplicate is ignored (and not re-listed).
            if (byTarget.TryAdd(provider.Target, provider))
            {
                targets.Add(provider.Target);
            }
        }

        _providers = providers;
        _byTarget = byTarget;
        SupportedTargets = targets;
    }

    /// <summary>The supported target names, built-ins first then externals, in display order.</summary>
    public IReadOnlyList<string> SupportedTargets { get; }

    /// <summary>A comma-separated list of <see cref="SupportedTargets"/>, for help and error messages.</summary>
    public string SupportedList => string.Join(", ", SupportedTargets);

    /// <summary>True when <paramref name="target"/> resolves to a provider (case-insensitive).</summary>
    public bool IsSupported(string target) => _byTarget.ContainsKey(target);

    /// <summary>
    /// Creates the emitter for <paramref name="target"/> from <paramref name="options"/>, or returns
    /// <c>false</c> for an unknown target. Pass <see cref="EmitterOptions.Empty"/> for the
    /// parameterless path (output byte-identical to a plain emitter).
    /// </summary>
    public bool TryCreate(string target, EmitterOptions options, out IEmitter emitter)
    {
        if (_byTarget.TryGetValue(target, out var provider))
        {
            emitter = provider.Create(options);
            return true;
        }

        emitter = null!;
        return false;
    }
}
