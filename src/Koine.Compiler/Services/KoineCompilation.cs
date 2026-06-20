using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Antlr4.Runtime;
using Antlr4.Runtime.Atn;
using Antlr4.Runtime.Misc;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Grammar;
using Koine.Compiler.Parsing;

namespace Koine.Compiler.Services;

/// <summary>
/// One parsed-and-hashed unit of a <see cref="KoineCompilation"/> snapshot.
/// Stored by reference so <see cref="KoineCompilation.WithDocument"/> can re-use
/// untouched units without copying.
/// </summary>
internal sealed record ParsedUnit(
    string ContentHash,
    IReadOnlyList<ContextNode> Contexts,
    IReadOnlyList<ContextRelation> Relations,
    IReadOnlyList<Diagnostic> Diagnostics);

/// <summary>
/// An immutable snapshot of a warm (incremental) compilation.  It wraps the same
/// ANTLR two-stage parse that <see cref="KoineCompiler"/> uses but memoises the
/// per-file parse results so that <see cref="WithDocument"/> only re-parses the
/// single changed file while reusing every other unit by reference.
///
/// <para>Three derived properties — <see cref="Model"/>, <see cref="SemanticModel"/>,
/// and <see cref="SyntaxDiagnostics"/> — are computed lazily on first access and
/// memoised thread-safely with <see cref="LazyThreadSafetyMode.ExecutionAndPublication"/>.</para>
///
/// <para>All public parse / merge logic is shared with <see cref="KoineCompiler"/> via the
/// internal static <see cref="ParseUnit(SourceFile)"/> and <see cref="Merge"/> methods so
/// the two paths stay byte-identical.</para>
/// </summary>
public sealed class KoineCompilation
{
    // -------------------------------------------------------------------------
    // Internal state
    // -------------------------------------------------------------------------

    /// <summary>Uri insertion order (first-seen, deduped).</summary>
    private readonly ImmutableArray<string> _order;

    /// <summary>Ordinal-keyed uri → parsed unit map.</summary>
    private readonly ImmutableDictionary<string, ParsedUnit> _units;

    /// <summary>Original source text per uri (for identifier-token scans, Task 4).</summary>
    private readonly ImmutableDictionary<string, string> _texts;

    /// <summary>
    /// The delegate that parses a <see cref="SourceFile"/> into a <see cref="ParsedUnit"/>.
    /// Stored so <see cref="WithDocument"/> reuses the same (possibly stubbed) parser in tests.
    /// </summary>
    private readonly Func<SourceFile, ParsedUnit> _parser;

    // Lazy memoized computed properties — rebuilt on each new snapshot, never across snapshots.
    private readonly Lazy<KoineModel> _model;
    private readonly Lazy<SemanticModel> _semanticModel;
    private readonly Lazy<IReadOnlyList<Diagnostic>> _syntaxDiagnostics;

    /// <summary>
    /// Per-file memoized <see cref="SemanticModel"/>s: keyed by uri, each wrapping only that
    /// file's contexts/relations (mirrors the per-file model <see cref="WorkspaceIndex"/> used to
    /// build via <c>new SemanticModel(compiler.Parse(text).Model)</c>). Built lazily on first
    /// access; thread-safe via <see cref="LazyThreadSafetyMode.ExecutionAndPublication"/>.
    /// </summary>
    private readonly ImmutableDictionary<string, Lazy<SemanticModel>> _perFileModels;

    // -------------------------------------------------------------------------
    // Private constructor (used by all factory paths)
    // -------------------------------------------------------------------------

