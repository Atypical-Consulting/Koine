using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// Orchestration support for <see cref="PhpEmitter"/>: per-run state, the PHP PSR-4 file layout
/// (context namespace → DDD kind subfolder → PascalCase class file), the file-header writer
/// (<c>&lt;?php</c> + <c>declare(strict_types=1);</c> + namespace + use lines), and small shared
/// formatting helpers (docblocks, indentation).
/// </summary>
public sealed partial class PhpEmitter
{
    /// <summary>Four-space indent — the PHP conventional indent width.</summary>
    private const string Indent = "    ";

    /// <summary>The immutable per-emit state threaded through every emit method.</summary>
    internal sealed record PhpEmitContext(
        ModelIndex Index,
        IReadOnlyDictionary<string, string> EnumMemberToType,
        IReadOnlySet<string> AdditiveNeeds,
        IReadOnlyDictionary<string, IReadOnlySet<string>> ScalarNeeds);

    /// <summary>
    /// Short class name → every <c>(FQN, declaring context)</c> that name resolves to — e.g.
    /// <c>Money → [(Koine\Menu\ValueObjects\Money, Menu), (Koine\Payment\ValueObjects\Money, Payment)]</c>.
    /// A short name shared across bounded contexts keeps an entry per context (mirroring the Python
    /// emitter's <c>PyTypeLocation</c> list) so a reference resolves against the context it was
    /// <em>declared</em> in, not whichever copy a flat last-writer-wins map happened to keep. Built once
    /// per <see cref="Emit(KoineModel, SemanticModel?)"/> and consulted by <see cref="CollectUses"/> so
    /// each file imports the cross-namespace types it references.
    /// </summary>
    private IReadOnlyDictionary<string, IReadOnlyList<(string Fqn, string Context)>> _typeCatalog =
        new Dictionary<string, IReadOnlyList<(string Fqn, string Context)>>(StringComparer.Ordinal);

    /// <summary>The synthetic "context" stamped on runtime types (<c>Range</c>, <c>QueryHandler</c>) in
    /// the catalog — they are globally unique, so resolution always falls through to the lone entry; the
    /// value only needs to never collide with a real declared context name.</summary>
    private const string RuntimeContext = "@runtime";

    // -------------------------------------------------------------------------
    // File / PSR-4 layout
    // -------------------------------------------------------------------------

    /// <summary>DDD kind subfolders (mirrors the Python emitter's KindFolder).</summary>
    private static class KindFolder
    {
        public const string ValueObjects = "ValueObjects";
        public const string Entities = "Entities";
        public const string Enums = "Enums";
        public const string Events = "Events";
        public const string Repositories = "Repositories";
        public const string ReadModels = "ReadModels";
        public const string Queries = "Queries";
        public const string Services = "Services";
        public const string Specifications = "Specifications";
        public const string Policies = "Policies";
        public const string Abstractions = "Abstractions";
    }

    /// <summary>
    /// The PSR-4 output path for a type: <c>src/&lt;Context&gt;/&lt;Kind&gt;/&lt;ClassName&gt;.php</c>.
    /// Example: <c>Sales/Money</c> in <c>ValueObjects</c> → <c>src/Sales/ValueObjects/Money.php</c>.
    /// When <paramref name="kindFolder"/> is empty the type lands directly under the context folder.
    /// </summary>
    private static string PathFor(string contextName, string kindFolder, string typeName)
    {
        var ctx = PhpNaming.ToPascalCase(contextName);
        var cls = PhpNaming.ClassName(typeName);
        return kindFolder.Length == 0
            ? $"src/{ctx}/{cls}.php"
            : $"src/{ctx}/{kindFolder}/{cls}.php";
    }

    // -------------------------------------------------------------------------
    // File-header writer
    // -------------------------------------------------------------------------

