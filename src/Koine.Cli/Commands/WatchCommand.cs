using System.Collections.Concurrent;
using System.ComponentModel;
using Koine.Cli.Infrastructure;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>Flags for <c>watch</c>: the <c>build</c> flags plus <c>--clear</c>.</summary>
internal sealed class WatchSettings : BuildSettings
{
    [CommandOption("--clear")]
    [Description("Clear the console before each rebuild.")]
    public bool Clear { get; init; }
}

/// <summary>Rebuilds on every .koi change until Ctrl+C.</summary>
internal sealed class WatchCommand : Command<WatchSettings>
{
    protected override int Execute(CommandContext context, WatchSettings settings, CancellationToken cancellationToken)
    {
        if (!settings.TryResolve(out var plan, out var error))
        {
            return CliError.Runtime(error!);
        }

        // Watch the input's directory (or the directory itself), filtered to .koi files.
        var watchDir = Directory.Exists(plan.File)
            ? plan.File
            : Path.GetDirectoryName(Path.GetFullPath(plan.File)) ?? ".";

        using var watcher = new FileSystemWatcher(watchDir, "*.koi");
        watcher.IncludeSubdirectories = true;
        watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size;
        // Give the OS a roomy buffer so bursts of saves are less likely to overflow.
        watcher.InternalBufferSize = 64 * 1024;

        var changes = new BlockingCollection<object>();
        void Bump()
        { try { changes.Add(new object()); } catch (InvalidOperationException) { } }
        watcher.Changed += (_, _) => Bump();
        watcher.Created += (_, _) => Bump();
        watcher.Deleted += (_, _) => Bump();
        watcher.Renamed += (_, _) => Bump();
        // If the buffer overflows, individual events are lost; force a rebuild so the
        // output never silently lags behind the source.
        watcher.Error += (_, _) => Bump();
        watcher.EnableRaisingEvents = true;

        using var cts = new CancellationTokenSource();
        ConsoleCancelEventHandler onCancel = (_, e) =>
        {
            e.Cancel = true;            // let the loop unwind cleanly instead of killing the process
            // onCancel is unsubscribed in the finally before `cts` is disposed, so this can't touch a
            // disposed source — the "captured variable disposed in outer scope" hint is a false positive.
            // ReSharper disable once AccessToDisposedClosure
            cts.Cancel();
            changes.CompleteAdding();
        };
        Console.CancelKeyPress += onCancel;
        try
        {
            Console.WriteLine($"watching {watchDir} for *.koi changes — press Ctrl+C to stop");
            var session = new WatchSession(
                () => BuildCommand.BuildOnce(plan) == 0,
                Console.Out,
                TimeSpan.FromMilliseconds(250),
                // A safety-net full rebuild every minute, in case any change event was dropped.
                fullRebuildInterval: TimeSpan.FromMinutes(1),
                beforeBuild: settings.Clear ? () => Console.Clear() : null);
            session.Run(changes, cts.Token);
            return 0;
        }
        finally
        {
            // Unsubscribe before `cts` is disposed so a late Ctrl+C can't touch a disposed source.
            Console.CancelKeyPress -= onCancel;
        }
    }
}