    private KoineCompilation(
        ImmutableArray<string> order,
        ImmutableDictionary<string, ParsedUnit> units,
        ImmutableDictionary<string, string> texts,
        Func<SourceFile, ParsedUnit> parser)
    {
        _order = order;
        _units = units;
        _texts = texts;
        _parser = parser;

        _model = new Lazy<KoineModel>(BuildModel, LazyThreadSafetyMode.ExecutionAndPublication);
        _semanticModel = new Lazy<SemanticModel>(() => new SemanticModel(Model), LazyThreadSafetyMode.ExecutionAndPublication);
        _syntaxDiagnostics = new Lazy<IReadOnlyList<Diagnostic>>(BuildDiagnostics, LazyThreadSafetyMode.ExecutionAndPublication);

        // Build the per-file Lazy<SemanticModel> map eagerly (only the Lazy wrappers, not the
        // SemanticModels themselves — those are built on demand, without calling the parser).
        var perFileBuilder = ImmutableDictionary.CreateBuilder<string, Lazy<SemanticModel>>(StringComparer.Ordinal);
        foreach (var uri in order)
        {
            var unit = units[uri]; // captured by value in the closure
            perFileBuilder[uri] = new Lazy<SemanticModel>(
                () => new SemanticModel(Merge(unit.Contexts, unit.Relations)),
                LazyThreadSafetyMode.ExecutionAndPublication);
        }
        _perFileModels = perFileBuilder.ToImmutable();
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /// <summary>
    /// Creates a snapshot by parsing each file in order.  Duplicate uris are deduplicated
    /// keeping the first-seen position (same behaviour as <see cref="KoineCompiler.Parse(IReadOnlyList{SourceFile})"/>).
    /// </summary>
    public static KoineCompilation Create(IReadOnlyList<SourceFile> files) =>
        Create(files, ParseUnit);

    /// <summary>
    /// Internal factory that accepts an injectable <paramref name="parser"/> so tests can
    /// count re-parses by wrapping <see cref="ParseUnit"/>.
    /// </summary>
    internal static KoineCompilation Create(IReadOnlyList<SourceFile> files, Func<SourceFile, ParsedUnit> parser)
    {
        var orderBuilder = ImmutableArray.CreateBuilder<string>(files.Count);
        var unitsBuilder = ImmutableDictionary.CreateBuilder<string, ParsedUnit>(StringComparer.Ordinal);
        var textsBuilder = ImmutableDictionary.CreateBuilder<string, string>(StringComparer.Ordinal);

        foreach (var f in files)
        {
            if (unitsBuilder.ContainsKey(f.Path))
            {
                // Duplicate uri: keep first-seen position, update text only.
                textsBuilder[f.Path] = f.Source;
                continue;
            }

            orderBuilder.Add(f.Path);
            unitsBuilder[f.Path] = parser(f);
            textsBuilder[f.Path] = f.Source;
        }

        return new KoineCompilation(
            orderBuilder.ToImmutable(),
            unitsBuilder.ToImmutable(),
            textsBuilder.ToImmutable(),
            parser);
    }

    /// <summary>
    /// Returns a new snapshot with <paramref name="uri"/> updated to <paramref name="text"/>.
    /// If <paramref name="uri"/> already exists with an equal content hash, returns <c>this</c>
    /// (referential identity preserved — no reparse, no new allocation).
    /// If <paramref name="uri"/> is new, it is appended at the end of the order.
    /// </summary>
    public KoineCompilation WithDocument(string uri, string text)
    {
        var hash = ComputeHash(text);

        if (_units.TryGetValue(uri, out var existing) && existing.ContentHash == hash)
        {
            return this; // no-op: same content
        }

        var newUnit = _parser(new SourceFile(uri, text));

        var newOrder = _units.ContainsKey(uri)
            ? _order                              // uri already present — keep its position
            : _order.Add(uri);                    // new uri — append

        var newUnits = _units.SetItem(uri, newUnit);
        var newTexts = _texts.SetItem(uri, text);

        return new KoineCompilation(newOrder, newUnits, newTexts, _parser);
    }

    /// <summary>
    /// Returns a new snapshot without <paramref name="uri"/>.
    /// If <paramref name="uri"/> is not present, returns <c>this</c>.
    /// </summary>
    public KoineCompilation WithoutDocument(string uri)
    {
        if (!_units.ContainsKey(uri))
        {
            return this; // no-op: uri absent
        }

        var newOrder = _order.Remove(uri);
        var newUnits = _units.Remove(uri);
        var newTexts = _texts.Remove(uri);

        return new KoineCompilation(newOrder, newUnits, newTexts, _parser);
    }

    /// <summary>
    /// The merged <see cref="KoineModel"/> for this snapshot.
    /// Always non-null — error-tolerant parsing yields a partial model even on syntax errors.
    /// Computed lazily and memoised.
    /// </summary>
    public KoineModel Model => _model.Value;

    /// <summary>
    /// The semantic façade over <see cref="Model"/>.  Computed lazily and memoised.
    /// </summary>
    public SemanticModel SemanticModel => _semanticModel.Value;

    /// <summary>
    /// All syntax diagnostics from every file, in uri-insertion order.
    /// Matches <see cref="KoineCompiler.Parse(IReadOnlyList{SourceFile})"/> ordering exactly.
    /// Computed lazily and memoised.
    /// </summary>
    public IReadOnlyList<Diagnostic> SyntaxDiagnostics => _syntaxDiagnostics.Value;

    /// <summary>
    /// Original source text per uri, for identifier-token scans (Task 4).
    /// </summary>
    public IReadOnlyDictionary<string, string> Documents => _texts;

    /// <summary>
    /// The memoized single-file <see cref="SemanticModel"/> for one uri (a Merge of just that
    /// file's contexts/relations), mirroring what <see cref="WorkspaceIndex"/> built per document.
    /// Thread-safe + cached — repeated requests over a held snapshot reuse the same instance.
    /// Returns <c>null</c> for an unknown uri.
    /// </summary>
    public SemanticModel? SemanticModelFor(string uri) =>
        _perFileModels.TryGetValue(uri, out var lazy) ? lazy.Value : null;

    /// <summary>
    /// The uris of all documents in this snapshot, in first-seen insertion order.
    /// </summary>
    public IReadOnlyCollection<string> Uris => _order;

    /// <summary>
    /// A content fingerprint that is ORDER-INDEPENDENT over the set of (uri, contentHash) pairs.
    /// Two snapshots with identical file content produce equal <see cref="Fingerprint"/> values
    /// regardless of file insertion order.
    /// </summary>
    public string Fingerprint
    {
        get
        {
            // Sort (uri + "\0" + hash) strings ordinally, join with '\n', SHA256 → hex.
            var parts = _order
                .Select(uri => uri + "\0" + _units[uri].ContentHash)
                .OrderBy(s => s, StringComparer.Ordinal)
                .ToList();

            var joined = string.Join('\n', parts);
            return ComputeHash(joined);
        }
    }

    // -------------------------------------------------------------------------
    // Internal static parse/merge helpers (shared with KoineCompiler)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Parses a single <see cref="SourceFile"/> into a <see cref="ParsedUnit"/> using the
    /// same two-stage SLL→LL ANTLR strategy as <see cref="KoineCompiler"/>.
    /// Always returns a (possibly partial) unit even when the source has syntax errors.
    /// </summary>
    internal static ParsedUnit ParseUnit(SourceFile file) => ParseUnit(file.Source, file.Path);

    /// <summary>
    /// Parses a source string with an optional file path (may be <c>null</c>) into a
    /// <see cref="ParsedUnit"/>. This overload preserves the null-file stamp used by the single-doc
    /// <see cref="KoineCompiler.Parse(string, string?)"/> and
    /// <see cref="KoineCompiler.Diagnose(string, string?)"/> paths so diagnostics carry a null
    /// <c>File</c> when no path is supplied — do NOT substitute a fabricated path here.
    /// </summary>
    internal static ParsedUnit ParseUnit(string source, string? file)
    {
        var hash = ComputeHash(source);
        var (contexts, relations, diagnostics) = ParseSource(source, file);
        return new ParsedUnit(hash, contexts, relations, diagnostics);
    }

    /// <summary>
    /// Merges same-named contexts into one (open/additive contexts, R13.1), preserving
    /// first-seen order. Mirrors <see cref="KoineCompiler"/>'s private Merge method exactly.
    /// </summary>
    internal static KoineModel Merge(IReadOnlyList<ContextNode> contexts, IReadOnlyList<ContextRelation> relations)
    {
        var order = new List<string>();
        var byName = new Dictionary<string, ContextNode>(StringComparer.Ordinal);

        foreach (var ctx in contexts)
        {
            if (byName.TryGetValue(ctx.Name, out var existing))
            {
                byName[ctx.Name] = existing with
                {
                    Imports = existing.Imports.Concat(ctx.Imports).ToList(),
                    Types = existing.Types.Concat(ctx.Types).ToList(),
                    Specs = existing.Specs.Concat(ctx.Specs).ToList(),
                    Services = existing.Services.Concat(ctx.Services).ToList(),
                    Policies = existing.Policies.Concat(ctx.Policies).ToList(),
                    ModuleNames = existing.ModuleNames.Concat(ctx.ModuleNames).ToList(),
                    Publishes = existing.Publishes.Concat(ctx.Publishes).ToList(),
                    Subscribes = existing.Subscribes.Concat(ctx.Subscribes).ToList(),
                    Doc = existing.Doc ?? ctx.Doc,
                    Version = existing.Version ?? ctx.Version
                };
            }
            else
            {
                order.Add(ctx.Name);
                byName[ctx.Name] = ctx;
            }
        }

        var map = relations.Count == 0 ? null : new ContextMapNode(relations.ToList());
        return new KoineModel(order.Select(n => byName[n]).ToList(), map);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private KoineModel BuildModel()
    {
        var allContexts = new List<ContextNode>();
        var allRelations = new List<ContextRelation>();

        foreach (var uri in _order)
        {
            var unit = _units[uri];
            allContexts.AddRange(unit.Contexts);
            allRelations.AddRange(unit.Relations);
        }

        return Merge(allContexts, allRelations);
    }

    private IReadOnlyList<Diagnostic> BuildDiagnostics()
    {
        var all = new List<Diagnostic>();
        foreach (var uri in _order)
        {
            all.AddRange(_units[uri].Diagnostics);
        }
        return all;
    }

    /// <summary>Computes a SHA-256 hex hash over the UTF-8 bytes of <paramref name="text"/>.</summary>
    private static string ComputeHash(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    /// <summary>
    /// Low-level two-stage SLL→LL parse: mirrors <see cref="KoineCompiler"/>'s private
    /// ParseUnit(string, string?) method exactly.
    /// </summary>
    private static (IReadOnlyList<ContextNode> Contexts, IReadOnlyList<ContextRelation> Relations, IReadOnlyList<Diagnostic> Diagnostics)
        ParseSource(string source, string? file)
    {
        var input = new AntlrInputStream(source);
        var listener = new SyntaxErrorListener(file);

        var lexer = new KoineLexer(input);
        lexer.RemoveErrorListeners();
        lexer.AddErrorListener(listener);

        var tokens = new CommonTokenStream(lexer);
        var parser = new KoineParser(tokens);
        parser.RemoveErrorListeners();

        KoineParser.ProgramContext tree;
        parser.Interpreter.PredictionMode = PredictionMode.SLL;
        parser.ErrorHandler = new BailErrorStrategy();
        try
        {
            tree = parser.program();
        }
        catch (ParseCanceledException)
        {
            parser.Reset();
            parser.ErrorHandler = new DefaultErrorStrategy();
            parser.AddErrorListener(listener);
            parser.Interpreter.PredictionMode = PredictionMode.LL;
            tree = parser.program();
        }

        var model = new KoineModelBuilderVisitor(tokens, file).BuildModel(tree);
        var relations = model.ContextMap?.Relations ?? Array.Empty<ContextRelation>();
        return (model.Contexts, relations, listener.Errors);
    }
}