    /// <summary>
    /// Writes a PHP file header: <c>&lt;?php\ndeclare(strict_types=1);\n\nnamespace Koine\…;\n</c>
    /// followed by any <c>use</c> declarations derived from the body, then the body itself.
    /// </summary>
    /// <param name="contextName">The bounded context this file is declared in — the default context a
    /// referenced short name resolves against when no per-symbol override applies.</param>
    /// <param name="symbolContext">
    /// Optional per-symbol context override for cross-namespace import resolution. By default a short
    /// name shared across contexts resolves to THIS file's context; an emitter that references a type
    /// from another bounded context (an ACL translator, a cross-context read-model field, a subscriber's
    /// publisher event) maps that symbol to the context it was DECLARED in so a same-named local type
    /// never silently shadows it. Maps a short class name to its declaring context.
    /// </param>
    private string Assemble(
        string contextName, string kindFolder, string body, string className,
        IReadOnlyDictionary<string, string>? symbolContext = null)
    {
        var fileNs = NamespaceFor(contextName);
        if (kindFolder.Length > 0)
        {
            fileNs += "\\" + kindFolder;
        }

        var sb = new StringBuilder();
        sb.Append("<?php\n");
        sb.Append("// <auto-generated/>\n");
        sb.Append("declare(strict_types=1);\n");
        sb.Append('\n');
        sb.Append("namespace ").Append(fileNs).Append(";\n");

        // Collect use lines that the body actually references.
        var uses = CollectUses(body, fileNs, contextName, className, symbolContext);
        if (uses.Count > 0)
        {
            sb.Append('\n');
            foreach (var use in uses)
            {
                sb.Append("use ").Append(use).Append(";\n");
            }
        }

        sb.Append('\n');
        sb.Append(body);
        if (!body.EndsWith('\n'))
        {
            sb.Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>The emitted PHP namespace for a bounded context, applying the configured remap
    /// (<c>targets.php.namespaces.&lt;Context&gt;</c>); unmapped contexts keep the <c>Koine\</c> root.</summary>
    private string NamespaceFor(string contextName)
    {
        var ctx = PhpNaming.ToPascalCase(contextName);
        return _options.NamespaceMap.TryGetValue(ctx, out var mapped) ? mapped : $@"Koine\{ctx}";
    }

    /// <summary>
    /// Collects the <c>use</c> import lines a PHP file needs for the cross-namespace types it
    /// references by short name. PHP resolves a bare short name against the file's own namespace, so
    /// every sibling-namespace type (branded id, enum, event, sibling value object, entity) and the
    /// runtime <c>Range</c> referenced in the body must be imported or it fatals as "class not found".
    /// <para>
    /// The body uses PascalCase class names at type-hint / <c>new X</c> / <c>X::</c> / <c>instanceof</c>
    /// positions; property and method names are camelCase (lowercase first letter), so a whole-word
    /// PascalCase scan never collides with them. Imports whose FQN equals the file's own namespace
    /// (same-namespace siblings) and the file's own class are skipped. Output is sorted ordinally for
    /// deterministic emission.
    /// </para>
    /// </summary>
    private List<string> CollectUses(
        string body, string fileNamespace, string fileContext, string className,
        IReadOnlyDictionary<string, string>? symbolContext = null)
    {
        var uses = new SortedSet<string>(StringComparer.Ordinal);

        foreach (var (shortName, locations) in _typeCatalog)
        {
            if (shortName == className)
            {
                continue; // never import the file's own class
            }

            if (!ReferencesType(body, shortName))
            {
                continue;
            }

            // A short name shared across contexts has several candidates; resolve to the one the
            // reference means — the per-symbol declaring-context hint, else this file's own context,
            // else the first declaration (catalog order is deterministic).
            var fqn = ResolveReference(shortName, locations, fileContext, symbolContext);

            // The type's namespace is everything before the final `\` in its FQN.
            var lastSep = fqn.LastIndexOf('\\');
            var typeNs = lastSep < 0 ? string.Empty : fqn[..lastSep];
            if (typeNs == fileNamespace)
            {
                continue; // same namespace — no import needed
            }

            uses.Add(fqn);
        }

        return uses.ToList();
    }

    /// <summary>
    /// Resolves a referenced short name to a single FQN among its catalog <paramref name="locations"/>:
    /// the per-symbol declaring-context hint wins, else the referencing file's own
    /// <paramref name="fileContext"/>, else the first declaration. The fallback chain matches the Python
    /// emitter's <c>Assemble</c> resolution so the two backends agree on which context a shared name
    /// belongs to.
    /// </summary>
    private static string ResolveReference(
        string shortName,
        IReadOnlyList<(string Fqn, string Context)> locations,
        string fileContext,
        IReadOnlyDictionary<string, string>? symbolContext)
    {
        var preferred = symbolContext is not null && symbolContext.TryGetValue(shortName, out var hinted)
            ? hinted
            : fileContext;

        foreach (var loc in locations)
        {
            if (loc.Context == preferred)
            {
                return loc.Fqn;
            }
        }

        return locations[0].Fqn;
    }

    /// <summary>
    /// True when <paramref name="body"/> references the PascalCase class <paramref name="shortName"/>
    /// as a whole word (so <c>OrderId</c> does not match inside <c>OrderIdList</c> or a camelCase
    /// property). The leading boundary must not be a PHP namespace separator or identifier char, and
    /// must not be a <c>$</c> (a variable) or <c>></c> (the tail of <c>-&gt;</c>, i.e. a property access).
    /// </summary>
    private static bool ReferencesType(string body, string shortName)
    {
        int from = 0;
        while (true)
        {
            int idx = body.IndexOf(shortName, from, StringComparison.Ordinal);
            if (idx < 0)
            {
                return false;
            }

            bool leftOk = idx == 0 || !IsBoundaryBlocking(body[idx - 1]);
            int end = idx + shortName.Length;
            bool rightOk = end >= body.Length || !IsIdentifierChar(body[end]);
            if (leftOk && rightOk)
            {
                return true;
            }

            from = idx + 1;
        }
    }

    /// <summary>A char that, immediately before a name, means it is NOT a bare type reference:
    /// an identifier char (part of a longer name), a <c>\</c> (already-qualified), a <c>$</c>
    /// (a variable), or a <c>></c> (the <c>-&gt;</c> of a property/method access).</summary>
    private static bool IsBoundaryBlocking(char c) =>
        IsIdentifierChar(c) || c is '\\' or '$' or '>';

    private static bool IsIdentifierChar(char c) => char.IsLetterOrDigit(c) || c == '_';

    // -------------------------------------------------------------------------
    // Type catalog (short name → FQN) for cross-namespace `use` imports
    // -------------------------------------------------------------------------

    /// <summary>
    /// Builds the short-name → fully-qualified-name catalog over every type the model emits: each
    /// declared value object, entity (+ its branded id), enum, event, integration event, aggregate
    /// repository interface, and service — plus referenced-but-unowned branded ids and the runtime
    /// <c>Range</c> (the only runtime type referenced by short name; <c>Decimal</c> and the
    /// exceptions are emitted fully-qualified, so they need no import).
    /// </summary>
    private Dictionary<string, IReadOnlyList<(string Fqn, string Context)>> BuildTypeCatalog(KoineModel model, ModelIndex index)
    {
        var catalog = new Dictionary<string, List<(string Fqn, string Context)>>(StringComparer.Ordinal);

        void Add(string ctx, string kindFolder, string rawName)
        {
            var cls = PhpNaming.ClassName(rawName);
            var ns = NamespaceFor(ctx);
            if (kindFolder.Length > 0)
            {
                ns += "\\" + kindFolder;
            }
            var fqn = ns + "\\" + cls;

            if (!catalog.TryGetValue(cls, out List<(string Fqn, string Context)>? locations))
            {
                catalog[cls] = locations = new List<(string Fqn, string Context)>();
            }

            // De-dup on FQN — the same type can be reached from several catalog passes (e.g. an
            // entity's branded id and an unowned-id sweep) within one context.
            if (!locations.Any(l => l.Fqn == fqn))
            {
                locations.Add((fqn, ctx));
            }
        }

        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl t in ctx.AllTypeDecls())
            {
                switch (t)
                {
                    case ValueObjectDecl vo:
                        Add(ctx.Name, KindFolder.ValueObjects, vo.Name);
                        break;
                    case EnumDecl en:
                        Add(ctx.Name, KindFolder.Enums, en.Name);
                        break;
                    case EntityDecl e:
                        Add(ctx.Name, KindFolder.Entities, e.Name);
                        Add(ctx.Name, KindFolder.ValueObjects, e.IdentityName); // branded id VO
                        break;
                    case EventDecl ev:
                        Add(ctx.Name, KindFolder.Events, ev.Name);
                        break;
                    case IntegrationEventDecl iev:
                        Add(ctx.Name, KindFolder.Events, iev.Name);
                        break;
                    case ReadModelDecl rm:
                        Add(ctx.Name, KindFolder.ReadModels, rm.Name);
                        break;
                    case QueryDecl q:
                        Add(ctx.Name, KindFolder.Queries, q.Name);
                        break;
                }
            }

            // Aggregate repository interfaces (named <Root>Repository).
            foreach (AggregateDecl agg in ctx.Types.OfType<AggregateDecl>())
            {
                var root = agg.Types.OfType<EntityDecl>().FirstOrDefault(en => en.Name == agg.RootName);
                if (root is not null)
                {
                    Add(ctx.Name, KindFolder.Repositories, root.Name + "Repository");
                }
            }

            // Referenced-but-unowned branded ids are emitted into this context's ValueObjects.
            foreach (var idName in UnownedIdNamesIn(ctx, index))
            {
                Add(ctx.Name, KindFolder.ValueObjects, idName);
            }
        }

        // The runtime Range is referenced by its short name (`public readonly Range $window`).
        catalog["Range"] = new List<(string, string)> { (@"Koine\Runtime\Range", RuntimeContext) };

        // The runtime QueryHandler interface is referenced by handler seams.
        catalog["QueryHandler"] = new List<(string, string)> { (@"Koine\Runtime\QueryHandler", RuntimeContext) };

        return catalog.ToDictionary(
            kv => kv.Key,
            kv => (IReadOnlyList<(string Fqn, string Context)>)kv.Value,
            StringComparer.Ordinal);
    }

