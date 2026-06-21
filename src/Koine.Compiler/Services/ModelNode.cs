namespace Koine.Compiler.Services;

/// <summary>
/// One node of the structured model contract (#91): a single declaration in the compiled
/// <see cref="Koine.Compiler.Ast.KoineModel"/> — the synthetic <c>model</c> root, a bounded
/// <c>context</c>, an <c>aggregate</c>/<c>entity</c>/<c>value</c>/<c>enum</c>/<c>event</c>, a
/// state machine, or the strategic context map — projected into a stable, target-agnostic shape
/// a Studio visual editor can drive forms and canvases from. Generalises the glossary's
/// <see cref="Koine.Compiler.Emit.Glossary.GlossaryEntry"/> from "descriptions only" to the whole
/// model graph.
///
/// <para><b>Stability contract:</b> this record is the wire shape shared by the desktop LSP
/// (<c>koine/model*</c>) and the browser WASM host. It is <b>additive-only</b> — new fields are
/// appended (consumers tolerate unknown fields), existing fields are never repurposed — so editors
/// built against it keep working as the model grows. Purely target-agnostic: built from the
/// <see cref="Koine.Compiler.Ast.KoineModel"/>, it carries no emitter concept and lives in
/// <c>Services/</c>, not <c>Ast/</c>.</para>
/// </summary>
/// <param name="Kind">The construct kind: <c>model</c>, <c>context</c>, <c>aggregate</c>,
/// <c>entity</c>, <c>value</c>, <c>quantity</c>, <c>enum</c>, <c>event</c>, <c>integration event</c>,
/// <c>states</c>, or <c>contextMap</c> (the type kinds match the glossary doc).</param>
/// <param name="QualifiedName">Stable dotted address from the context (e.g. <c>Ordering.Money</c>, or
/// <c>Sales.Cart.CartLine</c> for an aggregate-nested type); the empty string for the synthetic root.
/// The same id <see cref="ModelRoundTripService"/> resolves edits against.</param>
/// <param name="Title">A short human label for the node (usually its simple name).</param>
/// <param name="Members">The node's editable leaf children — an entity/value's fields, an enum's
/// members, a state machine's transitions, the context map's relations — in declaration order.</param>
/// <param name="Children">The node's nested declarations — a context's types, an aggregate's nested
/// types, an entity's state machines — in declaration order. Empty for a leaf declaration.</param>
public sealed record ModelNode(
    string Kind,
    string QualifiedName,
    string Title,
    IReadOnlyList<ModelMember> Members,
    IReadOnlyList<ModelNode> Children);

/// <summary>
/// One editable leaf of a <see cref="ModelNode"/> (#91): a field, an enum member, a state-machine
/// transition, or a context-map relation, with its kind and current values so an editor can build a
/// form row without re-parsing. Target-agnostic; additive-only (see <see cref="ModelNode"/>).
/// </summary>
/// <param name="Kind">The member kind: <c>field</c>, <c>enumMember</c>, <c>transition</c>, or
/// <c>relation</c>.</param>
/// <param name="Name">The member's simple name (a field/enum-member name, a transition's <c>from</c>
/// state, or a relation's <c>Upstream -&gt; Downstream</c> label).</param>
/// <param name="Type">The member's type rendered in canonical <c>.koi</c> syntax (e.g.
/// <c>List&lt;OrderLine&gt;</c>, <c>Decimal?</c>) for a field; a relation's role; an optional guard for
/// a transition; <c>null</c> when not applicable.</param>
/// <param name="Value">The current value: a field's initializer/derivation, an enum member's
/// associated data, a transition's <c>to</c> states, or relation detail; <c>null</c> when none.</param>
public sealed record ModelMember(
    string Kind,
    string Name,
    string? Type,
    string? Value);
