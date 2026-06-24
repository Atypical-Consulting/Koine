using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Services;

/// <summary>
/// A single, scoped <b>structural edit</b> against the compiled model (#91), the input to
/// <see cref="ModelRoundTripService.EmitKoine"/> / <see cref="ModelRoundTripService.ApplyEdit"/>.
/// Edits are expressed structurally (never as free-form text) so the seam can validate them and stay
/// symmetric across the desktop LSP and the browser WASM host.
///
/// <para>It is a flat, <see cref="Kind"/>-discriminated record rather than a polymorphic hierarchy
/// deliberately: a flat shape (de)serialises identically and trivially across C#, the WASM
/// source-gen JSON context, and the TypeScript client — serving the non-negotiable <b>dual-backend
/// parity</b> constraint — and stays additive (new kinds reuse the same fields). Target-agnostic;
/// lives in <c>Services/</c>, not <c>Ast/</c>.</para>
/// </summary>
/// <param name="Kind">One of <see cref="StructuredEditKind"/>.</param>
/// <param name="Target">The qualified name the edit applies to: the member for a rename/remove/
/// type-change (<c>Ordering.Money.amount</c>), the owning type for an add-field
/// (<c>Ordering.Money</c>), or the state machine for an add-transition
/// (<c>Ordering.Order.Order.states.status</c>).</param>
/// <param name="Name">The new name (rename), the new field's name (add-field), or the transition's
/// <c>from</c> state (add-transition); <c>null</c> when not applicable.</param>
/// <param name="Type">The field's type (add-field / change-field-type) or the transition's <c>to</c>
/// state (add-transition), in canonical <c>.koi</c> syntax; <c>null</c> when not applicable.</param>
/// <param name="Value">Reserved for future kinds (e.g. an initializer or guard); <c>null</c> today.</param>
public sealed record StructuredEdit(
    string Kind,
    string Target,
    string? Name = null,
    string? Type = null,
    string? Value = null);

/// <summary>The <see cref="StructuredEdit.Kind"/> discriminators, shared verbatim across all backends.</summary>
public static class StructuredEditKind
{
    /// <summary>Rename a member (a field or enum member): <c>Target</c> = member qname, <c>Name</c> = new name.</summary>
    public const string RenameMember = "renameMember";

    /// <summary>Add a field to a value/entity/event: <c>Target</c> = owning type qname, <c>Name</c>/<c>Type</c> set.</summary>
    public const string AddField = "addField";

    /// <summary>Remove a field: <c>Target</c> = member qname.</summary>
    public const string RemoveMember = "removeMember";

    /// <summary>Change a field's type: <c>Target</c> = field qname, <c>Type</c> = new type.</summary>
    public const string ChangeFieldType = "changeFieldType";

    /// <summary>Add a state-machine transition: <c>Target</c> = states qname, <c>Name</c> = from, <c>Type</c> = to.</summary>
    public const string AddTransition = "addTransition";

    /// <summary>
    /// Add a new type to a context: <c>Target</c> = the context name, <c>Name</c> = the new type's name,
    /// <c>Type</c> = the construct kind (<c>value</c> | <c>entity</c> | <c>aggregate</c> | <c>event</c> |
    /// <c>enum</c> | <c>service</c>; <c>null</c> ⇒ <c>value</c>). Inserts a minimal, valid skeleton the author
    /// then refines (an aggregate nests its own root entity, a service a placeholder use-case, so each is
    /// self-contained); an illegal name (duplicate / not an identifier) is rejected by re-validation.
    /// </summary>
    public const string AddType = "addType";

    /// <summary>
    /// Add a nested member to an <b>aggregate</b> (not a context): <c>Target</c> = the aggregate's
    /// qualified name, <c>Type</c> = the member kind (<c>repository</c> | <c>rule</c>), <c>Name</c> =
    /// the member's name (the <c>spec</c> name for <c>rule</c>; ignored for the anonymous
    /// <c>repository</c> block). Inserts a minimal, re-validating skeleton as the aggregate's last
    /// member — a <c>repository { operations: add, getById }</c>, or a <c>rule</c> as an
    /// aggregate-scoped <c>spec &lt;Name&gt; on &lt;Root&gt; = true</c>. A second repository is refused
    /// (an aggregate holds at most one); a rule whose name duplicates a sibling spec/member is rejected
    /// by re-validation. A broken model is never produced.
    /// </summary>
    public const string AddAggregateMember = "addAggregateMember";

    /// <summary>Remove a whole type declaration: <c>Target</c> = the type's qname. Rejected (with a
    /// <c>KOIxxxx</c>) when the type is still referenced, so a dangling model can never be produced.</summary>
    public const string RemoveType = "removeType";
}

/// <summary>
/// The result of <see cref="ModelRoundTripService.EmitKoine"/>: the canonical <c>.koi</c> for the
/// affected declaration when the edit is legal, or the <c>KOIxxxx</c> diagnostics that rejected it
/// (with <see cref="Koine"/> <c>null</c>). Never returns broken <c>.koi</c>.
/// </summary>
/// <param name="Koine">The re-emitted declaration's canonical <c>.koi</c>, or <c>null</c> when the
/// edit is illegal or cannot be applied.</param>
/// <param name="Diagnostics">The diagnostics that rejected the edit; empty on success.</param>
public sealed record EmitResult(
    string? Koine,
    IReadOnlyList<Diagnostic> Diagnostics);

/// <summary>
/// The result of <see cref="ModelRoundTripService.ApplyEdit"/>: a span-minimal patch over just the
/// touched declaration, ready for the editor to apply to its buffer.
/// </summary>
/// <param name="Uri">The file that owns the edited declaration (so the client patches the right
/// document), or <c>null</c> when the edit could not be resolved.</param>
/// <param name="Edits">The text edits to apply — one whole-declaration replacement — or empty when the
/// edit is illegal/unresolved.</param>
/// <param name="Diagnostics">The diagnostics that rejected the edit; empty on success.</param>
public sealed record ModelEditResult(
    string? Uri,
    IReadOnlyList<TextEditModel> Edits,
    IReadOnlyList<Diagnostic> Diagnostics);
