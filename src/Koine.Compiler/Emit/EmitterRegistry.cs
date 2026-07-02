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
    private readonly IReadOnlyDictionary<string, IEmitterProvider> _byTarget;

    /// <summary>
    /// A registry of exactly <paramref name="builtInProviders"/> — the built-in emitter set the caller
    /// supplies (pass <c>Koine.Compiler.Emit.BuiltInEmitterProviders.All</c> from the
    /// <c>Koine.Emit.All</c> aggregator for the shipping targets). The core compiler no longer hardcodes
    /// the built-ins (issue #861): each emitter lives in its own <c>Koine.Emit.&lt;Target&gt;</c>
    /// assembly, so the list is injected from above rather than read from a static the compiler can't
    /// reference without a cycle.
    /// </summary>
    public EmitterRegistry(IReadOnlyList<IEmitterProvider> builtInProviders)
        : this(builtInProviders, externalProviders: null) { }

    /// <summary>
    /// A registry of <paramref name="builtInProviders"/> plus <paramref name="externalProviders"/>
    /// (appended after the built-ins, so a plugin can never shadow a built-in target). A null/empty
    /// external list yields the built-in-only registry.
    /// </summary>
    public EmitterRegistry(
        IReadOnlyList<IEmitterProvider> builtInProviders,
        IEnumerable<IEmitterProvider>? externalProviders)
    {
        ArgumentNullException.ThrowIfNull(builtInProviders);
        var providers = new List<IEmitterProvider>(builtInProviders);
        if (externalProviders is not null)
        {
            providers.AddRange(externalProviders);
        }

        var byTarget = new Dictionary<string, IEmitterProvider>(StringComparer.OrdinalIgnoreCase);
        var targets = new List<string>(providers.Count);
        var targetInfos = new List<EmitTargetInfo>(providers.Count);
        foreach (var provider in providers)
        {
            // First registration wins: built-ins are added before externals, so a plugin cannot
            // shadow a built-in target. A duplicate is ignored (and not re-listed).
            if (byTarget.TryAdd(provider.Target, provider))
            {
                targets.Add(provider.Target);
                // The infos list is the IDE-facing emit-target list (issue #282): code targets only,
                // so glossary/docs (IsEmitTarget == false) stay resolvable but are excluded here.
                if (provider.IsEmitTarget)
                {
                    targetInfos.Add(new EmitTargetInfo(provider.Target, provider.DisplayName, provider.FileExtension));
                }
            }
        }

        _byTarget = byTarget;
        SupportedTargets = targets;
        SupportedTargetInfos = targetInfos;
    }

    /// <summary>The supported target names, built-ins first then externals, in display order.</summary>
    public IReadOnlyList<string> SupportedTargets { get; }

    /// <summary>
    /// The display metadata (<see cref="EmitTargetInfo"/>) for every code-emit target, in display
    /// order — the IDE-facing capability list (issue #282). Excludes non-emit providers such as the
    /// built-in <c>glossary</c>/<c>docs</c> generators (those stay in <see cref="SupportedTargets"/>).
    /// </summary>
    public IReadOnlyList<EmitTargetInfo> SupportedTargetInfos { get; }

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
