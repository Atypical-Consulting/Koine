using Koine.Compiler.Semantics.Scenarios;

namespace Koine.Execution;

/// <summary>
/// The starting state established for ONE fanned-out downstream aggregate (issue #1758). Four
/// outcomes, and no fifth: a live instance, a factory that needs none, a state the emitted code
/// REJECTED, or an honest note saying nothing could be established. There is deliberately no
/// "default instance" case — inventing state would make the runner's timeline a story about an
/// aggregate the scenario never described.
/// </summary>
internal abstract record DownstreamState
{
    /// <summary>An instance built from the scenario's per-aggregate <c>given</c> slice, through the
    /// downstream entity's own emitted constructor — so its value objects and invariants really ran.</summary>
    public sealed record Instance(object Value) : DownstreamState;

    /// <summary>The reaction targets a FACTORY: it builds its own instance, so there is no prior state
    /// to establish and none is missing.</summary>
    public sealed record StaticTarget : DownstreamState;

    /// <summary>The routed <c>given</c> slice was REJECTED by the emitted code (a value object's
    /// invariant, the entity's own). A domain outcome carrying a real message, never a runner error —
    /// the dispatcher reports it as a failed step attributed to this aggregate.</summary>
    public sealed record Rejected(Exception Violation) : DownstreamState;

    /// <summary>No state could be established, with a reason naming the aggregate and what was missing.
    /// The dispatcher turns this into a note; it never turns it into a guess.</summary>
    public sealed record Unavailable(string Reason) : DownstreamState;
}

/// <summary>
/// Builds the downstream entity's instance from its ROUTED <c>given</c> slice (member names already
/// stripped of their <c>&lt;Entity&gt;.</c> prefix), the same way the primary path builds its own.
/// Supplied by the executor, which owns the emitted types; kept a delegate so the RULE below is
/// testable without emitting or compiling anything.
/// </summary>
internal delegate DownstreamState DownstreamConstruction(IReadOnlyDictionary<string, ScenarioValue> given);

/// <summary>
/// Decides what starting state a fanned-out downstream aggregate runs from (issue #1758, decision D2).
/// Pure: it reads the scenario's <c>given</c> map and the resolved <see cref="FanOutTarget"/>, and
/// delegates the one impure step — really constructing the instance — to the caller.
///
/// <para>The rule, in priority order:</para>
/// <list type="number">
/// <item><description>a <b>per-aggregate <c>given</c></b> slice — keys of the form
/// <c>&lt;Entity&gt;.&lt;member&gt;</c> routed to this entity (see <see cref="GivenFor"/>) — is
/// constructed exactly as the primary aggregate's given state is;</description></item>
/// <item><description>a <b>factory</b> target needs no prior instance
/// (<see cref="DownstreamState.StaticTarget"/>);</description></item>
/// <item><description>otherwise the aggregate is <b>unavailable</b>, with a reason naming it and the
/// key that would drive it.</description></item>
/// </list>
///
/// <para>A factory is answered <i>before</i> the slice is looked at rather than after, because
/// clause 1 is vacuous for it: a static factory has no receiver, so an instance built for it could
/// only be discarded. That is the same call the primary path already makes — a factory scenario notes
/// that its <c>given</c> was not applied rather than constructing something to ignore.</para>
/// </summary>
internal static class ScenarioDownstreamState
{
    /// <summary>
    /// The slice of <paramref name="given"/> that belongs to <paramref name="entityName"/>: every key
    /// <c>&lt;Entity&gt;.&lt;member&gt;</c> whose entity segment matches (case-insensitively — the
    /// entity segment is a type name a scenario author types by hand), with the prefix stripped so the
    /// result is keyed by plain member names, exactly like the primary aggregate's own <c>given</c>.
    ///
    /// <para>A BARE (undotted) key is always the primary aggregate's and is never routed downstream:
    /// that is what keeps a fanned-out run from silently inheriting the primary's state. Dotted keys
    /// naming another aggregate are likewise left alone, and a key with nothing after the dot selects
    /// no member.</para>
    /// </summary>
    public static IReadOnlyDictionary<string, ScenarioValue> GivenFor(
        IReadOnlyDictionary<string, ScenarioValue> given,
        string entityName)
    {
        var routed = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal);
        if (given.Count == 0 || string.IsNullOrEmpty(entityName))
        {
            return routed;
        }

