using System.Text;
using System.Text.RegularExpressions;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// Orchestration support for <see cref="PythonEmitter"/>: per-run state, the Python package/file
/// layout (namespace → snake_case package, DDD kind subfolders), the deterministic import-header
/// assembler (each module imports the stdlib names, runtime symbols, and sibling user types it
/// actually references), <c>__init__.py</c> emission, and small shared formatting helpers.
/// </summary>
public sealed partial class PythonEmitter
{
    /// <summary>The immutable per-emit state threaded through every emit method (the emitter stays reentrant).</summary>
    internal sealed record PyEmitContext(
        ModelIndex Index,
        IReadOnlyDictionary<string, string> EnumMemberToType,
        IReadOnlyList<PyTypeLocation> TypeLocations,
        IReadOnlyList<string> ContextNames,
        IReadOnlySet<string> AdditiveNeeds,
        IReadOnlyDictionary<string, IReadOnlySet<string>> ScalarNeeds);

    /// <summary>
    /// Where an emitted user type lives: its bounded context, the dotted import module
    /// (e.g. <c>sales.value_objects.money</c>), and the Python class name it exports.
    /// </summary>
    internal readonly record struct PyTypeLocation(string Context, string ModuleDotted, string ExportName);

    // ----------------------------------------------------------------------
    // File / package layout
    // ----------------------------------------------------------------------

    /// <summary>The DDD kind subfolders. The aggregate root lives at the context package root.</summary>
    private static class KindFolder
    {
        public const string Root = "";
        public const string ValueObjects = "value_objects";
        public const string Entities = "entities";
        public const string Enums = "enums";
        public const string Events = "events";
        public const string Repositories = "repositories";
        public const string ReadModels = "read_models";
        public const string Queries = "queries";
        public const string Policies = "policies";
        public const string Abstractions = "abstractions";
    }

    /// <summary>
    /// The snake_case package path for a namespace (its dot-separated segments lowered to
    /// <c>snake_case</c>, each remapped via <see cref="PythonEmitterOptions.RemapPackage"/>), as
    /// <c>/</c>-joined folder segments. <c>Sales</c> → <c>sales</c>; <c>Catalog.Pricing</c> →
    /// <c>catalog/pricing</c> (or its configured remap).
    /// </summary>
    private string PackageFolderFor(string ns) => PackagePath(ns).Replace('.', '/');

    /// <summary>The dotted package path for a namespace (remapped, snake_cased), e.g. <c>sales</c>.</summary>
    private string PackagePath(string ns)
    {
        var snake = string.Join('.', ns.Split('.').Select(PythonNaming.ToSnakeCase));
        return _options.RemapPackage(snake);
    }

    /// <summary>The output file path for a type's module: package folder, optional kind subfolder, <c>snake.py</c>.</summary>
    private string PathFor(string ns, string kindFolder, string typeName)
    {
        var folder = PackageFolderFor(ns);
        var module = PythonNaming.ToSnakeCase(typeName);
        return kindFolder.Length == 0 ? $"{folder}/{module}.py" : $"{folder}/{kindFolder}/{module}.py";
    }

    /// <summary>The dotted import module a type is reachable at, e.g. <c>sales.value_objects.money</c>.</summary>
    private string ModuleDottedFor(string ns, string kindFolder, string typeName)
    {
        var pkg = PackagePath(ns);
        var module = PythonNaming.ToSnakeCase(typeName);
        return kindFolder.Length == 0 ? $"{pkg}.{module}" : $"{pkg}.{kindFolder}.{module}";
    }

    private static string ContextOf(string ns)
    {
        var dot = ns.IndexOf('.');
        return dot < 0 ? ns : ns[..dot];
    }

    // ----------------------------------------------------------------------
    // Import-header assembly
    // ----------------------------------------------------------------------

    /// <summary>
    /// The runtime symbols a module may reference, in their deterministic import order. Only the
    /// names that actually appear in the body are imported.
    /// </summary>
    private static readonly IReadOnlyList<string> RuntimeSymbols = new[]
    {
        "AggregateRoot",
        "ConcurrencyConflictError",
        "DomainInvariantViolationError",
        "Instant",
        "QueryHandler",
        "Range",
        "koine_max",
        "koine_min",
        "koine_sum",
    };

    private static readonly Regex IdentifierRegex = new(@"\b[A-Za-z_][A-Za-z0-9_]*\b", RegexOptions.Compiled);

    /// <summary>Matches a triple-quoted docstring (so its prose doesn't drive imports).</summary>
    private static readonly Regex DocstringRegex = new("\"\"\".*?\"\"\"", RegexOptions.Compiled | RegexOptions.Singleline);

