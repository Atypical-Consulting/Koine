using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Services;

/// <summary>Whether a detected change breaks downstream consumers of a published contract.</summary>
public enum CompatibilityImpact { Breaking, NonBreaking }

/// <summary>
/// One difference between a baseline and a current model's published surface (R15.2).
/// Breaking changes carry a stable <see cref="Code"/> (<c>KOI15xx</c>); additive changes
/// are reported with the <c>additive</c> label.
/// </summary>
public sealed record CompatibilityChange(CompatibilityImpact Impact, string Code, string Message);

/// <summary>The outcome of a backward-compatibility check: every change, in deterministic order.</summary>
public sealed record CompatibilityReport(IReadOnlyList<CompatibilityChange> Changes)
{
    /// <summary>True when any change breaks a published contract (the caller should exit non-zero).</summary>
    public bool HasBreakingChanges => Changes.Any(c => c.Impact == CompatibilityImpact.Breaking);
}

/// <summary>
/// Compares a current model against a previously published baseline and flags breaking
/// changes to PUBLISHED surfaces only — integration events, shared-kernel types, and the
/// value objects/enums of an open-host (or published-language) upstream (R15.2). Operates
/// purely on the target-agnostic <see cref="KoineModel"/>, so it is reusable across emitters.
/// Internal (non-published) types are ignored entirely.
/// </summary>
public sealed class CompatibilityChecker
{
    private const string AdditiveLabel = "additive";
    private const string IntegrationEventKind = "integration event";

    /// <summary>Diffs the two models' published surfaces and returns every change.</summary>
    public CompatibilityReport Check(KoineModel baseline, KoineModel current)
    {
        var changes = new List<CompatibilityChange>();
        var baselineSurface = PublishedSurface(baseline);
        var currentSurface = PublishedSurface(current);

        // Compare every baseline-published type against the current model.
        foreach (var (id, bt) in baselineSurface.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            if (!currentSurface.TryGetValue(id, out var ct))
            {
                changes.Add(Breaking(DiagnosticCodes.PublishedTypeRemoved,
                    $"Published {bt.Kind} '{bt.Name}' was removed."));
                continue;
            }

            DiffFields(bt, ct, changes);
        }

        // Anything published only in the current model is purely additive.
        foreach (var (id, ct) in currentSurface.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            if (!baselineSurface.ContainsKey(id))
            {
                changes.Add(NonBreaking($"New published {ct.Kind} '{ct.Name}' was added."));
            }
        }

        return new CompatibilityReport(changes);
    }