    /// <summary>
    /// Branded id names referenced in a context (e.g. <c>CustomerId</c>) that no declared entity in
    /// the model owns — these must be emitted as a minimal id value object so the output is
    /// self-contained. Deterministically ordered.
    /// </summary>
    private static IEnumerable<string> UnownedIdNamesIn(ContextNode ctx, ModelIndex index)
    {
        var owned = new HashSet<string>(
            ctx.AllTypeDecls().OfType<EntityDecl>().Select(e => e.IdentityName), StringComparer.Ordinal);

        var seen = new SortedSet<string>(StringComparer.Ordinal);
        foreach (TypeRef tr in ModelIndex.AllTypeRefsIn(ctx))
        {
            CollectIdNames(tr, seen);
        }

        foreach (var name in seen)
        {
            if (!owned.Contains(name)
                && !index.TryGetDecl(name, out _)
                && index.Classify(name) == TypeKind.IdValueObject)
            {
                yield return name;
            }
        }
    }

    /// <summary>Recursively collects id-convention type names from a (possibly generic) type ref.</summary>
    private static void CollectIdNames(TypeRef tr, ISet<string> acc)
    {
        if (ModelIndex.IsIdConvention(tr.Name))
        {
            acc.Add(tr.Name);
        }
        if (tr.Element is not null)
        {
            CollectIdNames(tr.Element, acc);
        }
        if (tr.Value is not null)
        {
            CollectIdNames(tr.Value, acc);
        }
    }

