using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Docs;

/// <summary>
/// Structured-graph slice of <see cref="DocsEmitter"/> (issue #93): alongside the Mermaid-in-Markdown
/// documentation, build a source-aware <see cref="DiagramGraph"/> for every diagram and group the
/// resulting <see cref="DiagramDescriptor"/>s by the docs file they appear in. The Markdown path is
/// untouched (its snapshots stay byte-identical); this walks the same AST a second time so an
/// interactive renderer (Koine Studio) gets nodes carrying qualified names + spans and edges between them.
///
/// <para>Each node is given the <b>most precise</b> span the AST offers, falling back to the owning
/// declaration when the construct itself has no own position (a state name that only appears inside a
/// transition rule, a context that only appears as a relation endpoint). No node is ever left with the
/// <see cref="SourceSpan.None"/> sentinel.</para>
///
/// <para><b>Kind vocabulary</b> (the frontend styles by it):
/// node kinds — <c>"state"</c>, <c>"aggregate-root"</c>, <c>"value-object"</c>, <c>"entity"</c>,
/// <c>"enum"</c>, <c>"event"</c>, <c>"context"</c>, <c>"integration-event"</c>;
/// descriptor (diagram) kinds — <c>"statemachine"</c>, <c>"aggregate"</c>, <c>"contextmap"</c>,
/// <c>"integration-events"</c>.</para>
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>
    /// The structured, source-aware diagram graphs for a model, grouped by the docs
    /// <see cref="EmittedFile.RelativePath"/> they appear in (a context doc embeds its state-machine
    /// and aggregate diagrams; the context map and integration events each have their own file). The
    /// Markdown <see cref="Emit(KoineModel)"/> output is unaffected; the two paths stay in lock-step
    /// because each descriptor carries the exact Mermaid snippet embedded in that file's Markdown.
    /// </summary>
    public IReadOnlyDictionary<string, IReadOnlyList<DiagramDescriptor>> EmitDiagrams(KoineModel model)
    {
        var byFile = new Dictionary<string, List<DiagramDescriptor>>(StringComparer.Ordinal);

        void Add(string relativePath, DiagramDescriptor descriptor)
        {
            if (!byFile.TryGetValue(relativePath, out var list))
            {
                list = new List<DiagramDescriptor>();
                byFile[relativePath] = list;
            }

            list.Add(descriptor);
        }

        // Per-context docs: ONE context class diagram (the whole domain model) + each entity's state
        // machine, in declaration order so the descriptors line up with the diagrams embedded in the
        // narrative document.
        foreach (ContextNode ctx in model.Contexts)
        {
            var path = $"docs/{ctx.Name}.md";

            if (BuildContextDescriptor(ctx) is { } contextDescriptor)
            {
                Add(path, contextDescriptor);
            }

            foreach (AggregateDecl agg in ctx.Types.OfType<AggregateDecl>())
            {
                if (agg.RootEntity() is { } root)
                {
                    foreach (DiagramDescriptor sm in BuildStateMachineDescriptors(ctx, root))
                    {
                        Add(path, sm);
                    }
                }
            }

            // Standalone (non-aggregate) entities still render their own lifecycle state machines.
            foreach (EntityDecl entity in ctx.Types.OfType<EntityDecl>())
            {
                foreach (DiagramDescriptor sm in BuildStateMachineDescriptors(ctx, entity))
                {
                    Add(path, sm);
                }
            }
        }

        // The strategic context map (its own file), only when a map is declared.
        if (model.ContextMap is { Relations.Count: > 0 })
        {
            Add("docs/context-map.md", BuildContextMapDescriptor(model.ContextMap));
        }

        // The cross-context integration-event flow (its own file), only when events exist.
        if (BuildIntegrationEventsDescriptor(model) is { } integration)
        {
            Add("docs/integration-events.md", integration);
        }

        return byFile.ToDictionary(
            kvp => kvp.Key,
            kvp => (IReadOnlyList<DiagramDescriptor>)kvp.Value,
            StringComparer.Ordinal);
    }

    // ---- state machines -----------------------------------------------------

    /// <summary>
    /// One descriptor per state machine on the entity. Nodes are states (the initial pseudo-state and
    /// terminal markers are graph-internal, not source constructs, so they get no node); edges are the
    /// declared transitions. A state name has no own AST position, so each state node falls back to the
    /// owning <see cref="StatesDecl"/> (else the entity) for its span.
    /// </summary>
    private static IReadOnlyList<DiagramDescriptor> BuildStateMachineDescriptors(ContextNode ctx, EntityDecl entity)
    {
        var result = new List<DiagramDescriptor>();
        foreach (StatesDecl states in entity.States)
        {
            SourceSpan owner = PreferName(states, entity);

            var nodes = new List<DiagramNode>();
            var edges = new List<DiagramEdge>();
            var nodeIds = new Dictionary<string, string>(StringComparer.Ordinal);

            string EnsureState(string state)
            {
                var id = Sanitize(state);
                if (nodeIds.TryAdd(id, state))
                {
                    nodes.Add(new DiagramNode(
                        id, state, "state",
                        $"{ctx.Name}.{entity.Name}.{state}", owner));
                }

                return id;
            }

            // Mirror EmitStateDiagram: ensure both endpoints of every rule become nodes (the rules are
            // the authoritative state inventory, including terminal states with no outgoing edges).
            foreach (StateRule rule in states.Rules)
            {
                var fromId = EnsureState(rule.From);
                var label = rule.Guard is not null ? Describe(rule.Guard) : null;
                foreach (string to in rule.To)
                {
                    var toId = EnsureState(to);
                    edges.Add(new DiagramEdge(fromId, toId, label, ArrowKind: "transition"));
                }
            }

            var mermaid = new StringBuilder("```mermaid\n");
            EmitStateDiagram(mermaid, entity, states);
            mermaid.Append("```");

            result.Add(new DiagramDescriptor(
                Caption: entity.Name,
                Kind: "statemachine",
                Mermaid: mermaid.ToString(),
                Graph: new DiagramGraph(nodes, edges)));
        }

        return result;
    }

    // ---- context class diagram ----------------------------------------------

    /// <summary>
    /// The bounded context's class diagram: a node for every drawable type the context declares — its
    /// standalone value objects/enums/entities/events PLUS the types nested in its aggregates (the
    /// aggregate root carries <c>&lt;&lt;aggregate root&gt;&gt;</c>) — and an edge for every field
    /// referencing another in-context type (a composition for an owned part, an association for a by-id
    /// entity reference). Built from the same <see cref="ContextClassModel"/> the
    /// Markdown <see cref="EmitContextClassDiagram"/> walks, so the structured graph and the rendered
    /// diagram never drift. Returns <c>null</c> when the context declares no drawable type.
    /// </summary>
    private static DiagramDescriptor? BuildContextDescriptor(ContextNode ctx)
    {
        var (modelNodes, modelEdges) = ContextClassModel(ctx);
        if (modelNodes.Count == 0)
        {
            return null;
        }

        var nodes = modelNodes
            .Select(n => new DiagramNode(
                n.Type.Name, n.Type.Name, n.Kind, $"{ctx.Name}.{n.Type.Name}",
                PreferName(n.Type, (KoineNode?)n.OwningAggregate ?? ctx),
                Stereotype: n.Stereotype,
                Members: ClassMembers(n.Type, n.OwningAggregate),
                Invariants: NodeInvariants(n.Type),
                // The "When" description rides on event nodes only (issue #170); other kinds stay null.
                Doc: n.Kind == "event" ? NormalizeDoc(n.Type.Doc) : null))
            .ToList();

        var edges = modelEdges
            .Select(e => new DiagramEdge(
                e.From, e.To, null,
                e.Cardinality,
                // The owner-end "1" is the composition diamond's multiplicity; a by-id association has no
                // owner end (it is a reference, not ownership), so it carries only the target multiplicity.
                SourceCardinality: e.ArrowKind == "composition" ? "1" : null,
                ArrowKind: e.ArrowKind,
                BackingMember: e.BackingMember))
            .ToList();

        var mermaid = new StringBuilder();
        EmitContextClassDiagram(mermaid, ctx);
        return new DiagramDescriptor(
            Caption: ctx.Name,
            Kind: "context",
            Mermaid: ExtractMermaidBlock(mermaid.ToString()),
            Graph: new DiagramGraph(nodes, edges));
    }

    /// <summary>True when <paramref name="name"/> appears as a type argument (element/value) anywhere in
    /// the generic tree of <paramref name="t"/> — i.e. the field is a collection/map OF that type.</summary>
    private static bool ReferencesAsTypeArgument(TypeRef t, string name) =>
        (t.Element is { } e && (string.Equals(e.Name, name, StringComparison.Ordinal) || ReferencesAsTypeArgument(e, name)))
        || (t.Value is { } v && (string.Equals(v.Name, name, StringComparison.Ordinal) || ReferencesAsTypeArgument(v, name)));

    /// <summary>The node kind a nested type draws as, or <c>null</c> when it is not in the structure diagram.</summary>
    private static string? NestedKind(TypeDecl nested) => nested switch
    {
        ValueObjectDecl => "value-object",
        EnumDecl => "enum",
        EventDecl => "event",
        EntityDecl => "entity",
        _ => null
    };

    /// <summary>
    /// The structured display rows for a class node, walked through the SHARED <see cref="ClassRows"/>
    /// helper (same order + same classify-derived rule as the Mermaid emitter) and formatted with the
    /// readable <see cref="KoineType"/> (source-like, NOT Mermaid's tilde notation): fields as
    /// <c>"{name}: {type}"</c>, methods as <c>"{name}({params})[: {ret}]"</c> with params <c>"{name}: {type}"</c>,
    /// and enum values as the bare member name.
    /// </summary>
    private static IReadOnlyList<DiagramMember> ClassMembers(TypeDecl type, AggregateDecl? owningAggregate = null) =>
        ClassRows(type, owningAggregate).Select(FormatMember).ToArray();

    /// <summary>
    /// The construct's business rules (invariants) as readable strings — each invariant's declared
    /// message, else its described condition — matching the narrative docs' "Business rules" list
    /// (see <c>MarkdownDoc.WriteRules</c>). Only value objects and entities carry invariants; returns
    /// <c>null</c> when there are none so the wire payload stays compact.
    /// </summary>
    private static IReadOnlyList<string>? NodeInvariants(TypeDecl type)
    {
        IReadOnlyList<Invariant>? invariants = type switch
        {
            ValueObjectDecl v => v.Invariants,
            EntityDecl e => e.Invariants,
            _ => null,
        };
        if (invariants is null || invariants.Count == 0)
        {
            return null;
        }

        return invariants.Select(inv => inv.Message ?? Describe(inv.Condition)).ToArray();
    }

    /// <summary>Normalizes a decl's <c>///</c> doc for the wire: empty/whitespace becomes <c>null</c> so an
    /// undocumented event stays compact (the renderer shows <c>—</c>).</summary>
    private static string? NormalizeDoc(string? doc) => string.IsNullOrWhiteSpace(doc) ? null : doc;

    /// <summary>Formats one shared <see cref="ClassRow"/> into its <see cref="DiagramMember"/> wire row.</summary>
    private static DiagramMember FormatMember(ClassRow row) => row.Kind switch
    {
        ClassRowKind.Field => new DiagramMember($"{row.Name}: {RowType(row)}", "field"),
        ClassRowKind.Computed => new DiagramMember($"{row.Name}: {RowType(row)}", "computed"),
        ClassRowKind.Method => new DiagramMember(FormatMethod(row), "method"),
        ClassRowKind.Value => new DiagramMember(row.Name, "value"),
        _ => new DiagramMember(row.Name, "field")
    };

    /// <summary>The readable type text for a field row: its <see cref="KoineType"/>, else empty.</summary>
    private static string RowType(ClassRow row) =>
        row.Type is { } t ? KoineType(t) : string.Empty;

    /// <summary>Formats a method row as <c>name(p1: T1, p2: T2): Ret</c> (the return suffix is dropped when void).</summary>
    private static string FormatMethod(ClassRow row)
    {
        var ps = string.Join(", ", (row.Parameters ?? []).Select(p => $"{p.Name}: {KoineType(p.Type)}"));
        var head = $"{row.Name}({ps})";
        return row.ReturnType is { } ret ? $"{head}: {KoineType(ret)}" : head;
    }

    // ---- context map --------------------------------------------------------

    /// <summary>
    /// The strategic context map: one node per referenced context (declared alphabetically, matching
    /// <see cref="EmitContextMap"/>), one edge per relation in source order. A context has no own AST
    /// node here, so each context node falls back to the relation span that first introduced it.
    /// </summary>
    private static DiagramDescriptor BuildContextMapDescriptor(ContextMapNode map)
    {
        var nodes = new List<DiagramNode>();
        var nodeIds = new Dictionary<string, string>(StringComparer.Ordinal);
        var firstSpan = new Dictionary<string, SourceSpan>(StringComparer.Ordinal);

        // Remember the first relation that mentions each context so its node gets a real span.
        foreach (ContextRelation rel in map.Relations)
        {
            firstSpan.TryAdd(rel.Upstream, rel.Span);
            firstSpan.TryAdd(rel.Downstream, rel.Span);
        }

        // Declare contexts alphabetically (Ordinal), exactly as EmitContextMap does.
        foreach (string ctx in map.Relations
            .SelectMany(r => new[] { r.Upstream, r.Downstream })
            .Distinct(StringComparer.Ordinal)
            .OrderBy(c => c, StringComparer.Ordinal))
        {
            var id = Sanitize(ctx);
            if (nodeIds.TryAdd(id, ctx))
            {
                nodes.Add(new DiagramNode(id, ctx, "context", ctx, firstSpan[ctx]));
            }
        }

        var edges = new List<DiagramEdge>();
        foreach (ContextRelation rel in map.Relations)
        {
            edges.Add(new DiagramEdge(
                Sanitize(rel.Upstream), Sanitize(rel.Downstream), KindLabel(rel.Kind), ArrowKind: "association"));
        }

        return new DiagramDescriptor(
            Caption: "Context Map",
            Kind: "contextmap",
            Mermaid: BuildContextMapMermaid(map),
            Graph: new DiagramGraph(nodes, edges));
    }

    // ---- integration events -------------------------------------------------

    /// <summary>
    /// The cross-context integration-event flow: a node per context (publisher/subscriber) and a node
    /// per integration event, edges publisher --publishes--&gt; event --consumed by--&gt; subscriber.
    /// Mirrors <see cref="EmitIntegrationFlowchart"/>. Returns <c>null</c> when there are no events.
    /// </summary>
    private static DiagramDescriptor? BuildIntegrationEventsDescriptor(KoineModel model)
    {
        var byKey = new SortedDictionary<string, (ContextNode Ctx, IntegrationEventDecl Event)>(StringComparer.Ordinal);
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (IntegrationEventDecl ie in ctx.AllTypeDecls().OfType<IntegrationEventDecl>())
            {
                byKey[$"{ctx.Name}.{ie.Name}"] = (ctx, ie);
            }
        }

        if (byKey.Count == 0)
        {
            return null;
        }

        // event-key -> subscribing contexts (same collection EmitIntegrationFlowchart performs).
        var subscribers = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                var key = $"{sub.Context}.{sub.EventName}";
                if (!subscribers.TryGetValue(key, out var set))
                {
                    set = new SortedSet<string>(StringComparer.Ordinal);
                    subscribers[key] = set;
                }

                set.Add(ctx.Name);
            }
        }

        var nodes = new List<DiagramNode>();
        var contextSpan = new Dictionary<string, SourceSpan>(StringComparer.Ordinal);
        var contextIds = new Dictionary<string, string>(StringComparer.Ordinal);
        var edges = new List<DiagramEdge>();

        SourceSpan ContextSpan(string name)
        {
            if (contextSpan.TryGetValue(name, out var span))
            {
                return span;
            }

            var ctx = model.Contexts.FirstOrDefault(c => c.Name == name);
            span = ctx is not null ? PreferName(ctx, ctx) : SourceSpan.None;
            contextSpan[name] = span;
            return span;
        }

        string EnsureContext(string name)
        {
            var id = Sanitize(name);
            if (contextIds.TryAdd(id, name))
            {
                nodes.Add(new DiagramNode(id, name, "context", name, ContextSpan(name)));
            }

            return id;
        }

        foreach (var (key, value) in byKey)
        {
            var eventId = NodeId(key);
            nodes.Add(new DiagramNode(
                eventId, key, "integration-event", key, PreferName(value.Event, value.Ctx),
                // Surface the integration event's "when this happens" doc for the Events table (issue #170).
                Doc: NormalizeDoc(value.Event.Doc)));

            if (value.Ctx.Publishes.Any(p => p.EventName == value.Event.Name))
            {
                var publisherId = EnsureContext(value.Ctx.Name);
                edges.Add(new DiagramEdge(publisherId, eventId, "publishes", ArrowKind: "flow"));
            }

            if (subscribers.TryGetValue(key, out var subs))
            {
                foreach (string sub in subs)
                {
                    var subId = EnsureContext(sub);
                    edges.Add(new DiagramEdge(eventId, subId, "consumed by", ArrowKind: "flow"));
                }
            }
        }

        var mermaid = new StringBuilder("```mermaid\nflowchart LR\n");
        EmitIntegrationFlowchartBody(mermaid, byKey, subscribers);
        mermaid.Append("```");

        return new DiagramDescriptor(
            Caption: "Integration Events",
            Kind: "integration-events",
            Mermaid: mermaid.ToString(),
            Graph: new DiagramGraph(nodes, edges));
    }

    // ---- span helpers -------------------------------------------------------

    /// <summary>
    /// The most precise span for <paramref name="node"/>: its <see cref="KoineNode.NameSpan"/> when set,
    /// else its full <see cref="KoineNode.Span"/>, else the owner's name/full span. Never returns
    /// <see cref="SourceSpan.None"/> as long as the owner carries any position.
    /// </summary>
    private static SourceSpan PreferName(KoineNode node, KoineNode owner)
    {
        if (!node.NameSpan.IsNone)
        {
            return node.NameSpan;
        }

        if (!node.Span.IsNone)
        {
            return node.Span;
        }

        if (!owner.NameSpan.IsNone)
        {
            return owner.NameSpan;
        }

        return owner.Span;
    }

    // ---- Mermaid block extraction -------------------------------------------

    /// <summary>
    /// Extracts the fenced <c>```mermaid … ```</c> block from a rendered fragment (leading/trailing
    /// markdown around the diagram is dropped) so the descriptor's Mermaid equals the snippet embedded
    /// in the Markdown document.
    /// </summary>
    private static string ExtractMermaidBlock(string rendered)
    {
        var start = rendered.IndexOf("```mermaid", StringComparison.Ordinal);
        if (start < 0)
        {
            return rendered.Trim();
        }

        var end = rendered.IndexOf("```", start + "```mermaid".Length, StringComparison.Ordinal);
        if (end < 0)
        {
            return rendered[start..].TrimEnd();
        }

        return rendered[start..(end + 3)];
    }

    /// <summary>Rebuilds just the context-map Mermaid block (same shape EmitContextMap embeds).</summary>
    private static string BuildContextMapMermaid(ContextMapNode map)
    {
        var sb = new StringBuilder("```mermaid\nflowchart LR\n");

        var contexts = new SortedSet<string>(StringComparer.Ordinal);
        foreach (ContextRelation rel in map.Relations)
        {
            contexts.Add(rel.Upstream);
            contexts.Add(rel.Downstream);
        }

        foreach (string ctx in contexts)
        {
            sb.Append("    ").Append(Sanitize(ctx)).Append("[\"").Append(ctx).Append("\"]\n");
        }

        if (contexts.Count > 0)
        {
            sb.Append('\n');
        }

        foreach (ContextRelation rel in map.Relations)
        {
            EmitRelationEdge(sb, rel);
        }

        sb.Append("```");
        return sb.ToString();
    }
}
