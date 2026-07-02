namespace Koine.Compiler;

/// <summary>
/// Derives the <c>using</c> directives a generated file needs from the runtime/BCL types
/// it references plus its cross-namespace user-type references. The runtime/BCL knowledge
/// is expressed as a structured table (marker token -&gt; owning namespace) rather than a
/// chain of inline conditions, so "type X lives in namespace Y" is data, not control flow.
///
/// <para>Collection order matters: namespaces are emitted in first-added order before the
/// final stable sort, so the table preserves the original ordering of the previous
/// hand-rolled derivation to keep generated output byte-identical.</para>
/// </summary>
internal sealed class UsingCollector
{
    /// <summary>
    /// One BCL/runtime namespace and the marker tokens whose presence in a file body
    /// requires it. A token is a literal substring (e.g. <c>"IReadOnlyList&lt;"</c>);
    /// any one match pulls in the namespace.
    /// </summary>
    private readonly record struct NamespaceMarkers(string Namespace, string[] Tokens);

    // The fixed BCL/runtime namespaces, in the order they must be considered (and thus the
    // order added before the final sort). Mirrors the previous inline Need(...) sequence.
    private static readonly NamespaceMarkers[] FixedNamespaces =
    {
        new("System", new[]
        {
            "Guid", "DateTimeOffset", "TimeSpan", "IEquatable", "new HashCode(", "HashCode.Combine",
            "IComparable", ": Exception", "ArgumentOutOfRangeException", "ArgumentNullException",
            "InvalidOperationException", "[Obsolete("
        }),
        new("System.Collections.Generic", new[]
        {
            "IEnumerable<", "IReadOnlyList<", "List<", "IReadOnlySet<", "HashSet<",
            "IReadOnlyDictionary<", "Dictionary<", "EqualityComparer<"
        }),
        // Read-only collection wrappers exposed by entity/VO constructors (ReadOnlySet<T>,
        // ReadOnlyDictionary<K,V>). Lists use List<T>.AsReadOnly(), which needs no extra using.
        new("System.Collections.ObjectModel", new[] { "new ReadOnlySet<", "new ReadOnlyDictionary<" }),
        // Repository contracts (R11.2/3) are async and take a CancellationToken.
        new("System.Threading.Tasks", new[] { "Task" }),
        new("System.Threading", new[] { "CancellationToken" }),
        new("System.Text.RegularExpressions", new[] { "Regex" }),
    };

    // Koine.Runtime is gated both on presence of a runtime marker AND on the file not being
    // a runtime file itself; kept separate so the namespace exclusion stays explicit.
    private const string RuntimeNamespace = "Koine.Runtime";
    private static readonly string[] RuntimeMarkers =
    {
        "ValueObject", "IAggregateRoot", "IDomainEvent", "IIntegrationEvent",
        "DomainInvariantViolationException", "Range<"
    };

    private readonly List<string> _usings = new();

    private void Add(string ns)
    {
        if (!_usings.Contains(ns))
        {
            _usings.Add(ns);
        }
    }

    /// <summary>
    /// Adds an explicit namespace the body needs but that the marker/user-type scans cannot derive —
    /// e.g. the opt-in Application layer's third-party imports (FluentValidation, MediatR,
    /// Microsoft.Extensions.DependencyInjection; issue #129) or the Infrastructure layer's EF Core / DI
    /// namespaces (issue #128). De-duplicated and sorted with the rest.
    /// </summary>
    public void AddNamespace(string ns) => Add(ns);

    /// <summary>
    /// Adds every namespace whose runtime/BCL markers appear in <paramref name="body"/>.
    /// <paramref name="usesLinq"/> is passed in (not scanned) because <c>.Count</c> (a
    /// property) and <c>.Count()</c> (a LINQ call) are indistinguishable by a token scan.
    /// </summary>
    public void CollectRuntimeNamespaces(string ns, string body, bool usesLinq)
    {
        // Preserve the original ordering: System, System.Collections.Generic,
        // System.Collections.ObjectModel, [System.Linq], System.Threading.Tasks, ...
        AddIfReferenced(body, FixedNamespaces[0]); // System
        AddIfReferenced(body, FixedNamespaces[1]); // System.Collections.Generic
        AddIfReferenced(body, FixedNamespaces[2]); // System.Collections.ObjectModel
        if (usesLinq)
        {
            Add("System.Linq");
        }

        AddIfReferenced(body, FixedNamespaces[3]); // System.Threading.Tasks
        AddIfReferenced(body, FixedNamespaces[4]); // System.Threading
        AddIfReferenced(body, FixedNamespaces[5]); // System.Text.RegularExpressions

        if (ns != RuntimeNamespace && ReferencesAny(body, RuntimeMarkers))
        {
            Add(RuntimeNamespace);
        }
    }

    /// <summary>
    /// Adds a precise <c>using</c> for each cross-namespace user type the body references
    /// unqualified (other contexts via imports, other modules of the same context — R13.2/R13.3).
    /// Each candidate is the type's simple name paired with the namespace it actually emits into.
    /// </summary>
    public void CollectUserTypeNamespaces(string ns, string body, IEnumerable<KeyValuePair<string, string>> visibleTypes)
    {
        foreach (var (name, typeNs) in visibleTypes)
        {
            if (typeNs != ns && ContainsWord(body, name))
            {
                Add(typeNs);
            }
        }
    }

    /// <summary>The collected namespaces, sorted with System/System.* first, then ordinal.</summary>
    public IReadOnlyList<string> ToSortedUsings() =>
        _usings.OrderBy(UsingSortKey, StringComparer.Ordinal).ThenBy(u => u, StringComparer.Ordinal).ToList();

    public int Count => _usings.Count;

    private void AddIfReferenced(string body, NamespaceMarkers entry)
    {
        if (ReferencesAny(body, entry.Tokens))
        {
            Add(entry.Namespace);
        }
    }

    private static bool ReferencesAny(string body, string[] tokens)
    {
        foreach (var t in tokens)
        {
            if (body.Contains(t, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>True when <paramref name="word"/> appears in <paramref name="text"/> as a whole identifier (not a substring).</summary>
    private static bool ContainsWord(string text, string word)
    {
        var i = 0;
        while ((i = text.IndexOf(word, i, StringComparison.Ordinal)) >= 0)
        {
            var before = i == 0 || !IsIdentChar(text[i - 1]);
            var afterIdx = i + word.Length;
            var after = afterIdx >= text.Length || !IsIdentChar(text[afterIdx]);
            if (before && after)
            {
                return true;
            }

            i = afterIdx;
        }
        return false;
    }

    private static bool IsIdentChar(char c) => char.IsLetterOrDigit(c) || c == '_';

    // System and System.* sort before everything else, mirroring the default
    // "System directives first" using-ordering.
    private static string UsingSortKey(string ns) =>
        ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal) ? "0" + ns : "1" + ns;
}
