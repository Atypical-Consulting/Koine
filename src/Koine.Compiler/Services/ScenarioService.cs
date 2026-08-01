using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Semantics.Scenarios;

namespace Koine.Compiler.Services;

/// <summary>
/// The LSP/WASM bridge for the scenario runner (#149, <c>koine/runScenario</c>). It maps a JSON
/// request (target, operation, given state, args) onto the target-agnostic
/// <see cref="ScenarioInterpreter"/> and shapes its <see cref="ScenarioResult"/> back into a
/// JSON-ready tree — the single source of truth for the response shape, shared by the stdio LSP
/// host (<c>Koine.Cli</c>) and the browser WASM host (<c>Koine.Wasm</c>).
///
/// <para><see cref="Run"/> returns a <c>Dictionary&lt;string, object?&gt;</c> the non-trimmed CLI
/// serializes directly; <see cref="WriteJson"/> serializes that same tree with a low-level
/// <see cref="Utf8JsonWriter"/> (reflection-free, trim-safe) for the WASM backend.</para>
/// </summary>
public static class ScenarioService
{
    /// <summary>
    /// The <c>mode</c> of a result produced by the target-agnostic <see cref="ScenarioInterpreter"/>
    /// (Approach B): the model is reasoned about, never compiled or run, so a value the interpreter
    /// cannot evaluate shows up as <c>?</c>.
    /// </summary>
    internal const string InterpretedMode = "interpreted";

    /// <summary>
    /// The <c>mode</c> of a result produced by running the model's EMITTED code (Approach A, #236):
    /// every derived value is a real computed value. Only a host that can spawn the sandbox child
    /// (ADR 0011) ever reports it.
    /// </summary>
    internal const string ExecutedMode = "executed";

    /// <summary>
    /// The note a host adds when the caller asked for executed mode but this host cannot execute (the
    /// browser WASM backend has no process to sandbox into). The answer is the interpreter's, labelled
    /// <see cref="InterpretedMode"/> — degraded, and explicitly said so, never silently misread as an
    /// executed run.
    /// </summary>
    internal const string ExecutionUnavailableNote =
        "Execution is not available on this host; the scenario was interpreted instead, so values the "
        + "interpreter cannot evaluate stay indeterminate (?).";

    /// <summary>
    /// Runs the scenario described by the request fields against <paramref name="semantic"/> and
    /// returns the <c>command → events → invariant-checks</c> timeline as a JSON-ready tree.
    /// <paramref name="given"/> and <paramref name="args"/> are JSON objects (field → value); a
    /// non-object is treated as empty.
    /// </summary>
    public static IReadOnlyDictionary<string, object?> Run(
        SemanticModel semantic, string target, string operation, JsonElement given, JsonElement args) =>
        Run(semantic, target, operation, given, args, executionRequested: false);

    /// <summary>
    /// <see cref="Run(SemanticModel, string, string, JsonElement, JsonElement)"/>, for a host that was
    /// asked for executed mode (<c>execute: true</c>) but cannot execute: the result is still the
    /// interpreter's and is labelled <see cref="InterpretedMode"/>, with
    /// <see cref="ExecutionUnavailableNote"/> appended. The degraded answer is the SAME shape as any
    /// other, so the panel renders it normally — and says which engine produced it.
    /// </summary>
    internal static IReadOnlyDictionary<string, object?> Run(
        SemanticModel semantic, string target, string operation, JsonElement given, JsonElement args,
        bool executionRequested)
    {
        var scenario = new Scenario(target, operation, ParseMap(given), ParseMap(args));
        ScenarioResult result = ScenarioInterpreter.Run(semantic, scenario);
        return Shape(result, InterpretedMode, executionRequested ? ExecutionUnavailableNote : null);
    }

    /// <summary>
    /// A not-ok scenario result carrying an explanatory <paramref name="note"/> — the single shape both
    /// hosts return for the failure paths (model has errors, request could not be run), so the wire
    /// shape stays defined in exactly one place. Reported as <see cref="InterpretedMode"/>; the executed
    /// pipeline uses the <see cref="Error(string, string, string, string)"/> overload.
    /// </summary>
    public static IReadOnlyDictionary<string, object?> Error(string target, string operation, string note) =>
        Error(target, operation, note, InterpretedMode);

    /// <summary>
    /// <see cref="Error(string, string, string)"/> for a given <paramref name="mode"/>: an executed run
    /// that failed (timed out, crashed, never started) is still an EXECUTED-mode answer — nothing was
    /// interpreted — so it says so rather than borrowing the interpreter's label.
    ///
    /// <para><paramref name="executionUnavailable"/> appends <see cref="ExecutionUnavailableNote"/>, for a
    /// host that was asked to execute but cannot (the browser WASM backend). Without it an
    /// <c>execute: true</c> request that ALSO failed — a model with errors, say — would lose the one hint
    /// the success path gives: that execution was never on the table on this host.</para>
    /// </summary>
    internal static IReadOnlyDictionary<string, object?> Error(
        string target, string operation, string note, string mode, bool executionUnavailable = false) =>
        new Dictionary<string, object?>
        {
            ["ok"] = false,
            ["target"] = target,
            ["operation"] = operation,
            ["mode"] = mode,
            ["steps"] = Array.Empty<object>(),
            ["resultingState"] = new Dictionary<string, object?>(),
            ["invariants"] = Array.Empty<object>(),
            ["result"] = null,
            ["notes"] = executionUnavailable ? new[] { note, ExecutionUnavailableNote } : new[] { note },
        };

