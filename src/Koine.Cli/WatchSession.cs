using System.Collections.Concurrent;

namespace Koine.Cli;

/// <summary>
/// The re-build loop behind <c>koine watch</c> (R17.3). It is decoupled from the
/// file system: change signals arrive on a <see cref="BlockingCollection{T}"/>, so a
/// test can drive it deterministically while the CLI feeds it from a
/// <see cref="FileSystemWatcher"/>. The loop debounces a burst of saves into a single
/// rebuild and keeps running after a failed or throwing build.
/// </summary>
internal sealed class WatchSession
{
    private readonly Func<bool> _build;     // one build + report; returns success
    private readonly TextWriter _log;
    private readonly TimeSpan _debounce;
    private readonly Func<DateTime> _clock;

    public WatchSession(Func<bool> build, TextWriter log, TimeSpan debounce, Func<DateTime>? clock = null)
    {
        _build = build;
        _log = log;
        _debounce = debounce;
        _clock = clock ?? (() => DateTime.Now);
    }

    /// <summary>
    /// Runs an initial build, then rebuilds once per (debounced) batch of change
    /// signals until <paramref name="changes"/> is completed or <paramref name="ct"/>
    /// is cancelled. The number of rebuilds performed (excluding the initial build).
    /// </summary>
    public int Run(BlockingCollection<object> changes, CancellationToken ct = default)
    {
        SafeBuild();   // build once up front so the user sees the current state immediately

        var rebuilds = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (!changes.TryTake(out _, Timeout.Infinite, ct))
                    break;                       // change source completed — stop watching
                DrainDebounce(changes, ct);      // collapse a burst of saves into one rebuild
                SafeBuild();
                rebuilds++;
            }
        }
        catch (OperationCanceledException) { /* Ctrl+C: exit quietly */ }
        catch (InvalidOperationException) { /* CompleteAdding raced TryTake: stop */ }

        return rebuilds;
    }

    /// <summary>Trailing debounce: swallow further changes until a quiet <see cref="_debounce"/> window.</summary>
    private void DrainDebounce(BlockingCollection<object> changes, CancellationToken ct)
    {
        var ms = (int)_debounce.TotalMilliseconds;
        if (ms <= 0)
        {
            while (changes.TryTake(out _)) { }
            return;
        }
        try { while (changes.TryTake(out _, ms, ct)) { } }
        catch (OperationCanceledException) { }
    }

    private void SafeBuild()
    {
        var stamp = _clock().ToString("HH:mm:ss");
        try
        {
            var ok = _build();
            _log.WriteLine(ok ? $"[{stamp}] build OK" : $"[{stamp}] build failed");
        }
        catch (Exception ex)
        {
            // A crashing build must not take down the watcher (R17.3).
            _log.WriteLine($"[{stamp}] build error: {ex.Message}");
        }
    }
}