        // Ordinal-ordered so a model that keys the same member twice (`Books.amount` and
        // `books.amount`) resolves deterministically rather than by hash order.
        foreach ((string key, ScenarioValue value) in given.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            int dot = key.IndexOf('.');
            if (dot <= 0 || dot == key.Length - 1)
            {
                continue; // a bare key (the primary's), or a prefix selecting no member
            }

            if (string.Equals(key[..dot], entityName, StringComparison.OrdinalIgnoreCase))
            {
                routed.TryAdd(key[(dot + 1)..], value);
            }
        }

        return routed;
    }

    /// <summary>
    /// The slice driving <paramref name="target"/>: keyed by its ENTITY, or — when that finds nothing
    /// and the two names differ — by its AGGREGATE. A policy reaction names the aggregate
    /// (<c>then Books.record(...)</c>), so that is the name a scenario author reads off the model,
    /// while the members being set are the root entity's. Both spellings reach the same state.
    /// </summary>
    public static IReadOnlyDictionary<string, ScenarioValue> RoutedGiven(
        FanOutTarget target,
        IReadOnlyDictionary<string, ScenarioValue> given)
    {
        IReadOnlyDictionary<string, ScenarioValue> routed = GivenFor(given, target.EntityName);
        return routed.Count > 0 || string.Equals(target.AggregateName, target.EntityName, StringComparison.OrdinalIgnoreCase)
            ? routed
            : GivenFor(given, target.AggregateName);
    }

    /// <summary>
    /// Applies the rule to one resolved <paramref name="target"/>.
    /// <paramref name="primaryEntityName"/> is the scenario's own aggregate — used only to say, in the
    /// unavailable case, what the <c>given</c> state does describe.
    /// <paramref name="construct"/> is invoked at most once, with the routed slice.
    /// </summary>
    public static DownstreamState Establish(
        FanOutTarget target,
        string primaryEntityName,
        IReadOnlyDictionary<string, ScenarioValue> given,
        DownstreamConstruction construct)
    {
        if (target.IsFactory)
        {
            return new DownstreamState.StaticTarget();
        }

        IReadOnlyDictionary<string, ScenarioValue> routed = RoutedGiven(target, given);
        return routed.Count > 0
            ? construct(routed)
            : new DownstreamState.Unavailable(UnavailableReason(target, primaryEntityName, given));
    }

    /// <summary>
    /// Why nothing could be established, said precisely enough to act on: which aggregate has no state,
    /// which ones the scenario DOES describe, and the exact key to add. Never a hint that the runner
    /// might have guessed instead.
    /// </summary>
    public static string UnavailableReason(
        FanOutTarget target,
        string primaryEntityName,
        IReadOnlyDictionary<string, ScenarioValue> given)
    {
        string named = string.Equals(target.AggregateName, target.EntityName, StringComparison.Ordinal)
            ? target.EntityName
            : $"{target.EntityName} (the root of {target.AggregateName})";

        return $"No state was established for {named}: {Describes(primaryEntityName, given)}. "
               + $"Add a '{target.EntityName}.<member>' entry to the scenario's given state to drive the "
               + "downstream aggregate.";
    }

    /// <summary>What the scenario's <c>given</c> state actually describes: the primary aggregate when it
    /// carries any bare key, plus every other dotted prefix it mentions.</summary>
    private static string Describes(string primaryEntityName, IReadOnlyDictionary<string, ScenarioValue> given)
    {
        var described = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (string key in given.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            int dot = key.IndexOf('.');
            if (dot <= 0)
            {
                if (!string.IsNullOrEmpty(primaryEntityName) && seen.Add(primaryEntityName))
                {
                    described.Insert(0, primaryEntityName); // the primary reads first
                }

                continue;
            }

            string prefix = key[..dot];
            if (seen.Add(prefix))
            {
                described.Add(prefix);
            }
        }

        return described.Count == 0
            ? "the scenario declares no given state"
            : $"the scenario's given state describes only {Join(described)}";
    }

    /// <summary>"A", "A and B", "A, B and C".</summary>
    private static string Join(IReadOnlyList<string> names) => names.Count switch
    {
        1 => names[0],
        2 => $"{names[0]} and {names[1]}",
        _ => $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}"
    };
}