    /// <summary>
    /// A code-only view of a module body: triple-quoted docstrings and trailing <c>#</c> comments
    /// removed, so identifiers that appear only in prose never drive an import. Conservative — the
    /// emitted bodies don't contain <c>#</c> or <c>"""</c> inside string literals, so a simple strip
    /// is exact for this emitter's output.
    /// </summary>
    private static string StripDocsAndComments(string body)
    {
        var noDocs = DocstringRegex.Replace(body, " ");
        var sb = new StringBuilder(noDocs.Length);
        foreach (var line in noDocs.Split('\n'))
        {
            var hash = line.IndexOf('#');
            sb.Append(hash >= 0 ? line[..hash] : line).Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>
    /// Wraps a rendered module body with its imports and a <c># &lt;auto-generated/&gt;</c> banner.
    /// The import set is derived from the identifiers (and a few token markers like <c>re.</c>,
    /// <c>field(</c>) that actually appear in the module's CODE — docstrings and <c>#</c> comments are
    /// stripped first so a type mentioned only in prose (e.g. <c>Range&lt;Instant&gt;</c> in a doc)
    /// never pulls in a spurious import. The same data-driven approach as the C# <c>UsingCollector</c>
    /// and the TS <c>Assemble</c>. Three deterministically-sorted blocks are emitted: stdlib, then the
    /// once-emitted <c>koine_runtime</c>, then local cross-type modules (absolute imports rooted at the
    /// output dir, never relative, never the module's own symbols).
    /// </summary>
    /// <param name="emit">The per-emit context carrying the type-location map used to resolve cross-type imports.</param>
    /// <param name="ns">The declaring namespace, used to determine THIS module's context for import resolution.</param>
    /// <param name="body">The rendered module body the imports are derived from and prepended to.</param>
    /// <param name="declaredName">The symbol this module declares, excluded from its own cross-type imports.</param>
    /// <param name="symbolContext">
    /// Optional per-symbol context override for cross-type import resolution. By default a symbol that
    /// exists in several contexts resolves to THIS module's context; an ACL translator instead needs
    /// each mapped type resolved against the context it was DECLARED in (a downstream type whose name
    /// collides with an upstream type must not silently shadow the upstream one). Maps the exported
    /// symbol name to the context whose copy should be imported.
    /// </param>
    private string Assemble(
        PyEmitContext emit, string ns, string body, string declaredName,
        IReadOnlyDictionary<string, string>? symbolContext = null)
    {
        // Scan a CODE-ONLY view: strip docstrings, then `#` comments, so prose never drives imports.
        var codeView = StripDocsAndComments(body);
        var present = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in IdentifierRegex.Matches(codeView))
        {
            present.Add(m.Value);
        }

        var sb = new StringBuilder();
        sb.Append("# <auto-generated/>\n");
        sb.Append("from __future__ import annotations\n");

        var stdlib = new List<string>();

        // dataclasses: `from dataclasses import dataclass, field` when `field(` is used, else just
        // `dataclass`. Both come in one statement so emission stays a single deterministic line.
        var usesDataclass = present.Contains("dataclass");
        var usesField = codeView.Contains("field(");
        if (usesDataclass || usesField)
        {
            var names = new List<string>();
            if (usesDataclass)
            {
                names.Add("dataclass");
            }
            if (usesField)
            {
                names.Add("field");
            }
            stdlib.Add("from dataclasses import " + string.Join(", ", names));
        }

        if (present.Contains("datetime") || present.Contains("timezone"))
        {
            // `Instant` (datetime) and `now`-defaults need timezone-aware datetimes.
            var names = new List<string> { "datetime" };
            if (present.Contains("timezone"))
            {
                names.Add("timezone");
            }
            stdlib.Add("from datetime import " + string.Join(", ", names));
        }

        if (present.Contains("Decimal"))
        {
            stdlib.Add("from decimal import Decimal");
        }

        // `collections.abc` exports both `Mapping` (Map<K,V> fields) and `Callable` (enum
        // match/switch handler parameters); collapse them into one deterministic import line.
        var abc = new List<string>();
        if (present.Contains("Callable"))
        {
            abc.Add("Callable");
        }
        if (present.Contains("Mapping"))
        {
            abc.Add("Mapping");
        }
        if (abc.Count > 0)
        {
            abc.Sort(StringComparer.Ordinal);
            stdlib.Add("from collections.abc import " + string.Join(", ", abc));
        }

        // `typing` exports: `Protocol` (repository/service contracts) and `TypeVar` (a smart enum's
        // generic `match` return). Collapse into one deterministic import line when both appear.
        var typing = new List<string>();
        if (present.Contains("Protocol"))
        {
            typing.Add("Protocol");
        }
        if (present.Contains("TypeVar"))
        {
            typing.Add("TypeVar");
        }
        if (typing.Count > 0)
        {
            typing.Sort(StringComparer.Ordinal);
            stdlib.Add("from typing import " + string.Join(", ", typing));
        }

        if (present.Contains("enum"))
        {
            stdlib.Add("import enum");
        }

        if (codeView.Contains("re.") && present.Contains("re"))
        {
            stdlib.Add("import re");
        }

        if (present.Contains("uuid"))
        {
            stdlib.Add("import uuid");
        }

        stdlib.Sort(StringComparer.Ordinal);
        foreach (var line in stdlib)
        {
            sb.Append(line).Append('\n');
        }

        // Runtime imports — a single `from koine_runtime import …` for the symbols present.
        var runtime = RuntimeSymbols.Where(present.Contains).OrderBy(s => s, StringComparer.Ordinal).ToList();
        if (runtime.Count > 0)
        {
            sb.Append("from ").Append(PyRuntime.ModuleName).Append(" import ").Append(string.Join(", ", runtime)).Append('\n');
        }

        // Local cross-type imports: any known user type that appears in the body and is NOT declared
        // by this module. A type shared across contexts resolves to THIS context's copy. Grouped per
        // module, modules sorted, symbols within a module sorted — fully deterministic.
        var thisContext = ContextOf(ns);
        var bySymbol = new Dictionary<string, List<PyTypeLocation>>(StringComparer.Ordinal);
        foreach (PyTypeLocation loc in emit.TypeLocations)
        {
            if (!bySymbol.TryGetValue(loc.ExportName, out List<PyTypeLocation>? list))
            {
                bySymbol[loc.ExportName] = list = new List<PyTypeLocation>();
            }
            list.Add(loc);
        }

        var imports = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var (symbol, candidates) in bySymbol)
        {
            if (symbol == declaredName || !present.Contains(symbol))
            {
                continue;
            }
            // Prefer the symbol's declared-in context when one is supplied (ACL), else this module's
            // context — falling back to the first candidate when neither has a copy.
            var preferred = symbolContext is not null && symbolContext.TryGetValue(symbol, out var pc) ? pc : thisContext;
            PyTypeLocation chosen = candidates.FirstOrDefault(c => c.Context == preferred, candidates[0]);
            imports[symbol] = chosen.ModuleDotted;
        }

        foreach (var group in imports.GroupBy(kv => kv.Value).OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            var symbols = group.Select(kv => kv.Key).OrderBy(s => s, StringComparer.Ordinal);
            sb.Append("from ").Append(group.Key).Append(" import ").Append(string.Join(", ", symbols)).Append('\n');
        }

        sb.Append('\n').Append('\n');
        sb.Append(body);
        if (!body.EndsWith('\n'))
        {
            sb.Append('\n');
        }
        return sb.ToString();
    }

