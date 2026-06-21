using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The repository + unit-of-work slice of the EF Core Infrastructure layer (issue #128): concrete
/// realizations of the <c>I&lt;Root&gt;Repository</c> and per-context <c>IUnitOfWork</c> contracts the
/// Domain layer already emits, backed by the generated <c>&lt;Context&gt;DbContext</c>. Declarative
/// finders become convention-based EF Core queries (equality on each parameter that matches a root
/// property); a versioned aggregate's save maps EF's optimistic-concurrency failure to the
/// already-emitted <c>ConcurrencyConflictException</c>.
/// </summary>
public sealed partial class CSharpEmitter
{
    /// <summary>The EF Core namespace the finder queries (<c>ToListAsync</c>/<c>FirstOrDefaultAsync</c>) need.</summary>
    private static readonly string[] RepositoryQueryUsings = { "Microsoft.EntityFrameworkCore" };

    /// <summary>The EF Core + runtime namespaces the concurrency-aware unit of work needs.</summary>
    private static readonly string[] VersionedUnitOfWorkUsings = { "Microsoft.EntityFrameworkCore", RuntimeNamespace };

    // ----------------------------------------------------------------------
    // Repository
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits <c>&lt;Root&gt;Repository : I&lt;Root&gt;Repository</c> over the context's
    /// <c>DbContext</c>: <c>GetByIdAsync</c> via <c>FindAsync</c>, the configured add/update/remove
    /// (<c>RepositoryDecl.Operations</c>, default add/update/remove), and each <c>FinderDecl</c> as a
    /// convention-based query. The <c>Update</c>/<c>Remove</c> of a versioned root flow EF's row
    /// version through, so a stale save surfaces as a concurrency conflict at <c>SaveChangesAsync</c>.
    /// </summary>
    private EmittedFile EmitRepositoryImpl(EmitContext emit, string context, AggregateDecl agg, CSharpTypeMapper typeMapper)
    {
        EntityDecl root = agg.RootEntity()!;
        var rootName = root.Name;
        var idType = root.IdentityName;
        var iface = $"I{rootName}Repository";
        var className = $"{rootName}Repository";
        var dbContext = context + "DbContext";
        var set = Pluralize(rootName);
        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();

        var rootProps = new HashSet<string>(
            root.Members.Select(m => CSharpNaming.ToPascalCase(m.Name)), StringComparer.Ordinal) { "Id" };

        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"EF Core repository for the {rootName} aggregate root.", "");
        sb.Append("public sealed class ").Append(className).Append(" : ").Append(iface).Append("\n{\n");
        sb.Append(Indent).Append("private readonly ").Append(dbContext).Append(" _context;\n\n");
        sb.Append(Indent).Append("public ").Append(className).Append('(').Append(dbContext).Append(" context)\n");
        sb.Append(Indent).Append(Indent).Append("=> _context = context;\n");

        if (ops.Contains("getById"))
        {
            sb.Append('\n');
            sb.Append(Indent).Append("public async Task<").Append(rootName).Append("?> GetByIdAsync(")
              .Append(idType).Append(" id, CancellationToken ct = default)\n");
            sb.Append(Indent).Append(Indent).Append("=> await _context.").Append(set).Append(".FindAsync(new object?[] { id }, ct);\n");
        }

        if (ops.Contains("add"))
        {
            sb.Append('\n');
            sb.Append(Indent).Append("public async Task AddAsync(").Append(rootName).Append(" aggregate, CancellationToken ct = default)\n");
            sb.Append(Indent).Append(Indent).Append("=> await _context.").Append(set).Append(".AddAsync(aggregate, ct);\n");
        }

        if (ops.Contains("update"))
        {
            WriteSyncMutation(sb, set, "UpdateAsync", "Update", rootName);
        }

        if (ops.Contains("remove"))
        {
            WriteSyncMutation(sb, set, "RemoveAsync", "Remove", rootName);
        }

        foreach (FinderDecl finder in finders)
        {
            WriteFinderImpl(sb, set, rootName, finder, rootProps, typeMapper);
        }

        sb.Append("}\n");

        var body = sb.ToString();
        // Finder queries pull in EF's async LINQ operators; CRUD-only repositories need no EF using
        // (Find/Add/Update/Remove are DbSet instance methods). System.Linq follows the `.Where(` scan.
        var requiredUsings = finders.Count > 0 ? RepositoryQueryUsings : Array.Empty<string>();
        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, $"{className}.cs"),
            Assemble(emit, context, body, usesLinq: body.Contains(".Where(", StringComparison.Ordinal), requiredUsings));
    }

    /// <summary>Writes a synchronous mutating op (<c>Update</c>/<c>Remove</c>) returning a completed task.</summary>
    private static void WriteSyncMutation(StringBuilder sb, string set, string method, string dbSetCall, string rootName)
    {
        sb.Append('\n');
        sb.Append(Indent).Append("public Task ").Append(method).Append('(').Append(rootName).Append(" aggregate, CancellationToken ct = default)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("_context.").Append(set).Append('.').Append(dbSetCall).Append("(aggregate);\n");
        sb.Append(Indent).Append(Indent).Append("return Task.CompletedTask;\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Writes a declarative finder as a convention-based EF Core query: each parameter that matches a
    /// root property (by PascalCase name) becomes an equality filter; a list finder returns
    /// <c>ToListAsync</c>, a single finder <c>FirstOrDefaultAsync</c>. A parameter with no matching
    /// property is left in the signature for the developer to wire up (the generated query ignores it).
    /// </summary>
    private void WriteFinderImpl(StringBuilder sb, string set, string rootName, FinderDecl finder, ISet<string> rootProps, CSharpTypeMapper typeMapper)
    {
        var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
        var method = CSharpNaming.ToPascalCase(finder.Name) + "Async";
        var paramList = string.Join(", ", finder.Parameters.Select(p =>
            $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
        if (paramList.Length > 0)
        {
            paramList += ", ";
        }

        var predicate = string.Join(" && ", finder.Parameters
            .Where(p => rootProps.Contains(CSharpNaming.ToPascalCase(p.Name)))
            .Select(p => $"x.{CSharpNaming.ToPascalCase(p.Name)} == {CSharpNaming.ToCamelCase(p.Name)}"));

        sb.Append('\n');
        if (isList)
        {
            sb.Append(Indent).Append("public async Task<IReadOnlyList<").Append(rootName).Append(">> ")
              .Append(method).Append('(').Append(paramList).Append("CancellationToken ct = default)\n");
            sb.Append(Indent).Append(Indent).Append("=> await _context.").Append(set);
            if (predicate.Length > 0)
            {
                sb.Append(".Where(x => ").Append(predicate).Append(')');
            }

            sb.Append(".ToListAsync(ct);\n");
        }
        else
        {
            sb.Append(Indent).Append("public Task<").Append(rootName).Append("?> ")
              .Append(method).Append('(').Append(paramList).Append("CancellationToken ct = default)\n");
            sb.Append(Indent).Append(Indent).Append("=> _context.").Append(set).Append(".FirstOrDefaultAsync(");
            if (predicate.Length > 0)
            {
                sb.Append("x => ").Append(predicate).Append(", ");
            }

            sb.Append("ct);\n");
        }
    }

    // ----------------------------------------------------------------------
    // Unit of work
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits <c>UnitOfWork : IUnitOfWork</c> over the context's <c>DbContext</c>: one repository
    /// property per aggregate (declaration order, pluralized like the contract) plus
    /// <c>SaveChangesAsync</c>. When the context has a versioned aggregate, a stale write is caught and
    /// rethrown as the runtime <c>ConcurrencyConflictException</c>.
    /// </summary>
    private EmittedFile EmitUnitOfWorkImpl(EmitContext emit, string context, IReadOnlyList<AggregateDecl> aggregates)
    {
        var dbContext = context + "DbContext";
        var hasVersioned = aggregates.Any(a => a.IsVersioned);

        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"EF Core unit of work over the {dbContext}.", "");
        sb.Append("public sealed class UnitOfWork : IUnitOfWork\n{\n");
        sb.Append(Indent).Append("private readonly ").Append(dbContext).Append(" _context;\n\n");

        // Constructor: the DbContext plus a repository per aggregate (injected, so a test can swap them).
        sb.Append(Indent).Append("public UnitOfWork(").Append(dbContext).Append(" context");
        foreach (AggregateDecl agg in aggregates)
        {
            var prop = Pluralize(agg.RootName);
            sb.Append(", I").Append(agg.RootName).Append("Repository ").Append(CSharpNaming.ToCamelCase(prop));
        }

        sb.Append(")\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("_context = context;\n");
        foreach (AggregateDecl agg in aggregates)
        {
            var prop = Pluralize(agg.RootName);
            sb.Append(Indent).Append(Indent).Append(prop).Append(" = ").Append(CSharpNaming.ToCamelCase(prop)).Append(";\n");
        }

        sb.Append(Indent).Append("}\n\n");

        foreach (AggregateDecl agg in aggregates)
        {
            sb.Append(Indent).Append("public I").Append(agg.RootName).Append("Repository ")
              .Append(Pluralize(agg.RootName)).Append(" { get; }\n");
        }

        sb.Append('\n');
        if (hasVersioned)
        {
            WriteConcurrencyAwareSave(sb);
        }
        else
        {
            sb.Append(Indent).Append("public Task<int> SaveChangesAsync(CancellationToken ct = default)\n");
            sb.Append(Indent).Append(Indent).Append("=> _context.SaveChangesAsync(ct);\n");
        }

        sb.Append("}\n");

        var requiredUsings = hasVersioned ? VersionedUnitOfWorkUsings : Array.Empty<string>();
        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, "UnitOfWork.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: false, requiredUsings));
    }

    /// <summary>
    /// Writes a <c>SaveChangesAsync</c> that maps EF Core's <c>DbUpdateConcurrencyException</c> to the
    /// runtime <c>ConcurrencyConflictException</c>, reading the expected/actual <c>Version</c> from the
    /// conflicting entry — the realization of the optimistic-concurrency token a versioned root carries.
    /// </summary>
    private static void WriteConcurrencyAwareSave(StringBuilder sb)
    {
        sb.Append(Indent).Append("public async Task<int> SaveChangesAsync(CancellationToken ct = default)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("try\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("return await _context.SaveChangesAsync(ct);\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("catch (DbUpdateConcurrencyException ex)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var entry = ex.Entries[0];\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var expected = (int)(entry.Property(\"Version\").CurrentValue ?? 0);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var databaseValues = await entry.GetDatabaseValuesAsync(ct);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var actual = databaseValues is null ? 0 : (int)(databaseValues[\"Version\"] ?? 0);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new ConcurrencyConflictException(entry.Metadata.DisplayName(), expected, actual);\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");
    }
}
