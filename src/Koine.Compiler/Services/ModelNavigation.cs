using Koine.Compiler.Ast;

namespace Koine.Compiler.Services;

/// <summary>
/// Small model-navigation helpers shared across the code-action / refactoring services, replacing
/// copies that had begun to diverge: the field-bearing-member projection (<see cref="MembersOf"/>) and
/// the placeholder name uniquifier (<see cref="UniqueName"/>). Pure model reads — no target concept,
/// so they stay target-agnostic.
/// </summary>
internal static class ModelNavigation
{
    /// <summary>
    /// The field members of <paramref name="type"/> — for the kinds that carry a <c>Members</c> list
    /// (value object, entity, event, integration event) — or an empty list for any kind that carries
    /// none (enum, aggregate, …). Never returns <c>null</c>, so callers iterate uniformly.
    /// </summary>
    public static IReadOnlyList<Member> MembersOf(this TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => [],
    };

    /// <summary>
    /// The field members of <paramref name="type"/> — for the kinds that carry a <c>Members</c> list
    /// (value object, entity, event, integration event) — or <c>null</c> for any kind that carries none
    /// (enum, aggregate, …). Unlike <see cref="MembersOf"/>, this distinguishes <em>absence</em> (a
    /// non-field-bearing kind ⇒ <c>null</c>) from an <em>empty</em> field list, so callers can branch on
    /// "this kind has no fields at all" rather than iterate uniformly.
    /// </summary>
    public static IReadOnlyList<Member>? MembersOfOrNull(this TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => null,
    };

    /// <summary>
    /// <paramref name="baseName"/> when it is not already in <paramref name="taken"/>, otherwise the
    /// first of <c>baseName2</c>, <c>baseName3</c>, … that is free. One uniquifier policy for both the
    /// extract refactors (where the base name is usually free) and the duplicate-rename quick fix
    /// (where the base name is by definition taken, so the result starts at <c>baseName2</c>).
    /// </summary>
    public static string UniqueName(string baseName, ISet<string> taken)
    {
        if (!taken.Contains(baseName))
        {
            return baseName;
        }

        for (var n = 2; ; n++)
        {
            var candidate = baseName + n;
            if (!taken.Contains(candidate))
            {
                return candidate;
            }
        }
    }
}