    /// <summary>
    /// The runnable surface of <paramref name="semantic"/>: every entity (aggregate root or standalone)
    /// that exposes at least one command or factory, with its operations (and their parameters) and its
    /// stored fields — what the Studio panel turns into target/operation dropdowns and a given-state /
    /// args scaffold. Shape: <c>{ targets: [ { name, operations: [{ name, kind, params, returns }],
    /// fields: [{ name, type, optional }] } ] }</c>.
    /// </summary>
    public static IReadOnlyDictionary<string, object?> Catalog(SemanticModel semantic)
    {
        var targets = new List<object>();
        foreach (EntityDecl entity in NodeWalker.Descendants(semantic.Model).OfType<EntityDecl>())
        {
            var operations = new List<object>();
            foreach (CommandDecl c in entity.Commands)
            {
                operations.Add(OperationJson(c.Name, "command", c.Parameters, c.ReturnType));
            }

            foreach (FactoryDecl f in entity.Factories)
            {
                operations.Add(OperationJson(f.Name, "factory", f.Parameters, null));
            }

            if (operations.Count == 0)
            {
                continue; // only list entities you can actually run something on
            }

            var memberNames = entity.Members.Select(m => m.Name).ToHashSet(StringComparer.Ordinal);
            var fields = entity.Members
                .Where(m => !MemberAnalysis.IsDerived(m, memberNames))
                .Select(m => (object)new Dictionary<string, object?>
                {
                    ["name"] = m.Name,
                    ["type"] = RenderType(m.Type),
                    ["optional"] = m.Type.IsOptional,
                })
                .ToList();

            targets.Add(new Dictionary<string, object?>
            {
                ["name"] = entity.Name,
                ["operations"] = operations,
                ["fields"] = fields,
            });
        }

        return new Dictionary<string, object?> { ["targets"] = targets };
    }

