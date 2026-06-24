using System.Globalization;

namespace Koine.Compiler.Semantics.Scenarios;

// ============================================================================
// The scenario runner's data model (#149, Approach B). TARGET-AGNOSTIC: plain
// values and outcomes, no C#/JSON concept. The interpreter consumes the semantic
// model and produces these; the LSP host owns the JSON <-> value mapping.
// ============================================================================

/// <summary>
/// One thing to exercise against the domain: a starting aggregate-root state
/// (<paramref name="Given"/>), one command or factory to run
/// (<paramref name="Operation"/> on <paramref name="Target"/>), and its
/// arguments (<paramref name="Args"/>).
/// </summary>
internal sealed record Scenario(
    string Target,
    string Operation,
    IReadOnlyDictionary<string, ScenarioValue> Given,
    IReadOnlyDictionary<string, ScenarioValue> Args);

/// <summary>
/// A runtime value the interpreter computes over. Used for inputs (given state /
/// args), intermediate evaluation, and display. A neutral union — never an
/// emitted-language value.
/// </summary>
internal abstract record ScenarioValue
{
    /// <summary>A numeric value (Int or Decimal). <see cref="IsInteger"/> records integrality.</summary>
    public sealed record Num(decimal Value, bool IsInteger) : ScenarioValue;

    /// <summary>A boolean value.</summary>
    public sealed record Bool(bool Value) : ScenarioValue;

    /// <summary>A string value (verbatim, no surrounding quotes).</summary>
    public sealed record Text(string Value) : ScenarioValue;

    /// <summary>An enum member, by name; the owning enum is resolved from context.</summary>
    public sealed record EnumMember(string Member) : ScenarioValue;

    /// <summary>An ordered collection of values (a <c>List</c>/<c>Set</c> field).</summary>
    public sealed record List(IReadOnlyList<ScenarioValue> Items) : ScenarioValue;

    /// <summary>A composite value (a value object / nested record): field name -&gt; value.</summary>
    public sealed record Record(IReadOnlyDictionary<string, ScenarioValue> Fields) : ScenarioValue;

    /// <summary>An absent optional (a <c>T?</c> with no value), i.e. null.</summary>
    public sealed record Absent : ScenarioValue;

    /// <summary>The <c>now</c> marker — a point in time the interpreter does not pin to a clock.</summary>
    public sealed record Instant : ScenarioValue;

    /// <summary>An indeterminate value: an expression the interpreter cannot evaluate, with the reason.</summary>
    public sealed record Unknown(string Reason) : ScenarioValue;

    // -- ergonomic constructors (keep call sites + tests readable) -------------

    public static ScenarioValue FromInt(long v) => new Num(v, IsInteger: true);

    public static ScenarioValue FromDecimal(decimal v) => new Num(v, IsInteger: false);

    public static ScenarioValue FromString(string v) => new Text(v);

    public static ScenarioValue FromBool(bool v) => new Bool(v);

    public static ScenarioValue Enum(string member) => new EnumMember(member);

    public static ScenarioValue ListOf(params ScenarioValue[] items) => new List(items);

    public static ScenarioValue RecordOf(params (string Name, ScenarioValue Value)[] fields) =>
        new Record(fields.ToDictionary(f => f.Name, f => f.Value, StringComparer.Ordinal));

    public static readonly ScenarioValue Missing = new Absent();

    /// <summary>A short, human-readable rendering for the timeline / resulting-state display.</summary>
    public string Display() => this switch
    {
        Num n => n.IsInteger && n.Value == decimal.Truncate(n.Value)
            ? ((long)n.Value).ToString(CultureInfo.InvariantCulture)
            : n.Value.ToString(CultureInfo.InvariantCulture),
        Bool b => b.Value ? "true" : "false",
        Text t => t.Value,
        EnumMember e => e.Member,
        List l => "[" + string.Join(", ", l.Items.Select(i => i.Display())) + "]",
        Record r => "{" + string.Join(", ", r.Fields.Select(f => $"{f.Key}: {f.Value.Display()}")) + "}",
        Absent => "∅",
        Instant => "now",
        Unknown => "?",
        _ => "?"
    };
}

/// <summary>The outcome of a precondition / invariant check.</summary>
internal enum CheckOutcome
{
    /// <summary>The condition evaluated to true.</summary>
    Passed,

    /// <summary>The condition evaluated to false.</summary>
    Failed,

    /// <summary>The condition could not be evaluated (an unmodelled expression or missing binding).</summary>
    Indeterminate
}

/// <summary>One entry of the <c>command → events → invariant-checks</c> timeline.</summary>
internal abstract record ScenarioStep
{
    /// <summary>A stable discriminator for serialization (<c>requires</c>/<c>transition</c>/<c>emit</c>/<c>result</c>).</summary>
    public abstract string Kind { get; }

    /// <summary>A <c>requires</c> precondition check, with its outcome.</summary>
    public sealed record Precondition(string? Message, string Condition, CheckOutcome Outcome) : ScenarioStep
    {
        public override string Kind => "requires";
    }

    /// <summary>
    /// A field write: <c>Field -&gt; To</c> (a <c>->/transition</c>) or, for a factory,
    /// <c>Field &lt;- To</c> (an initialization, <see cref="From"/> is <c>null</c>).
    /// </summary>
    public sealed record Transition(string Field, string? From, string To, bool IsInitialization) : ScenarioStep
    {
        public override string Kind => "transition";
    }

    /// <summary>An emitted domain event with its evaluated payload.</summary>
    public sealed record Emit(string EventName, IReadOnlyDictionary<string, string> Args) : ScenarioStep
    {
        public override string Kind => "emit";
    }

    /// <summary>A command's <c>result</c> value.</summary>
    public sealed record Result(string Value) : ScenarioStep
    {
        public override string Kind => "result";
    }
}

/// <summary>The outcome of one invariant, evaluated against the post-command state.</summary>
internal sealed record InvariantCheck(string? Message, string Condition, CheckOutcome Outcome);

/// <summary>
/// The result of running a <see cref="Scenario"/>: did the command complete
/// (<paramref name="Ok"/>), the ordered <paramref name="Steps"/> timeline, the
/// resulting aggregate-root state, the post-command invariant outcomes, an
/// optional command <paramref name="Result"/>, and any evaluation
/// <paramref name="Notes"/> (gaps surfaced rather than hidden).
/// </summary>
internal sealed record ScenarioResult(
    bool Ok,
    string Target,
    string Operation,
    IReadOnlyList<ScenarioStep> Steps,
    IReadOnlyDictionary<string, string> ResultingState,
    IReadOnlyList<InvariantCheck> Invariants,
    string? Result,
    IReadOnlyList<string> Notes);
