using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace Koine.Compiler.SourceGen;

/// <summary>
/// Incremental source generator that reads the <c>Koine.Compiler.Ast.KoineNode</c> record hierarchy
/// straight out of the compilation's semantic model (the records ARE the schema — there is no
/// <c>Syntax.xml</c>) and emits the typed, void/value/rewriting visitor family modeled on Roslyn's
/// generated <c>CSharpSyntaxVisitor</c> / <c>CSharpSyntaxVisitor&lt;TResult&gt;</c> /
/// <c>CSharpSyntaxRewriter</c>:
///
/// <list type="bullet">
///   <item><c>KoineSyntaxVisitor</c> — void-returning typed visitor.</item>
///   <item><c>KoineSyntaxVisitor&lt;TResult&gt;</c> — value-returning typed visitor (folds/queries).</item>
///   <item><c>KoineSyntaxRewriter : KoineSyntaxVisitor&lt;KoineNode?&gt;</c> — returns a rewritten tree,
///   reference-equal to the input where nothing changed (the identity invariant).</item>
///   <item><c>KoineSyntaxChildEnumerator</c> + a static <c>ChildNodes.Of(node)</c> facade — the typed
///   replacement for <c>NodeWalker.ChildNodes</c>, consumed by <c>SyntaxGraph.Build</c>.</item>
/// </list>
///
/// Dispatch is a GENERATED type-switch inside <c>Visit</c> — there is NO <c>Accept</c> member on any
/// node, so the <c>Ast/</c> records stay pristine and visitor-free.
///
/// FAIL CLOSED: if zero concrete <c>KoineNode</c> subtypes are discovered the generator emits an
/// error <c>Diagnostic</c> rather than empty visitors (which would silently turn every traversal into
/// a no-op with a green-ish build).
/// </summary>
[Generator(LanguageNames.CSharp)]
public sealed class SyntaxVisitorGenerator : IIncrementalGenerator
{
    private const string KoineNodeMetadataName = "Koine.Compiler.Ast.KoineNode";
    private const string Namespace = "Koine.Compiler.Ast";

    // Base KoineNode scalar slots that are never children — excluded from child-slot classification.
    private static readonly HashSet<string> BaseScalarSlots = new()
    {
        "Span", "NameSpan", "Doc", "LeadingTrivia", "TrailingTrivia"
    };

    private const string FailClosedId = "KOINEGEN001";

    private static readonly DiagnosticDescriptor NoNodesFound = new(
        id: FailClosedId,
        title: "No KoineNode subtypes found",
        messageFormat:
            "SyntaxVisitorGenerator found zero concrete KoineNode subtypes; the generated visitor would be a no-op. "
            + "This usually means '" + KoineNodeMetadataName + "' could not be resolved (build order / renamed namespace).",
        category: "Koine.SourceGen",
        defaultSeverity: DiagnosticSeverity.Error,
        isEnabledByDefault: true);

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        // A single pipeline node over the whole compilation: the node set is small and the model is
        // read once per build. (Per-syntax-tree incrementality buys nothing here — the schema is the
        // full KoineNode hierarchy.)
        IncrementalValueProvider<Model?> models = context.CompilationProvider.Select(
            static (compilation, _) => BuildModel(compilation));

