using System.Text;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The runtime-support slice of <see cref="CSharpEmitter"/>: the once-emitted base
/// types every generated model shares (DomainInvariantViolationException, ValueObject,
/// IAggregateRoot, the event markers, ConcurrencyConflictException, Range&lt;T&gt;).
/// Split out as a partial to keep the orchestrating emitter focused; these files live
/// in the Koine.Runtime namespace and never reference user types.
/// </summary>
public sealed partial class CSharpEmitter
{
    // ----------------------------------------------------------------------
    // Runtime support
    // ----------------------------------------------------------------------

    private const string RuntimeNamespace = "Koine.Runtime";

    private EmittedFile EmitRuntimeException(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Thrown when a domain invariant or illegal state transition is violated.</summary>\n");
        sb.Append("public sealed class DomainInvariantViolationException : Exception\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public string TypeName { get; }\n");
        sb.Append(Indent).Append("public string Rule { get; }\n\n");
        sb.Append(Indent).Append("public DomainInvariantViolationException(string type, string rule)\n");
        sb.Append(Indent).Append(Indent)
          .Append(": base($\"Invariant violated on {type}: {rule}\") { TypeName = type; Rule = rule; }\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/DomainInvariantViolationException.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    private EmittedFile EmitAggregateRootInterface(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Marks an entity as the consistency boundary (root) of an aggregate.</summary>\n");
        sb.Append("public interface IAggregateRoot { }\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IAggregateRoot.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    private EmittedFile EmitDomainEventInterface(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>A fact that happened in the domain, recorded by an aggregate.</summary>\n");
        sb.Append("public interface IDomainEvent\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("DateTimeOffset OccurredOn { get; }\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IDomainEvent.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>Emits the <c>IIntegrationEvent</c> published-language marker once into Koine.Runtime (R14.3).</summary>
    private EmittedFile EmitIntegrationEventInterface(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>A stable, cross-boundary published-language contract between bounded contexts.</summary>\n");
        sb.Append("public interface IIntegrationEvent\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("DateTimeOffset OccurredOn { get; }\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IIntegrationEvent.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the optimistic-concurrency exception (R11.4) once into Koine.Runtime,
    /// mirroring <see cref="EmitRuntimeException"/>. A repository's update/remove
    /// contract throws it when a versioned aggregate is saved against a stale version.
    /// </summary>
    private EmittedFile EmitConcurrencyConflictException(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Thrown when a versioned aggregate is saved against a stale expected version.</summary>\n");
        sb.Append("public sealed class ConcurrencyConflictException : Exception\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public string TypeName { get; }\n");
        sb.Append(Indent).Append("public int ExpectedVersion { get; }\n");
        sb.Append(Indent).Append("public int ActualVersion { get; }\n\n");
        sb.Append(Indent).Append("public ConcurrencyConflictException(string type, int expected, int actual)\n");
        sb.Append(Indent).Append(Indent)
          .Append(": base($\"Concurrency conflict on {type}: expected version {expected}, found {actual}.\")\n");
        sb.Append(Indent).Append("{ TypeName = type; ExpectedVersion = expected; ActualVersion = actual; }\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/ConcurrencyConflictException.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the generic <c>Range&lt;T&gt;</c> value object once into Koine.Runtime: a
    /// closed interval over an orderable <c>T</c> with a <c>start &lt;= end</c> construction
    /// invariant, <c>Contains</c>/<c>Overlaps</c>, and structural equality.
    /// </summary>
    private EmittedFile EmitRange(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>A closed interval [Start, End] over an orderable type, with containment and overlap.</summary>\n");
        sb.Append("public sealed class Range<T> : IEquatable<Range<T>> where T : IComparable<T>\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public T Start { get; }\n");
        sb.Append(Indent).Append("public T End { get; }\n\n");
        sb.Append(Indent).Append("public Range(T start, T end)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("if (!(start.CompareTo(end) <= 0))\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: \"Range\",\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("rule: \"start must be less than or equal to end\");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("Start = start;\n");
        sb.Append(Indent).Append(Indent).Append("End = end;\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("/// <summary>True when value lies within [Start, End] inclusive.</summary>\n");
        sb.Append(Indent).Append("public bool Contains(T value)\n");
        sb.Append(Indent).Append(Indent).Append("=> value.CompareTo(Start) >= 0 && value.CompareTo(End) <= 0;\n\n");
        sb.Append(Indent).Append("/// <summary>True when this range shares at least one point with other.</summary>\n");
        sb.Append(Indent).Append("public bool Overlaps(Range<T> other)\n");
        sb.Append(Indent).Append(Indent).Append("=> Start.CompareTo(other.End) <= 0 && other.Start.CompareTo(End) <= 0;\n\n");
        sb.Append(Indent).Append("public bool Equals(Range<T>? other)\n");
        sb.Append(Indent).Append(Indent).Append("=> other is not null\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("&& EqualityComparer<T>.Default.Equals(Start, other.Start)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("&& EqualityComparer<T>.Default.Equals(End, other.End);\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append(Indent).Append("=> Equals(obj as Range<T>);\n");
        sb.Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append(Indent).Append("=> HashCode.Combine(Start, End);\n");
        sb.Append(Indent).Append("public static bool operator ==(Range<T>? left, Range<T>? right)\n");
        sb.Append(Indent).Append(Indent).Append("=> left is null ? right is null : left.Equals(right);\n");
        sb.Append(Indent).Append("public static bool operator !=(Range<T>? left, Range<T>? right)\n");
        sb.Append(Indent).Append(Indent).Append("=> !(left == right);\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/Range.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the canonical DDD <c>ValueObject</c> base class: structural equality
    /// driven by each derived type's <c>GetEqualityComponents()</c>. Value objects
    /// are immutable classes (not records) so every instance is funneled through a
    /// guarded constructor and can never exist in an invalid state.
    /// </summary>
    private EmittedFile EmitValueObjectBase(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Base class for value objects: equality by component value, not reference.</summary>\n");
        sb.Append("public abstract class ValueObject\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("/// <summary>The values that define this value object's identity, in order.</summary>\n");
        sb.Append(Indent).Append("protected abstract IEnumerable<object?> GetEqualityComponents();\n\n");
        sb.Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("if (obj is null || obj.GetType() != GetType())\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return false;\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("return GetEqualityComponents().SequenceEqual(((ValueObject)obj).GetEqualityComponents());\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("var hash = new HashCode();\n");
        sb.Append(Indent).Append(Indent).Append("foreach (var component in GetEqualityComponents())\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("hash.Add(component);\n");
        sb.Append(Indent).Append(Indent).Append("return hash.ToHashCode();\n");
        sb.Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append("public static bool operator ==(ValueObject? left, ValueObject? right)\n");
        sb.Append(Indent).Append(Indent).Append("=> left is null ? right is null : left.Equals(right);\n\n");
        sb.Append(Indent).Append("public static bool operator !=(ValueObject? left, ValueObject? right)\n");
        sb.Append(Indent).Append(Indent).Append("=> !(left == right);\n\n");
        // Collection-typed fields must contribute by their CONTENT, not the wrapper
        // reference. Lists compare order-sensitively; sets and maps order-insensitively.
        sb.Append(Indent).Append("/// <summary>Wraps an ordered collection (list) as a by-element equality component.</summary>\n");
        sb.Append(Indent).Append("protected static object? Ordered(System.Collections.IEnumerable? items)\n");
        sb.Append(Indent).Append(Indent).Append("=> items is null ? null : new SequenceComponent(items, ordered: true);\n\n");
        sb.Append(Indent).Append("/// <summary>Wraps an unordered collection (set/map) as a by-element equality component.</summary>\n");
        sb.Append(Indent).Append("protected static object? Unordered(System.Collections.IEnumerable? items)\n");
        sb.Append(Indent).Append(Indent).Append("=> items is null ? null : new SequenceComponent(items, ordered: false);\n\n");
        sb.Append(Indent).Append("private sealed class SequenceComponent\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("private readonly List<object?> _items = new();\n");
        sb.Append(Indent).Append(Indent).Append("private readonly bool _ordered;\n\n");
        sb.Append(Indent).Append(Indent).Append("public SequenceComponent(System.Collections.IEnumerable items, bool ordered)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("_ordered = ordered;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in items) _items.Add(item);\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("public override bool Equals(object? obj)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (obj is not SequenceComponent other || _items.Count != other._items.Count)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return false;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return _ordered\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("? _items.SequenceEqual(other._items)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append(": _items.All(x => _items.Count(i => Equals(i, x)) == other._items.Count(i => Equals(i, x)));\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("public override int GetHashCode()\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (_ordered)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("var hash = new HashCode();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in _items) hash.Add(item);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return hash.ToHashCode();\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var acc = 0;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("foreach (var item in _items) acc ^= item?.GetHashCode() ?? 0;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return acc;\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/ValueObject.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: true));
    }
}
