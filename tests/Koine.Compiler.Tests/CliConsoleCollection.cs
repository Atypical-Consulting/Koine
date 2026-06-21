namespace Koine.Compiler.Tests;

/// <summary>
/// Groups the test classes that redirect the <b>global</b> <see cref="System.Console"/> streams
/// (via <c>Console.SetOut</c>/<c>Console.SetError</c>) into a single, non-parallel xUnit collection.
/// Those redirects mutate process-wide static state, so two such classes running concurrently can
/// clobber each other's capture (one class's <c>finally</c> restore resets the streams mid-run in
/// another), intermittently yielding empty captured output. Sharing one collection makes them run
/// sequentially; <see cref="Xunit.CollectionDefinitionAttribute.DisableParallelization"/> also keeps
/// the collection from overlapping any other Console writer.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class CliConsoleCollection
{
    public const string Name = "CLI Console (global stream redirection)";
}
