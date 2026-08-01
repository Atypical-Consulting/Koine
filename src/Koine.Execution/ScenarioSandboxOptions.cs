namespace Koine.Execution;

/// <summary>
/// What the scenario sandbox asks the OS to enforce on the child, ON TOP OF (never instead of) ADR
/// 0011's v1 guarantees — process isolation, the wall-clock deadline with a process-tree kill, the
/// scrubbed environment, and the per-run temp working directory.
///
/// <para>Every knob here is best-effort by contract: a mechanism this platform cannot provide degrades
/// to a note on the result (<see cref="ScenarioConfinement.Degradations"/>), never to a failed run. A
/// scenario must not stop working because the host is a platform whose confinement story is thinner.</para>
/// </summary>
internal sealed record ScenarioSandboxOptions
{
    /// <summary>The managed-heap ceiling a run gets by default: enough headroom for a Roslyn compile of a
    /// large model, far below the point at which a runaway allocation starts costing the machine.</summary>
    public const long DefaultMemoryLimitBytes = 1L << 30;

    /// <summary>The floor under the derived CPU ceiling (see <see cref="For"/>), so a tiny wall-clock
    /// budget on a single-core machine still leaves room for runtime start-up and a compile.</summary>
    public const int MinimumCpuSeconds = 30;

    /// <summary>Everything the sandbox knows how to enforce, at its default strength.</summary>
    public static readonly ScenarioSandboxOptions Default = new();

    /// <summary>Confinement switched off entirely — the v1 boundary and nothing more. Exists so a host
    /// that must not pay for confinement (and the tests that prove the difference) can say so
    /// explicitly rather than by passing a pile of nulls.</summary>
    public static readonly ScenarioSandboxOptions None = new()
    {
        MemoryLimitBytes = null,
        CpuLimit = null,
        DenyNetwork = false,
        RestrictFilesystem = false,
    };

    /// <summary>The child's memory ceiling, or <c>null</c> for none. Enforced by the runtime the child
    /// starts (a GC heap hard limit — portable, and exactly where a runaway allocation in emitted code
    /// lands) and, on Windows, additionally by the OS through a Job Object.</summary>
    public long? MemoryLimitBytes { get; init; } = DefaultMemoryLimitBytes;

    /// <summary>The child's ceiling on PROCESSOR time — not wall-clock time, which the deadline already
    /// bounds. Its job is the case the deadline cannot reach: a process that survived the tree kill, or
    /// one the kill never saw. <c>null</c> for none.</summary>
    public TimeSpan? CpuLimit { get; init; } = TimeSpan.FromSeconds(MinimumCpuSeconds);

    /// <summary>Whether the child should be denied network access where the platform can express it.</summary>
    public bool DenyNetwork { get; init; } = true;

    /// <summary>Whether the child's writes should be confined to its per-run directory where the platform
    /// can express it. Reads stay open: the child must load the .NET runtime and its own assemblies.</summary>
    public bool RestrictFilesystem { get; init; } = true;

    /// <summary>
    /// The default options for a run with the given wall-clock budget. The CPU ceiling is DERIVED from
    /// that budget rather than fixed, on the principle that a run cannot legitimately burn more processor
    /// time than every core on the machine could have produced before the deadline expired — which makes
    /// the cap a true backstop rather than a second, tighter deadline that would kill slow-but-honest runs.
    /// </summary>
    public static ScenarioSandboxOptions For(TimeSpan wallClock)
    {
        double budget = wallClock.TotalSeconds * Math.Max(1, Environment.ProcessorCount);
        double seconds = Math.Min(Math.Max(MinimumCpuSeconds, Math.Ceiling(budget)), int.MaxValue);
        return Default with { CpuLimit = TimeSpan.FromSeconds(seconds) };
    }
}