    private static void DiffFields(PublishedType baseline, PublishedType current, List<CompatibilityChange> changes)
    {
        int startIndex = changes.Count;
        var currentByName = current.Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
        var baselineByName = baseline.Fields.ToDictionary(f => f.Name, StringComparer.Ordinal);

        var removed = baseline.Fields.Where(f => !currentByName.ContainsKey(f.Name)).ToList();
        var added = current.Fields.Where(f => !baselineByName.ContainsKey(f.Name)).ToList();

        // A removed field paired UNAMBIGUOUSLY with an added field of identical shape and optionality
        // reads as a RENAME — one clearer diagnostic instead of an unrelated remove + add. Only when
        // exactly one removed and one added field share a shape: with several same-shape candidates we
        // cannot tell which is the rename, so we fall back to plain remove/add rather than guess (and
        // risk mis-attributing the rename or mislabeling a genuine new required field). Enum values
        // carry no shape, so they never pair (removing EUR while adding GBP is not a rename).
        var consumedAdded = new HashSet<string>(StringComparer.Ordinal);
        if (!baseline.IsEnum)
        {
            var removedByShape = removed.Where(f => f.Type is not null).GroupBy(ShapeKey).ToList();
            foreach (var group in removedByShape)
            {
                var removedSameShape = group.ToList();
                var addedSameShape = added.Where(f => f.Type is not null && ShapeKey(f) == group.Key).ToList();
                if (removedSameShape.Count != 1 || addedSameShape.Count != 1)
                {
                    continue; // ambiguous (or no) match — not a confident rename
                }

                var bf = removedSameShape[0];
                var cf = addedSameShape[0];
                consumedAdded.Add(cf.Name);
                removed.Remove(bf);
                changes.Add(Breaking(DiagnosticCodes.PublishedMemberRenamed,
                    $"{Member(baseline, bf.Name)} appears renamed to '{cf.Name}'."));
            }
        }

        // Removing a value from a published enum, or a field from a published record, breaks consumers
        // that reference it — distinct codes so a tool can treat the two differently.
        foreach (var bf in removed)
        {
            changes.Add(Breaking(
                baseline.IsEnum ? DiagnosticCodes.PublishedEnumMemberRemoved : DiagnosticCodes.PublishedFieldRemoved,
                $"{Member(baseline, bf.Name)} was removed."));
        }

        // Fields present in both: a type change or an optionality tightening is breaking.
        foreach (var bf in baseline.Fields)
        {
            if (!currentByName.TryGetValue(bf.Name, out var cf))
            {
                continue;
            }

            if (bf.Type is not null && cf.Type is not null && Shape(bf.Type) != Shape(cf.Type))
            {
                changes.Add(Breaking(DiagnosticCodes.PublishedFieldTypeChanged,
                    $"{Member(baseline, bf.Name)} changed type from '{Shape(bf.Type)}' to '{Shape(cf.Type)}'."));
            }
            else if (bf.IsOptional && !cf.IsOptional)
            {
                changes.Add(Breaking(DiagnosticCodes.PublishedFieldNowRequired,
                    $"{Member(baseline, bf.Name)} was optional but is now required."));
            }
        }

        // Added fields not consumed by a rename: a new enum value or optional field is additive; a new
        // required field breaks producers/consumers that build the contract.
        foreach (var cf in added)
        {
            if (consumedAdded.Contains(cf.Name))
            {
                continue;
            }

            if (current.IsEnum || cf.IsOptional)
            {
                changes.Add(NonBreaking($"{Member(current, cf.Name)} was added."));
            }
            else
            {
                changes.Add(Breaking(DiagnosticCodes.PublishedRequiredFieldAdded,
                    $"Required {Member(current, cf.Name)} was added."));
            }
        }

        // An integration event is a wire contract: ANY breaking payload change — a field removed,
        // retyped, required-added, OR renamed — also reports an event-shape change (KOI1517), a single
        // event-level signal a tool can gate on, distinct from the per-field codes. A purely additive
        // change does not break the shape, so only breaking per-field changes trigger it.
        if (baseline.Kind == IntegrationEventKind
            && changes.Skip(startIndex).Any(c => c.Impact == CompatibilityImpact.Breaking))
        {
            changes.Add(Breaking(DiagnosticCodes.PublishedEventShapeChanged,
                $"Published integration event '{baseline.Name}' changed its payload shape."));
        }
    }

    /// <summary>A field's contract shape key (type ignoring nullability, plus optionality) for unambiguous rename pairing.</summary>
    private static string ShapeKey(PublishedField f) => $"{Shape(f.Type!)}|{f.IsOptional}";

    // ------------------------------------------------------------------------
    // Published-surface extraction
    // ------------------------------------------------------------------------