    // ----------------------------------------------------------------------
    // Package __init__.py emission
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits an empty (header-only) <c>__init__.py</c> for every package directory implied by the
    /// emitted module paths, so the tree imports cleanly and mypy treats each directory as a package.
    /// Directories are collected from the already-emitted <c>.py</c> files (every ancestor folder of
    /// each module), then sorted for deterministic output.
    /// </summary>
    private static void EmitPackageInits(List<EmittedFile> files)
    {
        const string initBody = "# <auto-generated/>\n";

        var dirs = new SortedSet<string>(StringComparer.Ordinal);
        foreach (EmittedFile f in files)
        {
            if (!f.RelativePath.EndsWith(".py", StringComparison.Ordinal))
            {
                continue;
            }

            // Every ancestor directory of this module is a package (skip the output root itself —
            // `koine_runtime.py` lives there and should not be turned into a package).
            var slash = f.RelativePath.LastIndexOf('/');
            while (slash > 0)
            {
                dirs.Add(f.RelativePath[..slash]);
                slash = f.RelativePath.LastIndexOf('/', slash - 1);
            }
        }

        foreach (var dir in dirs)
        {
            files.Add(new EmittedFile($"{dir}/__init__.py", initBody));
        }
    }

    // ----------------------------------------------------------------------
    // Type-location map (typeName -> dotted import module + export name)
    // ----------------------------------------------------------------------