    /// <summary>
    /// Emits a minimal branded id value object for every referenced-but-unowned id (finding D), so
    /// every <c>use Koine\…\&lt;Id&gt;</c> the emitter wrote actually resolves to a class.
    /// </summary>
    private void EmitUnownedIds(PhpEmitContext emit, KoineModel model, List<EmittedFile> files)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (var idName in UnownedIdNamesIn(ctx, emit.Index))
            {
                files.Add(EmitMinimalId(idName, ctx.Name));
            }
        }
    }

    /// <summary>
    /// Emits a minimal, self-contained branded id value object for a foreign id (no <c>generate()</c>
    /// — this context does not own the entity). Backing defaults to a UUID <c>string</c>, mirroring
    /// the shape of <see cref="EmitIdType"/>.
    /// </summary>
    private EmittedFile EmitMinimalId(string idRaw, string contextName)
    {
        var idName = PhpNaming.ClassName(idRaw);

        var sb = new StringBuilder();
        sb.Append("/** A strongly-typed, branded identity value object for a foreign aggregate. */\n");
        sb.Append("final class ").Append(idName).Append('\n');
        sb.Append("{\n");
        sb.Append(Indent).Append("public function __construct(\n");
        sb.Append(Indent).Append(Indent).Append("public readonly string $value\n");
        sb.Append(Indent).Append(") {}\n");
        sb.Append('\n');
        sb.Append(Indent).Append("public function equals(self $other): bool\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("return $this->value === $other->value;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.ValueObjects, idRaw),
            Assemble(contextName, KindFolder.ValueObjects, sb.ToString(), idName));
    }

    // -------------------------------------------------------------------------
    // Doc-comment helpers
    // -------------------------------------------------------------------------

    /// <summary>Writes a PHPDoc block for a class or member at <paramref name="indent"/>.</summary>
    private static void WriteDoc(StringBuilder sb, string? doc, string indent)
    {
        if (string.IsNullOrEmpty(doc))
        {
            return;
        }

        var lines = doc.Split('\n');
        if (lines.Length == 1)
        {
            sb.Append(indent).Append("/** ").Append(EscapeDoc(lines[0])).Append(" */\n");
            return;
        }

        sb.Append(indent).Append("/**\n");
        foreach (var line in lines)
        {
            sb.Append(indent).Append(" * ").Append(EscapeDoc(line)).Append('\n');
        }
        sb.Append(indent).Append(" */\n");
    }

    private static string EscapeDoc(string line) =>
        line.Replace("*/", "* /");

    /// <summary>A PHP double-quoted string literal for an invariant rule message.</summary>
    private static string RuleLiteral(string rule) =>
        "\"" + rule.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    // -------------------------------------------------------------------------
    // Enum member map, for translator qualification
    // -------------------------------------------------------------------------

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
}