    /// <summary>
    /// The model's published surface, keyed so the same contract maps to the same key across
    /// the two models: integration events and open-host types by <c>Context.Type</c>, shared-kernel
    /// types by name (their contract is the name, owned jointly by the partners).
    /// </summary>
    private static Dictionary<string, PublishedType> PublishedSurface(KoineModel model)
    {
        var result = new Dictionary<string, PublishedType>(StringComparer.Ordinal);
        var relations = model.ContextMap?.Relations ?? Array.Empty<ContextRelation>();

        var sharedNames = relations
            .Where(r => r.Kind == ContextRelationKind.SharedKernel)
            .SelectMany(r => r.SharedTypes)
            .ToHashSet(StringComparer.Ordinal);

        // A context exposes an open-host surface when it is the upstream of an open-host or
        // published-language relation (either endpoint when that relation is bidirectional).
        var openHostContexts = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in relations)
        {
            if (r.Kind is not (ContextRelationKind.OpenHost or ContextRelationKind.PublishedLanguage))
            {
                continue;
            }

            openHostContexts.Add(r.Upstream);
            if (r.IsBidirectional)
            {
                openHostContexts.Add(r.Downstream);
            }
        }

        foreach (var ctx in model.Contexts)
        {
            var isOpenHost = openHostContexts.Contains(ctx.Name);
            foreach (var type in FlattenTypes(ctx.Types))
            {
                if (type is IntegrationEventDecl)
                {
                    result[$"{ctx.Name}.{type.Name}"] = PublishedType.From(IntegrationEventKind, type);
                }
                else if (sharedNames.Contains(type.Name))
                {
                    result[$"shared-kernel:{type.Name}"] = PublishedType.From("shared-kernel", type);
                }
                else if (isOpenHost && type is ValueObjectDecl or EnumDecl)
                {
                    result[$"{ctx.Name}.{type.Name}"] = PublishedType.From("open-host", type);
                }
            }
        }

        return result;
    }

    /// <summary>Every type declared in a context, descending into aggregates' nested types.</summary>
    private static IEnumerable<TypeDecl> FlattenTypes(IEnumerable<TypeDecl> types)
    {
        foreach (var type in types)
        {
            yield return type;
            if (type is AggregateDecl agg)
            {
                foreach (var nested in FlattenTypes(agg.Types))
                {
                    yield return nested;
                }
            }
        }
    }

    /// <summary>A type reference's shape, ignoring nullability and the owning-context qualifier.</summary>
    private static string Shape(TypeRef t) => t switch
    {
        { Value: not null, Element: not null } => $"{t.Name}<{Shape(t.Element)}, {Shape(t.Value)}>",
        { Element: not null } => $"{t.Name}<{Shape(t.Element)}>",
        _ => t.Name
    };

    private static string Member(PublishedType type, string field) =>
        $"{(type.IsEnum ? "value" : "field")} '{field}' of published {type.Kind} '{type.Name}'";

    private static CompatibilityChange Breaking(string code, string message) =>
        new(CompatibilityImpact.Breaking, code, message);

    private static CompatibilityChange NonBreaking(string message) =>
        new(CompatibilityImpact.NonBreaking, AdditiveLabel, message);

    /// <summary>A published field (or enum value): its name, declared type, and optionality.</summary>
    private sealed record PublishedField(string Name, TypeRef? Type, bool IsOptional);

    /// <summary>A published type and the fields/values that make up its contract.</summary>
    private sealed record PublishedType(string Kind, string Name, bool IsEnum, IReadOnlyList<PublishedField> Fields)
    {
        public static PublishedType From(string kind, TypeDecl type) =>
            new(kind, type.Name, type is EnumDecl, FieldsOf(type));

        private static IReadOnlyList<PublishedField> FieldsOf(TypeDecl type) => type switch
        {
            ValueObjectDecl v => v.Members.Select(ToField).ToList(),
            EntityDecl e => e.Members.Select(ToField).ToList(),
            EventDecl ev => ev.Members.Select(ToField).ToList(),
            IntegrationEventDecl ie => ie.Members.Select(ToField).ToList(),
            EnumDecl en => en.MemberNames.Select(n => new PublishedField(n, null, false)).ToList(),
            _ => Array.Empty<PublishedField>()
        };

        private static PublishedField ToField(Member m) => new(m.Name, m.Type, m.Type.IsOptional);
    }
}
