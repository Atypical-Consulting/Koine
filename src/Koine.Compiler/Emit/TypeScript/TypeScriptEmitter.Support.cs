using System.Text;
using System.Text.RegularExpressions;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The orchestration support for <see cref="TypeScriptEmitter"/>: per-run state, file layout
/// (namespace → folder, DDD kind subfolders), module-import resolution (each file imports the
/// runtime symbols and the sibling user types it references), and small shared formatting helpers.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    /// <summary>The immutable per-emit state threaded through every emit method (the emitter stays reentrant).</summary>
    internal sealed record TsEmitContext(
        ModelIndex Index,
        IReadOnlySet<string> AdditiveNeeds,
        IReadOnlyDictionary<string, IReadOnlySet<string>> ScalarNeeds,
        IReadOnlyList<string> ContextNames,
        IReadOnlyList<TsTypeLocation> TypeLocations,
        IReadOnlyDictionary<string, string> EnumMemberToType)
    {
        /// <summary>
        /// Pending Source Map v3 sidecars accumulated during emit when
        /// <see cref="TsEmitterOptions.EmitSourceMaps"/> is on; materialized into sidecar
        /// <see cref="EmittedFile"/>s by the top-level loop. Empty (and untouched) on the off path.
        /// </summary>
        public List<PendingSourceMap> SourceMaps { get; } = new();
    }

    /// <summary>
    /// Where an emitted user type lives: the import module path (no extension), the primary export
    /// name, and any auxiliary exports a referencing file may need (an enum's <c>&lt;Name&gt;Member</c>
    /// type and <c>&lt;Name&gt;Match</c>/<c>&lt;Name&gt;FromName</c>… helpers; an ID's <c>&lt;Name&gt;New</c>).
    /// </summary>
    internal readonly record struct TsTypeLocation(string Context, string ModulePath, string ExportName, IReadOnlyList<string> AuxExports);

    // ----------------------------------------------------------------------
    // File layout
    // ----------------------------------------------------------------------

    private static class KindFolder
    {
        public const string Root = "";
        public const string Entities = "entities";
        public const string ValueObjects = "value-objects";
        public const string Enums = "enums";
        public const string Events = "events";
        public const string Repositories = "repositories";
        public const string Services = "services";
        public const string ReadModels = "read-models";
        public const string Queries = "queries";
    }

    private static string FolderFor(string ns) => ns.Replace('.', '/');

    /// <summary>The output path for a type's file: namespace folder, optional kind subfolder, <c>Name.ts</c>.</summary>
    private static string PathFor(string ns, string kindFolder, string name)
    {
        var folder = FolderFor(ns);
        return kindFolder.Length == 0 ? $"{folder}/{name}.ts" : $"{folder}/{kindFolder}/{name}.ts";
    }

    /// <summary>The import module path (no extension) a type's file is reachable at, for cross-file imports.</summary>
    private static string ModulePathFor(string ns, string kindFolder, string name)
    {
        var folder = FolderFor(ns);
        return kindFolder.Length == 0 ? $"{folder}/{name}" : $"{folder}/{kindFolder}/{name}";
    }

    private static string ContextOf(string ns)
    {
        var dot = ns.IndexOf('.');
        return dot < 0 ? ns : ns[..dot];
    }

    // ----------------------------------------------------------------------
    // Module imports
    // ----------------------------------------------------------------------

    /// <summary>The runtime symbols any file may reference, and the order they import in.</summary>
    private static readonly IReadOnlyList<string> RuntimeSymbols =
        new[] { "DomainInvariantViolationError", "DomainEvent", "Decimal", "Instant", "structuralEquals", "ValueObject", "Range", "defaultCompare" };

    private static readonly Regex IdentifierRegex = new(@"\b[A-Za-z_][A-Za-z0-9_]*\b", RegexOptions.Compiled);

    /// <summary>
    /// Wraps a rendered file body with the imports it needs and an <c>// &lt;auto-generated/&gt;</c>
    /// banner. The set of imports is derived from the identifiers that actually appear in the body
    /// (the same data-driven approach as the C# <c>UsingCollector</c>): runtime symbols import from
    /// the once-emitted <c>runtime</c> module; sibling user types import from their own module via a
    /// relative path computed from this file's folder.
    /// </summary>
    private string Assemble(TsEmitContext emit, string ns, string kindFolder, string body) =>
        Assemble(emit, ns, kindFolder, body, name: null, declSpan: Ast.SourceSpan.None);

    /// <summary>
    /// <see cref="Assemble(TsEmitContext, string, string, string)"/> with optional Source Map v3
    /// output (production-grade emit, Task 4). When <see cref="TsEmitterOptions.EmitSourceMaps"/> is
    /// on AND <paramref name="declSpan"/> is a real range AND <paramref name="name"/> is supplied, the
    /// module gains a trailing <c>//# sourceMappingURL=&lt;module&gt;.ts.map</c> comment, and a pending
    /// sidecar mapping the declaration's first generated line back to its <c>.koi</c> origin is
    /// registered on <paramref name="emit"/> for the top-level <see cref="Emit(KoineModel, SemanticModel?)"/>
    /// loop to materialize. With the flag off (the default) the returned text is byte-for-byte
    /// identical to the historical emitter — no comment, no sidecar.
    /// </summary>
    private string Assemble(TsEmitContext emit, string ns, string kindFolder, string body, string? name, Ast.SourceSpan declSpan)
    {
        var folder = kindFolder.Length == 0 ? FolderFor(ns) : $"{FolderFor(ns)}/{kindFolder}";
        var present = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in IdentifierRegex.Matches(body))
        {
            present.Add(m.Value);
        }

        var sb = new StringBuilder();
        sb.Append("// <auto-generated/>\n");

        // Runtime imports.
        var runtime = RuntimeSymbols.Where(present.Contains).ToList();
        if (runtime.Count > 0)
        {
            sb.Append("import { ").Append(string.Join(", ", runtime)).Append(" } from '")
              .Append(RelativeImport(folder, TsRuntime.ModuleName)).Append("';\n");
        }

        // Cross-file user-type imports: any known type symbol that appears in the body but is NOT
        // declared by this file. Ordered by symbol for deterministic output.
        var imports = new SortedDictionary<string, string>(StringComparer.Ordinal);

        // Determine which symbols this file declares (so it never imports itself).
        var declaredHere = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in DeclRegex.Matches(body))
        {
            declaredHere.Add(m.Groups[1].Value);
        }

        // For every needed symbol, pick the declaring module — preferring a location in THIS file's
        // own context (a shared type such as `Money` is emitted per context; a reference resolves to
        // the local copy, never a sibling context's).
        var thisContext = ContextOf(ns);
        var bySymbol = new Dictionary<string, List<TsTypeLocation>>(StringComparer.Ordinal);
        foreach (TsTypeLocation loc in emit.TypeLocations)
        {
            foreach (var symbol in loc.AuxExports.Prepend(loc.ExportName))
            {
                if (!bySymbol.TryGetValue(symbol, out List<TsTypeLocation>? list))
                {
                    bySymbol[symbol] = list = new List<TsTypeLocation>();
                }
                list.Add(loc);
            }
        }

        foreach (var (symbol, candidates) in bySymbol.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            if (declaredHere.Contains(symbol) || !present.Contains(symbol))
            {
                continue;
            }
            TsTypeLocation chosen = candidates.FirstOrDefault(c => c.Context == thisContext, candidates[0]);
            imports[symbol] = ImportSpecifier(folder, chosen.ModulePath);
        }

        // Group imports by module so a module imported for several symbols emits one statement.
        foreach (var group in imports.GroupBy(kv => kv.Value).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var symbols = group.Select(kv => kv.Key).OrderBy(s => s, StringComparer.Ordinal);
            sb.Append("import { ").Append(string.Join(", ", symbols)).Append(" } from '").Append(group.Key).Append("';\n");
        }

        if (runtime.Count > 0 || imports.Count > 0)
        {
            sb.Append('\n');
        }

        // The declaration body begins on the line right after the import block (the blank-line
        // separator counts as a line, so the body's first physical line is the builder's current
        // line count + 1, 1-based). Captured before the body is appended.
        var bodyStartLine = CountNewlines(sb) + 1;

        sb.Append(body);
        if (!body.EndsWith('\n'))
        {
            sb.Append('\n');
        }

        // Source maps off (default): byte-identical to the historical emitter.
        if (!_options.EmitSourceMaps || name is null || declSpan.IsNone)
        {
            return sb.ToString();
        }

        // Source maps on: append the sourceMappingURL comment and register a declaration-granularity
        // sidecar (one segment, the body's first generated line → the declaration's `.koi` origin).
        var sourceFile = declSpan.File ?? ns;
        var mapName = name + ".ts.map";
        sb.Append("//# sourceMappingURL=").Append(mapName).Append('\n');

        var bodyLines = CountNewlines(body);
        var generatedEnd = bodyStartLine + Math.Max(0, bodyLines - 1);
        var segment = new SourceMapSegment(bodyStartLine, generatedEnd, sourceFile, declSpan);
        var mapping = new SourceMapV3.Mapping(
            bodyStartLine,
            GeneratedColumn: 0,
            SourceLine: Math.Max(0, declSpan.Line - 1),
            SourceColumn: Math.Max(0, declSpan.Column - 1));

        var modulePath = PathFor(ns, kindFolder, name); // "<folder>/<name>.ts"
        emit.SourceMaps.Add(new PendingSourceMap(
            modulePath,
            modulePath + ".map",
            name + ".ts",
            sourceFile,
            new[] { segment },
            new[] { mapping }));

        return sb.ToString();
    }

    /// <summary>Number of newline characters currently in the builder (so the current 1-based line is this + 1).</summary>
    private static int CountNewlines(StringBuilder sb)
    {
        var count = 0;
        for (var i = 0; i < sb.Length; i++)
        {
            if (sb[i] == '\n')
            {
                count++;
            }
        }
        return count;
    }

    /// <summary>Number of newline characters in <paramref name="text"/>.</summary>
    private static int CountNewlines(string text)
    {
        var count = 0;
        foreach (var ch in text)
        {
            if (ch == '\n')
            {
                count++;
            }
        }
        return count;
    }

    /// <summary>
    /// A source map awaiting materialization once the module's <see cref="EmittedFile"/> is in the
    /// list: the module's relative path, the sidecar path, the v3 <c>file</c>/<c>source</c> names,
    /// the declaration-granularity <see cref="SourceMapSegment"/>s carried on the module's
    /// <see cref="EmittedFile"/>, and the VLQ mappings that build the sidecar JSON.
    /// </summary>
    internal sealed record PendingSourceMap(
        string ModulePath,
        string SidecarPath,
        string FileName,
        string SourceName,
        IReadOnlyList<SourceMapSegment> Segments,
        IReadOnlyList<SourceMapV3.Mapping> Mappings);

    /// <summary>Matches the names this file exports, so it never imports its own symbols.</summary>
    private static readonly Regex DeclRegex = new(
        @"export (?:class|interface|const|type|function) ([A-Za-z_][A-Za-z0-9_]*)",
        RegexOptions.Compiled);

    /// <summary>
    /// The ESM import specifier for a sibling user-type module. When a <see cref="TsEmitterOptions.ModuleMap"/>
    /// rewrites the target's context head (the C# <c>NamespaceMap</c> analogue), the remapped path is
    /// emitted verbatim as a bare specifier (e.g. <c>@acme/billing/value-objects/Money</c>); otherwise a
    /// relative specifier is computed from <paramref name="fromFolder"/>. With an empty map the result is
    /// byte-identical to the historical relative import.
    /// </summary>
    private string ImportSpecifier(string fromFolder, string toModule)
    {
        var remapped = _options.RemapModulePath(toModule);
        return ReferenceEquals(remapped, toModule) || remapped == toModule
            ? RelativeImport(fromFolder, toModule)
            : remapped;
    }

    /// <summary>A relative ESM import specifier from <paramref name="fromFolder"/> to <paramref name="toModule"/>.</summary>
    private static string RelativeImport(string fromFolder, string toModule)
    {
        string[] from = fromFolder.Length == 0 ? Array.Empty<string>() : fromFolder.Split('/');
        string[] to = toModule.Split('/');

        var common = 0;
        while (common < from.Length && common < to.Length - 1 && from[common] == to[common])
        {
            common++;
        }

        var ups = from.Length - common;
        var parts = new List<string>();
        for (var i = 0; i < ups; i++)
        {
            parts.Add("..");
        }
        for (var i = common; i < to.Length; i++)
        {
            parts.Add(to[i]);
        }

        var path = string.Join("/", parts);
        return path.StartsWith('.') ? path : "./" + path;
    }

    // ----------------------------------------------------------------------
    // Type-location map (typeName -> import module + export name)
    // ----------------------------------------------------------------------

    private static IReadOnlyList<TsTypeLocation> BuildTypeNamespaces(KoineModel model)
    {
        var locations = new List<TsTypeLocation>();
        ModelIndex index = new SemanticModel(model).Index;

        foreach (ContextNode ctx in model.Contexts)
        {
            // Aggregate root entities are emitted at the context root (no `entities/` subfolder, see
            // EmitEntity), so their location must match — otherwise a cross-file importer (e.g. the
            // root's repository interface) would resolve a non-existent `entities/<Root>` module.
            var rootEntityNames = new HashSet<string>(
                ctx.AllTypeDecls().OfType<AggregateDecl>().Select(a => a.RootName), StringComparer.Ordinal);

            var idsHere = new HashSet<string>(StringComparer.Ordinal);
            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                var ns = ModelIndex.NamespaceOf(ctx.Name, type.ModulePath);
                Record(locations, ctx.Name, type, ns, rootEntityNames);
                if (type is EntityDecl entity)
                {
                    var idName = TypeScriptNaming.ToPascalCase(entity.IdentityName);
                    locations.Add(new TsTypeLocation(ctx.Name, ModulePathFor(ns, KindFolder.ValueObjects, idName), idName, new[] { idName + "New" }));
                    idsHere.Add(entity.IdentityName);
                }
            }

            // Unowned IDs default into the context root namespace.
            foreach (var idName in OrderedUnownedIds(ctx, index))
            {
                if (idsHere.Add(idName))
                {
                    var ts = TypeScriptNaming.ToPascalCase(idName);
                    locations.Add(new TsTypeLocation(ctx.Name, ModulePathFor(ctx.Name, KindFolder.ValueObjects, ts), ts, new[] { ts + "New" }));
                }
            }
        }

        return locations;
    }

    private static void Record(List<TsTypeLocation> locations, string context, TypeDecl type, string ns, IReadOnlySet<string> rootEntityNames)
    {
        switch (type)
        {
            case ValueObjectDecl vo:
                Add(locations, context, vo.Name, ns, KindFolder.ValueObjects);
                break;
            case EnumDecl en:
                Add(locations, context, en.Name, ns, KindFolder.Enums, EnumAuxExports(TypeScriptNaming.ToPascalCase(en.Name)));
                break;
            case EntityDecl entity:
                Add(locations, context, entity.Name, ns, rootEntityNames.Contains(entity.Name) ? KindFolder.Root : KindFolder.Entities);
                break;
            case EventDecl ev:
                Add(locations, context, ev.Name, ns, KindFolder.Events);
                break;
        }
    }

    /// <summary>An enum module's auxiliary exports: the member type and the smart-enum helpers.</summary>
    private static IReadOnlyList<string> EnumAuxExports(string ts) => new[]
    {
        ts + "Member", ts + "Name", ts + "All",
        ts + "Match", ts + "Switch",
        ts + "FromName", ts + "FromValue", ts + "TryFromName", ts + "TryFromValue",
    };

    private static void Add(List<TsTypeLocation> locations, string context, string name, string ns, string kindFolder, IReadOnlyList<string>? aux = null)
    {
        var ts = TypeScriptNaming.ToPascalCase(name);
        locations.Add(new TsTypeLocation(context, ModulePathFor(ns, kindFolder, ts), ts, aux ?? Array.Empty<string>()));
    }

    // ----------------------------------------------------------------------
    // ID ownership (mirrors the C# emitter's unowned-id logic, trimmed for TS scope)
    // ----------------------------------------------------------------------

    private static IEnumerable<string> OrderedUnownedIds(ContextNode ctx, ModelIndex index)
    {
        var owned = new HashSet<string>(ctx.AllEntities().Select(e => e.IdentityName), StringComparer.Ordinal);
        var seen = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var idName in index.IdTypeNames)
        {
            if (!owned.Contains(idName) && IsReferencedInContext(ctx, idName))
            {
                seen.Add(idName);
            }
        }
        return seen;
    }

    private static bool IsReferencedInContext(ContextNode ctx, string idName)
    {
        foreach (TypeDecl t in ctx.AllTypeDecls())
        {
            IEnumerable<TypeRef> types = t switch
            {
                ValueObjectDecl v => v.Members.Select(m => m.Type),
                EntityDecl e => e.Members.Select(m => m.Type)
                    .Concat(e.Commands.SelectMany(c => c.Parameters.Select(p => p.Type)))
                    .Concat(e.Factories.SelectMany(f => f.Parameters.Select(p => p.Type))),
                EventDecl ev => ev.Members.Select(m => m.Type),
                _ => Array.Empty<TypeRef>()
            };
            if (types.Any(tr => TypeRefMentions(tr, idName)))
            {
                return true;
            }
        }
        return false;
    }

    private static bool TypeRefMentions(TypeRef type, string name) =>
        type.Name == name
        || (type.Element is not null && TypeRefMentions(type.Element, name))
        || (type.Value is not null && TypeRefMentions(type.Value, name));

    // ----------------------------------------------------------------------
    // Enum member map (member name -> owning enum), for translator qualification
    // ----------------------------------------------------------------------

    private static Dictionary<string, string> BuildEnumMemberMap(KoineModel model)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (EnumDecl @enum in ctx.AllTypeDecls().OfType<EnumDecl>())
            {
                foreach (var member in @enum.MemberNames)
                {
                    map.TryAdd(member, @enum.Name);
                }
            }
        }
        return map;
    }

    // ----------------------------------------------------------------------
    // Formatting helpers
    // ----------------------------------------------------------------------

    /// <summary>Renders a target-agnostic doc string as a TSDoc block comment.</summary>
    private static void WriteDoc(StringBuilder sb, string? doc, string indent)
    {
        if (string.IsNullOrEmpty(doc))
        {
            return;
        }

        var lines = doc.Split('\n');
        if (lines.Length == 1)
        {
            sb.Append(indent).Append("/** ").Append(lines[0]).Append(" */\n");
            return;
        }

        sb.Append(indent).Append("/**\n");
        foreach (var line in lines)
        {
            sb.Append(indent).Append(" * ").Append(line).Append('\n');
        }
        sb.Append(indent).Append(" */\n");
    }

    /// <summary>A TS string literal for a guard/invariant rule message.</summary>
    private static string RuleLiteral(string rule) =>
        "'" + rule.Replace("\\", "\\\\").Replace("'", "\\'") + "'";
}
