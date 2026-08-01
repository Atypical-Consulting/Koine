using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;
using Koine.Execution;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>
/// The sandbox child of the executed scenario runner (issue #236, ADR 0011) — HIDDEN, because it is a
/// protocol endpoint spoken by <see cref="ScenarioExecutionHost"/>, not a command a human runs.
///
/// <para>It reads one JSON request on stdin (the model's <c>.koi</c> sources plus target / operation /
/// given / args), parses, emits, Roslyn-compiles and EXECUTES the model's C# here — in this disposable
/// process rather than in the editor backend — and writes the resulting <c>ScenarioResult</c> tree to
/// stdout.</para>
///
/// <para>It always exits <c>0</c>: every failure, including one it cannot attribute, is reported inside
/// the tree as <c>ok: false</c> plus a note. A non-zero exit would only tell the host that something
/// went wrong without telling the user what.</para>
/// </summary>
internal sealed class ScenarioExecCommand : Command<ScenarioExecCommand.Settings>
{
    internal sealed class Settings : CommandSettings;

    protected override int Execute(CommandContext context, Settings settings, CancellationToken cancellationToken)
    {
        // Read/write the pipes with an explicit UTF-8 encoding rather than through Console's ambient
        // one: the result tree carries non-ASCII markers (∅, ⚠, …) that a console code page would mangle.
        var encoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        string request;
        using (var input = new StreamReader(Console.OpenStandardInput(), encoding))
        {
            request = input.ReadToEnd();
        }

        using var output = new StreamWriter(Console.OpenStandardOutput(), encoding) { AutoFlush = false };
        output.Write(ScenarioService.WriteJson(RunScenario(request)));
        output.Flush();
        return 0;
    }

    /// <summary>Runs the request and shapes the outcome. Never throws — the host is waiting on a tree.</summary>
    private static IReadOnlyDictionary<string, object?> RunScenario(string request)
    {
        ScenarioExecRequest parsed;
        try
        {
            parsed = ScenarioExecutionProtocol.ReadRequest(request);
        }
        catch (Exception ex)
        {
            return Failed("", "", $"The scenario request could not be read: {ex.Message}");
        }

        try
        {
            var (model, diagnostics) = new KoineCompiler().Parse(parsed.Sources);
            if (model is null || diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return Failed(parsed.Target, parsed.Operation,
                    "The model has errors; fix them before running a scenario.");
            }

            return ScenarioService.Shape(
                ScenarioExecutor.Run(new SemanticModel(model), parsed.ToScenario()), ScenarioService.ExecutedMode);
        }
        catch (Exception ex)
        {
            return Failed(parsed.Target, parsed.Operation, $"The scenario could not be run: {ex.Message}");
        }
    }

    /// <summary>A not-ok tree from this process. Everything the child answers is EXECUTED-mode — that is
    /// the only engine it runs — including the failures, so the caller is never told an answer was
    /// interpreted when nothing interpreted it.</summary>
    private static IReadOnlyDictionary<string, object?> Failed(string target, string operation, string note) =>
        ScenarioService.Error(target, operation, note, ScenarioService.ExecutedMode);
}