    /// <summary>Serializes a <see cref="Run"/> result tree to a JSON string (reflection-free; trim-safe).
    /// Uses the same relaxed escaping as the CLI's serializer so both backends emit identical bytes.</summary>
    public static string WriteJson(IReadOnlyDictionary<string, object?> tree)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            WriteValue(writer, tree);
        }

        return Encoding.UTF8.GetString(buffer.WrittenSpan);
    }

    private static object OperationJson(string name, string kind, IReadOnlyList<Param> parameters, TypeRef? returns) =>
        new Dictionary<string, object?>
        {
            ["name"] = name,
            ["kind"] = kind,
            ["params"] = parameters
                .Select(p => (object)new Dictionary<string, object?> { ["name"] = p.Name, ["type"] = RenderType(p.Type) })
                .ToList(),
            ["returns"] = returns is null ? null : RenderType(returns),
        };

    /// <summary>Renders a <see cref="TypeRef"/> to a readable string (e.g. <c>List&lt;OrderLine&gt;</c>,
    /// <c>String?</c>, <c>Context.Type</c>) — matching the renderer the other Studio panels use.</summary>
    private static string RenderType(TypeRef type)
    {
        string head = type.Qualifier is { } q ? $"{q}.{type.Name}" : type.Name;
        string name = type.Element is null
            ? head
            : type.Value is null
                ? $"{head}<{RenderType(type.Element)}>"
                : $"{head}<{RenderType(type.Element)}, {RenderType(type.Value)}>";
        return type.IsOptional ? name + "?" : name;
    }

    // ------------------------------------------------------------------------
    // JSON request -> scenario values
    // ------------------------------------------------------------------------

    /// <summary>
    /// Maps a JSON object (field → value) onto scenario values. <c>internal</c> rather than private
    /// because the sandboxed executed-mode child (<c>koine scenario-exec</c>, ADR 0011) must read a
    /// request's <c>given</c>/<c>args</c> with EXACTLY this mapping — two hand-rolled readers would
    /// let the same JSON mean different things in interpreted and executed mode.
    /// </summary>
    internal static IReadOnlyDictionary<string, ScenarioValue> ParseMap(JsonElement element)
    {
        var map = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal);
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (JsonProperty property in element.EnumerateObject())
            {
                map[property.Name] = ParseValue(property.Value);
            }
        }

        return map;
    }

    private static ScenarioValue ParseValue(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => new ScenarioValue.Record(
            element.EnumerateObject().ToDictionary(p => p.Name, p => ParseValue(p.Value), StringComparer.Ordinal)),
        JsonValueKind.Array => new ScenarioValue.List(element.EnumerateArray().Select(ParseValue).ToList()),
        JsonValueKind.String => new ScenarioValue.Text(element.GetString() ?? ""),
        JsonValueKind.Number => element.TryGetInt64(out long i)
            ? new ScenarioValue.Num(i, IsInteger: true)
            // A number outside decimal range (e.g. 1e309) is not representable; surface it as text
            // rather than throwing, keeping the never-throw contract.
            : element.TryGetDecimal(out decimal d)
                ? new ScenarioValue.Num(d, IsInteger: false)
                : new ScenarioValue.Text(element.GetRawText()),
        JsonValueKind.True => new ScenarioValue.Bool(true),
        JsonValueKind.False => new ScenarioValue.Bool(false),
        _ => new ScenarioValue.Absent()
    };

    // ------------------------------------------------------------------------
    // Scenario result -> JSON-ready tree
    // ------------------------------------------------------------------------

    /// <summary>
    /// Shapes a scenario result into the one JSON-ready tree both hosts return. <c>internal</c> rather
    /// than private because executed mode (#236) produces its result in a child process and shapes it
    /// there (ADR 0011) — the wire shape must stay defined exactly once.
    ///
    /// <para><paramref name="mode"/> (<see cref="InterpretedMode"/> / <see cref="ExecutedMode"/>) names
    /// the engine that actually produced this result, so a client can never mistake an interpreted
    /// answer for an executed one. It is stated by the caller rather than inferred here precisely
    /// because both engines fill the very same <see cref="ScenarioResult"/> contract.
    /// <paramref name="extraNote"/> appends one host-level note (e.g. "this host cannot execute") to the
    /// engine's own.</para>
    /// </summary>
    internal static IReadOnlyDictionary<string, object?> Shape(
        ScenarioResult result, string mode, string? extraNote = null) => new Dictionary<string, object?>
        {
            ["ok"] = result.Ok,
            ["target"] = result.Target,
            ["operation"] = result.Operation,
            ["mode"] = mode,
            ["steps"] = result.Steps.Select(ShapeStep).ToArray(),
            ["resultingState"] = result.ResultingState.ToDictionary(kv => kv.Key, kv => (object?)kv.Value),
            ["invariants"] = result.Invariants.Select(ShapeInvariant).ToArray(),
            ["result"] = result.Result,
            ["notes"] = extraNote is null ? result.Notes.ToArray() : [.. result.Notes, extraNote],
        };

    private static object ShapeStep(ScenarioStep step) => step switch
    {
        ScenarioStep.Precondition p => new Dictionary<string, object?>
        {
            ["kind"] = p.Kind,
            ["message"] = p.Message,
            ["condition"] = p.Condition,
            ["outcome"] = Outcome(p.Outcome),
        },
        ScenarioStep.Transition t => new Dictionary<string, object?>
        {
            ["kind"] = t.Kind,
            ["field"] = t.Field,
            ["from"] = t.From,
            ["to"] = t.To,
            ["isInitialization"] = t.IsInitialization,
        },
        ScenarioStep.Emit e => new Dictionary<string, object?>
        {
            ["kind"] = e.Kind,
            ["event"] = e.EventName,
            ["args"] = e.Args.ToDictionary(kv => kv.Key, kv => (object?)kv.Value),
        },
        ScenarioStep.Result r => new Dictionary<string, object?>
        {
            ["kind"] = r.Kind,
            ["value"] = r.Value,
        },
        _ => new Dictionary<string, object?> { ["kind"] = "unknown" }
    };

    private static IReadOnlyDictionary<string, object?> ShapeInvariant(InvariantCheck check) => new Dictionary<string, object?>
    {
        ["message"] = check.Message,
        ["condition"] = check.Condition,
        ["outcome"] = Outcome(check.Outcome),
    };

    private static string Outcome(CheckOutcome outcome) => outcome switch
    {
        CheckOutcome.Passed => "passed",
        CheckOutcome.Failed => "failed",
        _ => "indeterminate"
    };

    // ------------------------------------------------------------------------
    // Reflection-free JSON writer (trim-safe for the WASM host)
    // ------------------------------------------------------------------------

    private static void WriteValue(Utf8JsonWriter writer, object? value)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case string s:
                writer.WriteStringValue(s);
                break;
            case bool b:
                writer.WriteBooleanValue(b);
                break;
            case int i:
                writer.WriteNumberValue(i);
                break;
            case long l:
                writer.WriteNumberValue(l);
                break;
            case decimal d:
                writer.WriteNumberValue(d);
                break;
            case double dbl:
                writer.WriteNumberValue(dbl);
                break;
            case IReadOnlyDictionary<string, object?> map:
                writer.WriteStartObject();
                foreach (var (key, child) in map)
                {
                    writer.WritePropertyName(key);
                    WriteValue(writer, child);
                }

                writer.WriteEndObject();
                break;
            case System.Collections.IEnumerable seq:
                writer.WriteStartArray();
                foreach (object? item in seq)
                {
                    WriteValue(writer, item);
                }

                writer.WriteEndArray();
                break;
            default:
                writer.WriteStringValue(Convert.ToString(value, CultureInfo.InvariantCulture));
                break;
        }
    }
}