        context.RegisterSourceOutput(models, static (spc, model) => Emit(spc, model));
    }

    // ------------------------------------------------------------------------
    // Model discovery (semantic-model driven; no marker attribute, no enum).
    // ------------------------------------------------------------------------

    private static Model? BuildModel(Compilation compilation)
    {
        INamedTypeSymbol? koineNode = compilation.GetTypeByMetadataName(KoineNodeMetadataName);
        if (koineNode is null)
        {
            // KoineNode not in this compilation — emit nothing AND no diagnostic; this generator only
            // applies to the project that declares the Ast/ records. Returning a sentinel "absent"
            // model (vs an empty node list) distinguishes "not my compilation" from "fail closed".
            return null;
        }

        var nodes = new List<NodeInfo>();
        foreach (INamedTypeSymbol type in AllNamedTypes(compilation.Assembly.GlobalNamespace))
        {
            if (type.IsAbstract)
            {
                continue;
            }

            if (!InheritsKoineNode(type, koineNode))
            {
                continue;
            }

            nodes.Add(new NodeInfo(type, ChildSlots(type, koineNode)));
        }

        // Deterministic emission order: by fully-qualified name.
        nodes.Sort(static (a, b) => string.CompareOrdinal(a.TypeName, b.TypeName));
        return new Model(nodes);
    }

    private static IEnumerable<INamedTypeSymbol> AllNamedTypes(INamespaceSymbol ns)
    {
        foreach (INamedTypeSymbol type in ns.GetTypeMembers())
        {
            yield return type;
            foreach (INamedTypeSymbol nested in AllNestedTypes(type))
            {
                yield return nested;
            }
        }

        foreach (INamespaceSymbol child in ns.GetNamespaceMembers())
        {
            foreach (INamedTypeSymbol type in AllNamedTypes(child))
            {
                yield return type;
            }
        }
    }

    private static IEnumerable<INamedTypeSymbol> AllNestedTypes(INamedTypeSymbol type)
    {
        foreach (INamedTypeSymbol nested in type.GetTypeMembers())
        {
            yield return nested;
            foreach (INamedTypeSymbol deeper in AllNestedTypes(nested))
            {
                yield return deeper;
            }
        }
    }

    private static bool InheritsKoineNode(INamedTypeSymbol type, INamedTypeSymbol koineNode)
    {
        for (INamedTypeSymbol? t = type.BaseType; t is not null; t = t.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(t, koineNode))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Classifies a node's child slots in the GENERATOR-CANONICAL order:
    /// (a) inherited child slots from base types (base-first, then derived) — empty today but pinned;
    /// (b) the node's own primary-ctor / declared child properties in source-declaration order.
    /// Members other than KoineNode-typed singles, optionals, and lists of KoineNode are excluded
    /// (scalars, strings, enums, IReadOnlyList&lt;string&gt;, IReadOnlyList&lt;SyntaxTrivia&gt;, …).
    /// </summary>
    private static ImmutableArray<SlotInfo> ChildSlots(INamedTypeSymbol node, INamedTypeSymbol koineNode)
    {
        // Walk the inheritance chain bottom-up, collecting per-level slots, then reverse so base
        // levels come first ((a) inherited base-first → (b) own).
        var levels = new List<List<SlotInfo>>();
        for (INamedTypeSymbol? t = node; t is not null && !SymbolEqualityComparer.Default.Equals(t, koineNode.BaseType); t = t.BaseType)
        {
            // Stop once we pass KoineNode itself — KoineNode's own scalar slots are excluded anyway.
            var level = new List<SlotInfo>();
            foreach (IPropertySymbol prop in t.GetMembers().OfType<IPropertySymbol>())
            {
                if (prop.IsStatic || prop.IsIndexer || prop.DeclaredAccessibility != Accessibility.Public)
                {
                    continue;
                }

                if (BaseScalarSlots.Contains(prop.Name))
                {
                    continue;
                }

                if (Classify(prop.Type, koineNode) is { } slot)
                {
                    level.Add(new SlotInfo(prop.Name, slot.Kind, slot.ElementTypeName, slot.SlotTypeName));
                }
            }

            levels.Add(level);

            if (SymbolEqualityComparer.Default.Equals(t, koineNode))
            {
                break;
            }
        }

        // levels[0] = most-derived … levels[^1] = nearest base. Reverse for base-first inherited order.
        levels.Reverse();
        var ordered = new List<SlotInfo>();
        foreach (List<SlotInfo> level in levels)
        {
            ordered.AddRange(level);
        }

        return ordered.ToImmutableArray();
    }

    private static (SlotKind Kind, string? ElementTypeName, string SlotTypeName)? Classify(ITypeSymbol type, INamedTypeSymbol koineNode)
    {
        // Single child (required / optional). A nullable reference type T? has NullableAnnotation.Annotated.
        if (type is INamedTypeSymbol named && IsKoineNode(named, koineNode))
        {
            bool optional = type.NullableAnnotation == NullableAnnotation.Annotated;
            string slotType = named.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            return (optional ? SlotKind.SingleOptional : SlotKind.SingleRequired, null, slotType);
        }

        // List child: IReadOnlyList<U> / IEnumerable<U> with U : KoineNode (and U not string/SyntaxTrivia).
        if (ListElementType(type) is { } element && element is INamedTypeSymbol elementNamed && IsKoineNode(elementNamed, koineNode))
        {
            string elementType = elementNamed.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            return (SlotKind.List, elementType, type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat));
        }

        return null;
    }

    private static bool IsKoineNode(INamedTypeSymbol type, INamedTypeSymbol koineNode)
    {
        for (INamedTypeSymbol? t = type; t is not null; t = t.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(t, koineNode))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// If <paramref name="type"/> is an <c>IReadOnlyList&lt;U&gt;</c> / <c>IEnumerable&lt;U&gt;</c>
    /// (or implements one), returns U; otherwise null. Strings are not enumerated-as-nodes.
    /// </summary>
    private static ITypeSymbol? ListElementType(ITypeSymbol type)
    {
        if (type.SpecialType == SpecialType.System_String)
        {
            return null;
        }

        if (type is INamedTypeSymbol named && named.IsGenericType)
        {
            string defName = named.ConstructedFrom.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            if (defName is "global::System.Collections.Generic.IReadOnlyList<T>"
                or "global::System.Collections.Generic.IEnumerable<T>"
                or "global::System.Collections.Generic.IReadOnlyCollection<T>"
                or "global::System.Collections.Generic.IList<T>"
                or "global::System.Collections.Generic.List<T>")
            {
                return named.TypeArguments[0];
            }
        }

        // Implemented interfaces (e.g. an array, or a concrete collection).
        ITypeSymbol? best = null;
        foreach (INamedTypeSymbol iface in (type as INamedTypeSymbol)?.AllInterfaces ?? ImmutableArray<INamedTypeSymbol>.Empty)
        {
            if (iface.IsGenericType
                && iface.ConstructedFrom.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)
                    == "global::System.Collections.Generic.IReadOnlyList<T>")
            {
                best = iface.TypeArguments[0];
            }
        }

        return best;
    }

    // ------------------------------------------------------------------------
    // Emission.
    // ------------------------------------------------------------------------

    private static void Emit(SourceProductionContext context, Model? model)
    {
        if (model is null)
        {
            // Not the compilation that declares KoineNode — emit nothing.
            return;
        }

        if (model.Nodes.Count == 0)
        {
            context.ReportDiagnostic(Diagnostic.Create(NoNodesFound, Location.None));
            return;
        }

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Emitted by Koine.Compiler.SourceGen.SyntaxVisitorGenerator. Do not edit.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System;");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine();
        sb.AppendLine($"namespace {Namespace};");
        sb.AppendLine();

        EmitVoidVisitor(sb, model);
        sb.AppendLine();
        EmitResultVisitor(sb, model);
        sb.AppendLine();
        EmitRewriter(sb, model);
        sb.AppendLine();
        EmitChildEnumerator(sb, model);

        context.AddSource("KoineSyntaxVisitor.g.cs", SourceText.From(sb.ToString(), Encoding.UTF8));
    }

    private static void EmitVoidVisitor(StringBuilder sb, Model model)
    {
        sb.AppendLine("/// <summary>Typed, void-returning visitor over the KoineNode tree (Roslyn CSharpSyntaxVisitor analogue).</summary>");
        sb.AppendLine("internal abstract class KoineSyntaxVisitor");
        sb.AppendLine("{");
        sb.AppendLine("    /// <summary>Dispatches to the per-node hook for <paramref name=\"node\"/>'s runtime type.</summary>");
        sb.AppendLine("    public virtual void Visit(KoineNode? node)");
        sb.AppendLine("    {");
        sb.AppendLine("        switch (node)");
        sb.AppendLine("        {");
        sb.AppendLine("            case null: return;");
        foreach (NodeInfo n in model.Nodes)
        {
            sb.AppendLine($"            case {n.TypeName} typed: Visit{n.MethodSuffix}(typed); break;");
        }
        sb.AppendLine("            default: DefaultVisit(node); break;");
        sb.AppendLine("        }");
        sb.AppendLine("    }");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Visits each child of <paramref name=\"node\"/> in canonical order.</summary>");
        sb.AppendLine("    public virtual void DefaultVisit(KoineNode node)");
        sb.AppendLine("    {");
        sb.AppendLine("        foreach (KoineNode child in KoineSyntaxChildEnumerator.Children(node))");
        sb.AppendLine("        {");
        sb.AppendLine("            Visit(child);");
        sb.AppendLine("        }");
        sb.AppendLine("    }");
        foreach (NodeInfo n in model.Nodes)
        {
            sb.AppendLine();
            sb.AppendLine($"    public virtual void Visit{n.MethodSuffix}({n.TypeName} node) => DefaultVisit(node);");
        }
        sb.AppendLine("}");
    }

    private static void EmitResultVisitor(StringBuilder sb, Model model)
    {
        sb.AppendLine("/// <summary>Typed, value-returning visitor (folds/queries). Roslyn CSharpSyntaxVisitor&lt;TResult&gt; analogue.</summary>");
        sb.AppendLine("internal abstract class KoineSyntaxVisitor<TResult>");
        sb.AppendLine("{");
        sb.AppendLine("    /// <summary>Dispatches to the per-node hook for <paramref name=\"node\"/>'s runtime type.</summary>");
        sb.AppendLine("    public virtual TResult? Visit(KoineNode? node)");
        sb.AppendLine("    {");
        sb.AppendLine("        switch (node)");
        sb.AppendLine("        {");
        sb.AppendLine("            case null: return default;");
        foreach (NodeInfo n in model.Nodes)
        {
            sb.AppendLine($"            case {n.TypeName} typed: return Visit{n.MethodSuffix}(typed);");
        }
        sb.AppendLine("            default: return DefaultVisit(node);");
        sb.AppendLine("        }");
        sb.AppendLine("    }");
        sb.AppendLine();
        sb.AppendLine("    public virtual TResult? DefaultVisit(KoineNode node) => default;");
        foreach (NodeInfo n in model.Nodes)
        {
            sb.AppendLine();
            sb.AppendLine($"    public virtual TResult? Visit{n.MethodSuffix}({n.TypeName} node) => DefaultVisit(node);");
        }
        sb.AppendLine("}");
    }

    private static void EmitRewriter(StringBuilder sb, Model model)
    {
        sb.AppendLine("/// <summary>");
        sb.AppendLine("/// Returns a rewritten tree. Honors the IDENTITY INVARIANT: returns the SAME instance when no");
        sb.AppendLine("/// child changed; reallocates (with-expression) only the spine of changed subtrees. Roslyn");
        sb.AppendLine("/// CSharpSyntaxRewriter analogue.");
        sb.AppendLine("/// </summary>");
        sb.AppendLine("internal abstract class KoineSyntaxRewriter : KoineSyntaxVisitor<KoineNode?>");
        sb.AppendLine("{");
        sb.AppendLine("    public override KoineNode? DefaultVisit(KoineNode node) => node;");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>Throws if a required (non-nullable) slot rewrote to null — fail fast at the cause.</summary>");
        sb.AppendLine("    private protected static T Required<T>(T? value, string node, string slot) where T : KoineNode");
        sb.AppendLine("        => value ?? throw new InvalidOperationException(");
        sb.AppendLine("            $\"Rewriter returned null for required slot '{slot}' of {node}.\");");
        sb.AppendLine();
        sb.AppendLine("    /// <summary>");
        sb.AppendLine("    /// Rewrites a list, comparing each element to the original by ReferenceEquals (NOT ==/Equals —");
        sb.AppendLine("    /// value-equal records would defeat the rewrite). Returns the SAME IReadOnlyList instance when");
        sb.AppendLine("    /// every element is reference-identical; allocates a new array only on first change. A list");
        sb.AppendLine("    /// element rewritten to null THROWS (element deletion is deferred).");
        sb.AppendLine("    /// </summary>");
        sb.AppendLine("    private protected IReadOnlyList<T> VisitList<T>(IReadOnlyList<T> list, string node, string slot) where T : KoineNode");
        sb.AppendLine("    {");
        sb.AppendLine("        T[]? rebuilt = null;");
        sb.AppendLine("        for (int i = 0; i < list.Count; i++)");
        sb.AppendLine("        {");
        sb.AppendLine("            T original = list[i];");
        sb.AppendLine("            var rewritten = (T?)Visit(original);");
        sb.AppendLine("            if (rewritten is null)");
        sb.AppendLine("            {");
        sb.AppendLine("                throw new InvalidOperationException(");
        sb.AppendLine("                    $\"Rewriter returned null for a list element of slot '{slot}' of {node} (element deletion is not supported).\");");
        sb.AppendLine("            }");
        sb.AppendLine();
        sb.AppendLine("            if (rebuilt is null && !ReferenceEquals(rewritten, original))");
        sb.AppendLine("            {");
        sb.AppendLine("                rebuilt = new T[list.Count];");
        sb.AppendLine("                for (int j = 0; j < i; j++)");
        sb.AppendLine("                {");
        sb.AppendLine("                    rebuilt[j] = list[j];");
        sb.AppendLine("                }");
        sb.AppendLine("            }");
        sb.AppendLine();
        sb.AppendLine("            if (rebuilt is not null)");
        sb.AppendLine("            {");
        sb.AppendLine("                rebuilt[i] = rewritten;");
        sb.AppendLine("            }");
        sb.AppendLine("        }");
        sb.AppendLine();
        sb.AppendLine("        return rebuilt ?? list;");
        sb.AppendLine("    }");

        foreach (NodeInfo n in model.Nodes)
        {
            sb.AppendLine();
            EmitRewriterMethod(sb, n);
        }

        sb.AppendLine("}");
    }

    private static void EmitRewriterMethod(StringBuilder sb, NodeInfo n)
    {
        sb.AppendLine($"    public override KoineNode? Visit{n.MethodSuffix}({n.TypeName} node)");
        sb.AppendLine("    {");

        if (n.Slots.Length == 0)
        {
            sb.AppendLine("        return node;");
            sb.AppendLine("    }");
            return;
        }

        // Compute each child.
        foreach (SlotInfo s in n.Slots)
        {
            switch (s.Kind)
            {
                case SlotKind.SingleRequired:
                    sb.AppendLine($"        var {s.Local} = ({s.SlotTypeName}?)Visit(node.{s.Name});");
                    break;
                case SlotKind.SingleOptional:
                    sb.AppendLine($"        var {s.Local} = node.{s.Name} is null ? null : ({s.SlotTypeName}?)Visit(node.{s.Name});");
                    break;
                case SlotKind.List:
                    sb.AppendLine($"        var {s.Local} = VisitList(node.{s.Name}, \"{n.MethodSuffix}\", \"{s.Name}\");");
                    break;
            }
        }

        // Unchanged check (reference equality on every slot).
        string unchanged = string.Join("\n            && ", n.Slots.Select(s => $"ReferenceEquals({s.Local}, node.{s.Name})"));
        sb.AppendLine($"        if ({unchanged})");
        sb.AppendLine("        {");
        sb.AppendLine("            return node;");
        sb.AppendLine("        }");
        sb.AppendLine();

        // Reallocate with required-slot guards.
        var assignments = n.Slots.Select(s => s.Kind == SlotKind.SingleRequired
            ? $"{s.Name} = Required({s.Local}, \"{n.MethodSuffix}\", \"{s.Name}\")"
            : $"{s.Name} = {s.Local}");
        sb.AppendLine($"        return node with {{ {string.Join(", ", assignments)} }};");
        sb.AppendLine("    }");
    }

    private static void EmitChildEnumerator(StringBuilder sb, Model model)
    {
        sb.AppendLine("/// <summary>");
        sb.AppendLine("/// The typed replacement for NodeWalker.ChildNodes: yields a node's child nodes in the");
        sb.AppendLine("/// generator-canonical order. Stateless; the static <see cref=\"Children\"/> facade is what");
        sb.AppendLine("/// SyntaxGraph.Build consumes.");
        sb.AppendLine("/// </summary>");
        sb.AppendLine("internal static class KoineSyntaxChildEnumerator");
        sb.AppendLine("{");
        sb.AppendLine("    /// <summary>The child nodes of <paramref name=\"node\"/>, in canonical order (empty for a leaf).</summary>");
        sb.AppendLine("    public static IEnumerable<KoineNode> Children(KoineNode node)");
        sb.AppendLine("    {");
        sb.AppendLine("        switch (node)");
        sb.AppendLine("        {");
        foreach (NodeInfo n in model.Nodes)
        {
            if (n.Slots.Length == 0)
            {
                continue;
            }

            sb.AppendLine($"            case {n.TypeName} typed: return {n.MethodSuffix}Children(typed);");
        }
        sb.AppendLine("            default: return System.Array.Empty<KoineNode>();");
        sb.AppendLine("        }");
        sb.AppendLine("    }");

        foreach (NodeInfo n in model.Nodes)
        {
            if (n.Slots.Length == 0)
            {
                continue;
            }

            sb.AppendLine();
            sb.AppendLine($"    private static IEnumerable<KoineNode> {n.MethodSuffix}Children({n.TypeName} node)");
            sb.AppendLine("    {");
            foreach (SlotInfo s in n.Slots)
            {
                switch (s.Kind)
                {
                    case SlotKind.SingleRequired:
                        sb.AppendLine($"        yield return node.{s.Name};");
                        break;
                    case SlotKind.SingleOptional:
                        sb.AppendLine($"        if (node.{s.Name} is not null) {{ yield return node.{s.Name}; }}");
                        break;
                    case SlotKind.List:
                        sb.AppendLine($"        foreach (var item in node.{s.Name}) {{ yield return item; }}");
                        break;
                }
            }
            sb.AppendLine("    }");
        }

        sb.AppendLine("}");
        sb.AppendLine();
        sb.AppendLine("/// <summary>Static facade over the generated child enumeration (the SyntaxGraph.Build entry point).</summary>");
        sb.AppendLine("internal static class ChildNodes");
        sb.AppendLine("{");
        sb.AppendLine("    /// <summary>The child nodes of <paramref name=\"node\"/> in canonical order.</summary>");
        sb.AppendLine("    public static IEnumerable<KoineNode> Of(KoineNode node) => KoineSyntaxChildEnumerator.Children(node);");
        sb.AppendLine("}");
    }

    // ------------------------------------------------------------------------
    // Small data holders.
    // ------------------------------------------------------------------------

    private enum SlotKind { SingleRequired, SingleOptional, List }

    private sealed class SlotInfo
    {
        public SlotInfo(string name, SlotKind kind, string? elementTypeName, string slotTypeName)
        {
            Name = name;
            Kind = kind;
            ElementTypeName = elementTypeName;
            SlotTypeName = slotTypeName;
            Local = "_" + char.ToLowerInvariant(name[0]) + name.Substring(1);
        }

        public string Name { get; }
        public SlotKind Kind { get; }
        public string? ElementTypeName { get; }

        /// <summary>The fully-qualified declared slot type (single: the node type; list: the IReadOnlyList type).</summary>
        public string SlotTypeName { get; }

        /// <summary>A unique local-variable name for this slot's rewritten value.</summary>
        public string Local { get; }
    }

    private sealed class NodeInfo
    {
        public NodeInfo(INamedTypeSymbol type, ImmutableArray<SlotInfo> slots)
        {
            TypeName = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            MethodSuffix = type.Name;
            Slots = slots;
        }

        /// <summary>Fully-qualified type name (<c>global::Koine.Compiler.Ast.BinaryExpr</c>).</summary>
        public string TypeName { get; }

        /// <summary>The <c>VisitXxx</c> suffix — the simple type name (<c>BinaryExpr</c>).</summary>
        public string MethodSuffix { get; }

        public ImmutableArray<SlotInfo> Slots { get; }
    }

    private sealed class Model
    {
        public Model(IReadOnlyList<NodeInfo> nodes) => Nodes = nodes;

        public IReadOnlyList<NodeInfo> Nodes { get; }
    }
}
