namespace Koine.Compiler.Tests;

/// <summary>
/// Groups the test classes that drive <c>ScenarioExecutionHost</c>'s child process into a single,
/// non-parallel xUnit collection.
///
/// <para>The host reads <c>KOINE_SCENARIO_EXEC_COMMAND</c> from the PROCESS environment on every run, and
/// the confinement suite (#1759) sets it to point at a stub child. That is process-wide state: a class
/// running concurrently would silently get the stub instead of the real <c>koine scenario-exec</c> — and
/// fail with a result tree it never asked for. Sharing one collection makes them run sequentially, the
/// same remedy <see cref="CliConsoleCollection"/> applies to global Console redirection.</para>
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ScenarioSandboxCollection
{
    public const string Name = "Scenario sandbox (process-wide child-command override)";
}
