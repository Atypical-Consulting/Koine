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
public sealed record DiagramNode(string Id, string Label, string Kind, string QualifiedName, SourceSpan? Span);

/// <summary>
/// A directed edge between two <see cref="DiagramNode"/>s. <see cref="From"/> and <see cref="To"/> are
/// node <see cref="DiagramNode.Id"/>s that exist in the same <see cref="DiagramGraph"/>.
/// </summary>
/// <param name="From">The source node id.</param>
/// <param name="To">The target node id.</param>
/// <param name="Label">An optional edge label (transition guard, relation kind, publish/subscribe verb).</param>
public sealed record DiagramEdge(string From, string To, string? Label);

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