    private IReadOnlyList<PyTypeLocation> BuildTypeLocations(KoineModel model)
    {
        var locations = new List<PyTypeLocation>();
        ModelIndex index = new SemanticModel(model).Index;

        foreach (ContextNode ctx in model.Contexts)
        {
            // Aggregate-root entities emit at the context package root (no `entities/` subfolder, see
            // EmitEntity), so their recorded location must match — otherwise a cross-module importer
            // (e.g. the root's repository Protocol) would resolve a non-existent `entities/<root>`.
            var rootEntityNames = new HashSet<string>(
                ctx.AllTypeDecls().OfType<AggregateDecl>().Select(a => a.RootName), StringComparer.Ordinal);

            var idsHere = new HashSet<string>(StringComparer.Ordinal);
            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                var ns = ModelIndex.NamespaceOf(ctx.Name, type.ModulePath);
                Record(locations, ctx.Name, type, ns, rootEntityNames);
                if (type is EntityDecl entity)
                {
                    // The branded ID type lives alongside value objects.
                    var idName = PythonNaming.ToPascalCase(entity.IdentityName);
                    locations.Add(new PyTypeLocation(ctx.Name, ModuleDottedFor(ns, KindFolder.ValueObjects, entity.IdentityName), idName));
                    idsHere.Add(entity.IdentityName);
                }
            }

            // Foreign *Id types referenced here but not owned by a local entity are materialized at
            // the context package root (value_objects/) — register their location so importers
            // resolve them. Mirrors the TS emitter's unowned-id registration.
            foreach (var idName in OrderedUnownedIds(ctx, index))
            {
                if (idsHere.Add(idName))
                {
                    var py = PythonNaming.ToPascalCase(idName);
                    locations.Add(new PyTypeLocation(ctx.Name, ModuleDottedFor(ctx.Name, KindFolder.ValueObjects, idName), py));
                }
            }
        }

        return locations;
    }

    private void Record(List<PyTypeLocation> locations, string context, TypeDecl type, string ns, IReadOnlySet<string> rootEntityNames)
    {
        switch (type)
        {
            case ValueObjectDecl vo:
                Add(locations, context, vo.Name, ns, KindFolder.ValueObjects);
                break;
            case EnumDecl en:
                Add(locations, context, en.Name, ns, KindFolder.Enums);
                break;
            // An aggregate-root entity is recorded at the context package root (KindFolder.Root) so
            // importers resolve `sales.order`, not `sales.entities.order`; non-root entities stay in
            // `entities/`. This MUST agree with EmitEntity's PathFor decision.
            case EntityDecl entity:
                Add(locations, context, entity.Name, ns,
                    rootEntityNames.Contains(entity.Name) ? KindFolder.Root : KindFolder.Entities);
                break;
            case EventDecl ev:
                Add(locations, context, ev.Name, ns, KindFolder.Events);
                break;
            case IntegrationEventDecl iev:
                Add(locations, context, iev.Name, ns, KindFolder.Events);
                break;
            // A read model's DTO is referenced by its queries' handler Protocols (and other
            // contexts); register it so the cross-module import resolves to read_models/.
            case ReadModelDecl rm:
                Add(locations, context, rm.Name, ns, KindFolder.ReadModels);
                break;
            // A query DTO may be referenced cross-module; register it in queries/.
            case QueryDecl q:
                Add(locations, context, q.Name, ns, KindFolder.Queries);
                break;
        }
    }

    private void Add(List<PyTypeLocation> locations, string context, string name, string ns, string kindFolder)
    {
        var py = PythonNaming.ToPascalCase(name);
        locations.Add(new PyTypeLocation(context, ModuleDottedFor(ns, kindFolder, name), py));
    }

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

    /// <summary>Renders a target-agnostic doc string as a Python triple-quoted docstring at <paramref name="indent"/>.</summary>
    private static void WriteDoc(StringBuilder sb, string? doc, string indent)
    {
        if (string.IsNullOrEmpty(doc))
        {
            return;
        }

        var lines = doc.Split('\n');
        if (lines.Length == 1)
        {
            sb.Append(indent).Append("\"\"\"").Append(EscapeDoc(lines[0])).Append("\"\"\"\n");
            return;
        }

        sb.Append(indent).Append("\"\"\"").Append(EscapeDoc(lines[0])).Append('\n');
        for (var i = 1; i < lines.Length; i++)
        {
            sb.Append(indent).Append(EscapeDoc(lines[i])).Append('\n');
        }
        sb.Append(indent).Append("\"\"\"\n");
    }

    /// <summary>Escapes a backslash and a triple-quote run so a doc line can't break the docstring.</summary>
    private static string EscapeDoc(string line) =>
        line.Replace("\\", "\\\\").Replace("\"\"\"", "\\\"\\\"\\\"");

    /// <summary>A Python single-quoted string literal for an invariant rule message.</summary>
    private static string RuleLiteral(string rule) =>
        "\"" + rule.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}
