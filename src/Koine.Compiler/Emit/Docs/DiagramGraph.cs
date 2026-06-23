using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Docs;

/// <summary>
/// A single node of a structured diagram: the source-aware counterpart of a Mermaid shape.
/// Carries the qualified name and the most precise <see cref="SourceSpan"/> the AST offers, so an
/// interactive renderer (Koine Studio, issue #93) can style by <see cref="Kind"/> and jump to source.
/// TARGET-AGNOSTIC, but documentation-shaped: lives under <c>Emit/Docs</c>, never in <c>Ast/</c>.
/// </summary>
/// <param name="Id">Stable identifier, unique within the owning <see cref="DiagramGraph"/>.</param>
/// <param name="Label">The display text shown on the diagram (the human-readable name).</param>
/// <param name="Kind">A stable lowercase category string the frontend styles by (see <c>DocsEmitter</c>).</param>
/// <param name="QualifiedName">A dotted, stable name, e.g. <c>"Context.Type"</c> or <c>"Context.Type.Member"</c>.</param>
/// <param name="Span">
/// The most precise source span for the construct, or <c>null</c> only when none exists. The emitter
/// never leaves this null: when a node has no own position it falls back to the owning declaration.
/// </param>
/// <param name="Stereotype">
/// The UML stereotype for a class node WITHOUT guillemets (e.g. <c>"aggregate root"</c>,
/// <c>"value object"</c>, <c>"quantity"</c>, <c>"enumeration"</c>, <c>"event"</c>, <c>"entity"</c>);
/// <c>null</c> for non-class nodes (state, context, integration-event flow), which stay simple boxes.
/// </param>
/// <param name="Members">
/// The ordered display rows for a class node (attributes, methods, enum values), or <c>null</c>/empty
/// for non-class nodes. Mirrors the Mermaid class body content (same skip-derived rule, same order).
/// </param>
/// <param name="Invariants">
/// The construct's business rules as readable strings — each invariant's declared message, else its
/// described condition (matching the narrative docs' "Business rules" list) — for value objects and
/// entities; <c>null</c> when the node carries none. Kept on a dedicated field (NOT in
/// <see cref="Members"/>) so the rendered Mermaid class boxes are unaffected.
/// </param>
public sealed record DiagramNode(
    string Id, string Label, string Kind, string QualifiedName, SourceSpan? Span,
    string? Stereotype = null,
    IReadOnlyList<DiagramMember>? Members = null,
    IReadOnlyList<string>? Invariants = null);

/// <summary>
/// One display row inside a class node's body: a formatted <see cref="Text"/> string and its
/// <see cref="Kind"/> compartment — <c>"field"</c> (attributes, incl. id/version), <c>"method"</c>
/// (commands/factories), or <c>"value"</c> (enum members). The renderer draws attributes and values in
/// the first compartment and methods (when present) in a second one beneath a divider.
/// </summary>
/// <param name="Text">The pre-formatted row text (e.g. <c>id: OrderId</c>, <c>submit()</c>, <c>Draft</c>).</param>
/// <param name="Kind">The compartment: <c>"field"</c>, <c>"method"</c>, or <c>"value"</c>.</param>
public sealed record DiagramMember(string Text, string Kind);

/// <summary>
/// A directed edge between two <see cref="DiagramNode"/>s. <see cref="From"/> and <see cref="To"/> are
/// node <see cref="DiagramNode.Id"/>s that exist in the same <see cref="DiagramGraph"/>.
/// </summary>
/// <param name="From">The source node id.</param>
/// <param name="To">The target node id.</param>
/// <param name="Label">An optional edge label (transition guard, relation kind, publish/subscribe verb).</param>
/// <param name="Cardinality">
/// The TARGET-end multiplicity of a composition, derived from the Koine field type that references the
/// target: a collection (<c>List&lt;X&gt;</c>, <c>Set&lt;X&gt;</c>, <c>Map&lt;K,X&gt;</c>) → <c>"*"</c>,
/// an optional (<c>X?</c>) → <c>"0..1"</c>, a plain reference → <c>"1"</c>; <c>null</c> when the edge is
/// not a field-backed composition (state-machine transitions, context-map / integration-event edges).
/// </param>
/// <param name="SourceCardinality">
/// The SOURCE-end (owner) multiplicity of a composition — conventionally <c>"1"</c> (a part has exactly
/// one owner); <c>null</c> for non-composition edges. Lets the renderer label both ends of an edge.
/// </param>
/// <param name="ArrowKind">
/// The relationship style the renderer maps to a marker pair: <c>"composition"</c> (filled diamond at
/// the owner end + arrow at the part end), <c>"association"</c>, <c>"transition"</c> (state machine),
/// <c>"flow"</c> (integration publish/consume); <c>null</c> falls back to a plain target arrow.
/// </param>
/// <param name="BackingMember">
/// For a field-backed composition, the qualified name of the field that backs the edge
/// (e.g. <c>"Ordering.Order.lines"</c>), so an editor can disconnect the edge by removing that field;
/// <c>null</c> when the edge is not field-backed.
/// </param>
public sealed record DiagramEdge(
    string From, string To, string? Label, string? Cardinality = null,
    string? SourceCardinality = null, string? ArrowKind = null, string? BackingMember = null);

/// <summary>
/// The structured graph behind one diagram: its nodes and edges, in stable declaration order. The
/// Mermaid markdown remains the rendered view; this is the source-aware model an interactive renderer
/// drives. Every edge's endpoints reference a node in <see cref="Nodes"/>.
/// </summary>
public sealed record DiagramGraph(IReadOnlyList<DiagramNode> Nodes, IReadOnlyList<DiagramEdge> Edges);

/// <summary>
/// One diagram as the docs/diagram path returns it: the rendered <see cref="Mermaid"/> snippet plus the
/// structured <see cref="Graph"/> that rides alongside it. <see cref="Kind"/> names the diagram family
/// (state machine, aggregate, context map, integration events); <see cref="Caption"/> is the heading
/// the diagram appears under. Task 2 (issue #93) attaches these to each file's wire payload.
/// </summary>
/// <param name="Caption">The human-readable caption (e.g. the aggregate or context name).</param>
/// <param name="Kind">The diagram family: <c>"statemachine"</c>, <c>"aggregate"</c>, <c>"contextmap"</c>, <c>"integration-events"</c>.</param>
/// <param name="Mermaid">The exact Mermaid snippet embedded in the emitted Markdown for this diagram.</param>
/// <param name="Graph">The structured, source-aware graph for the same diagram.</param>
public sealed record DiagramDescriptor(string Caption, string Kind, string Mermaid, DiagramGraph Graph);
