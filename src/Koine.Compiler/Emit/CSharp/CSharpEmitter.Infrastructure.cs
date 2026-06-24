using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The opt-in EF Core Infrastructure layer of <see cref="CSharpEmitter"/> (issue #128). Emitted only
/// when the <c>infrastructure</c> layer is requested (<see cref="CSharpEmitterOptions.EmitsInfrastructure"/>),
/// it realizes the persistence-ignorant contracts the Domain layer already produces: a
/// <c>&lt;Context&gt;DbContext</c>, one <c>IEntityTypeConfiguration&lt;Root&gt;</c> per aggregate (value
/// objects → owned types, the concurrency token → <c>IsRowVersion</c>, smart enums → value
/// conversions, strongly-typed IDs → key converters), concrete repositories, a unit of work, a
/// transactional outbox + dispatcher, and a DI registration extension.
///
/// <para>EF Core / DI are confined to this partial — <c>Ast/</c> stays target-agnostic. Every file is
/// deterministic (declaration order) and ends in a single trailing newline, like the rest of the
/// emitter. The layer is off by default, so the Domain output is byte-identical to today.</para>
/// </summary>
public sealed partial class CSharpEmitter
{
    /// <summary>The EF Core namespace a <c>DbContext</c> file needs.</summary>
    private static readonly string[] DbContextUsings = { "Microsoft.EntityFrameworkCore" };

    /// <summary>The EF Core namespaces an <c>IEntityTypeConfiguration</c> file needs.</summary>
    private static readonly string[] ConfigurationUsings =
    {
        "Microsoft.EntityFrameworkCore",
        "Microsoft.EntityFrameworkCore.Metadata.Builders",
    };

    /// <summary>The EF Core namespace a smart-enum <c>ValueConverter</c> holder needs.</summary>
    private static readonly string[] ValueConverterUsings = { "Microsoft.EntityFrameworkCore.Storage.ValueConversion" };

    /// <summary>
    /// Emits the Infrastructure layer for every bounded context that has at least one aggregate whose
    /// root is an entity (mirroring the Unit-of-Work gate). A context with no such aggregate produces
    /// no infrastructure — and a model with none produces nothing extra, without error.
    /// </summary>
    private void EmitInfrastructure(EmitContext emit, KoineModel model, List<EmittedFile> files, CSharpTypeMapper typeMapper)
    {
        ModelIndex index = emit.Index;
        foreach (ContextNode ctx in model.Contexts)
        {
            var aggregates = ctx.Types.OfType<AggregateDecl>()
                .Where(a => a.RootEntity() is not null)
                .ToList();
            if (aggregates.Count == 0)
            {
                continue;
            }

            // A context that publishes integration events gets a transactional outbox + dispatcher;
            // a subscribe-only (or event-free) context does not.
            var publishesEvents = ctx.Publishes.Count > 0;

            files.Add(EmitDbContext(emit, ctx.Name, aggregates, publishesEvents));

            // One shared smart-enum converter holder per context (issue #128): a smart enum used by
            // several aggregates is converted once and referenced from each configuration.
            var enums = CollectAggregateEnumTypes(ctx.Name, aggregates, index);
            if (enums.Count > 0)
            {
                files.Add(EmitValueConverters(emit, ctx.Name, enums));
            }

            foreach (AggregateDecl agg in aggregates)
            {
                files.Add(EmitEntityConfiguration(emit, ctx.Name, agg, index));
                files.Add(EmitRepositoryImpl(emit, ctx.Name, agg, typeMapper));
            }

            files.Add(EmitUnitOfWorkImpl(emit, ctx.Name, aggregates, publishesEvents));

            if (publishesEvents)
            {
                files.Add(EmitOutboxMessage(emit, ctx.Name));
                files.Add(EmitIntegrationEventHandlerSeam(emit, ctx.Name));
                files.Add(EmitIntegrationEventDispatcher(emit, ctx.Name));
            }

            files.Add(EmitServiceCollectionExtension(emit, ctx.Name, aggregates, publishesEvents));
        }
    }

    // ----------------------------------------------------------------------
    // DI registration
    // ----------------------------------------------------------------------

    /// <summary>The EF Core + DI namespaces the registration extension needs (plus System for <c>Action</c>).</summary>
    private static readonly string[] DiExtensionUsings =
    {
        "System",
        "Microsoft.EntityFrameworkCore",
        "Microsoft.Extensions.DependencyInjection",
    };

    /// <summary>
    /// Emits <c>Add&lt;Context&gt;Infrastructure(this IServiceCollection, Action&lt;DbContextOptionsBuilder&gt;)</c>:
    /// registers the <c>DbContext</c> (the caller supplies the provider via the options action, so the
    /// emitter stays provider-agnostic), each <c>I&lt;Root&gt;Repository → &lt;Root&gt;Repository</c>, the
    /// <c>IUnitOfWork → UnitOfWork</c>, and — for a publishing context — the dispatcher.
    /// </summary>
    private EmittedFile EmitServiceCollectionExtension(EmitContext emit, string context, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var className = context + "ServiceCollectionExtensions";
        var dbContext = context + "DbContext";
        var sb = new StringBuilder();

        WriteXmlDoc(sb, $"Registers the {context} infrastructure (DbContext, repositories, unit of work, dispatcher).", "");
        sb.Append("public static class ").Append(className).Append("\n{\n");
        sb.Append(Indent).Append("public static IServiceCollection Add").Append(context)
          .Append("Infrastructure(this IServiceCollection services, Action<DbContextOptionsBuilder> configureDbContext)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("services.AddDbContext<").Append(dbContext).Append(">(configureDbContext);\n");
        foreach (AggregateDecl agg in aggregates)
        {
            var root = agg.RootName;
            sb.Append(Indent).Append(Indent).Append("services.AddScoped<I").Append(root).Append("Repository, ")
              .Append(root).Append("Repository>();\n");
        }

        sb.Append(Indent).Append(Indent).Append("services.AddScoped<IUnitOfWork, UnitOfWork>();\n");
        if (publishesEvents)
        {
            sb.Append(Indent).Append(Indent).Append("services.AddScoped<IntegrationEventDispatcher>();\n");
        }

        sb.Append(Indent).Append(Indent).Append("return services;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, $"{className}.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: false, DiExtensionUsings));
    }

    // ----------------------------------------------------------------------
    // DbContext
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits <c>&lt;Context&gt;DbContext : DbContext</c> with one <c>DbSet&lt;Root&gt;</c> per aggregate
    /// root (declaration order) and an <c>OnModelCreating</c> that applies each generated
    /// <c>IEntityTypeConfiguration</c>.
    /// </summary>
    private EmittedFile EmitDbContext(EmitContext emit, string context, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var className = context + "DbContext";
        var sb = new StringBuilder();

        WriteXmlDoc(sb, $"EF Core persistence context for the {context} bounded context.", "");
        sb.Append("public class ").Append(className).Append(" : DbContext\n{\n");

        sb.Append(Indent).Append("public ").Append(className).Append("(DbContextOptions<").Append(className).Append("> options)\n");
        sb.Append(Indent).Append(Indent).Append(": base(options)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append("}\n\n");

        foreach (AggregateDecl agg in aggregates)
        {
            var root = agg.RootEntity()!.Name;
            sb.Append(Indent).Append("public DbSet<").Append(root).Append("> ").Append(Pluralize(root))
              .Append(" => Set<").Append(root).Append(">();\n");
        }

        // The transactional outbox table, when this context publishes integration events.
        if (publishesEvents)
        {
            sb.Append(Indent).Append("public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();\n");
        }

        sb.Append('\n');
        sb.Append(Indent).Append("protected override void OnModelCreating(ModelBuilder modelBuilder)\n");
        sb.Append(Indent).Append("{\n");
        foreach (AggregateDecl agg in aggregates)
        {
            var root = agg.RootEntity()!.Name;
            sb.Append(Indent).Append(Indent).Append("modelBuilder.ApplyConfiguration(new ").Append(root).Append("Configuration());\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append(Indent).Append("modelBuilder.Entity<OutboxMessage>().HasKey(x => x.Id);\n");
        }

        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, $"{className}.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: false, DbContextUsings));
    }

    // ----------------------------------------------------------------------
    // IEntityTypeConfiguration
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits <c>&lt;Root&gt;Configuration : IEntityTypeConfiguration&lt;Root&gt;</c>: the key + a
    /// strongly-typed-ID value converter, the concurrency token as <c>IsConcurrencyToken()</c>
    /// (versioned roots only), value-object members as owned types (<c>OwnsOne</c> / <c>OwnsMany</c>, nested →
    /// nested <c>OwnsOne</c>), smart-enum members via the shared <c>ValueConverter</c>, and foreign
    /// strongly-typed IDs as scalar converters. Plain primitives map by EF convention (no config).
    /// </summary>
    private EmittedFile EmitEntityConfiguration(EmitContext emit, string context, AggregateDecl agg, ModelIndex index)
    {
        EntityDecl root = agg.RootEntity()!;
        var rootName = root.Name;
        var idType = root.IdentityName;
        var configName = rootName + "Configuration";

        var memberNames = new HashSet<string>(root.Members.Select(m => m.Name), StringComparer.Ordinal);
        var persisted = root.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"EF Core mapping for the {rootName} aggregate root.", "");
        sb.Append("public sealed class ").Append(configName)
          .Append(" : IEntityTypeConfiguration<").Append(rootName).Append(">\n{\n");
        sb.Append(Indent).Append("public void Configure(EntityTypeBuilder<").Append(rootName).Append("> builder)\n");
        sb.Append(Indent).Append("{\n");

        // Identity: the aggregate's key, with a converter between the strongly-typed ID and its
        // backing primitive (the ID value object exposes Value and a single-arg constructor). A
        // store-assigned `sequence` key is additionally marked value-generated so EF lets the
        // database produce it (the ID value object has no client-side New()).
        sb.Append(Indent).Append(Indent).Append("builder.HasKey(x => x.Id);\n");
        sb.Append(Indent).Append(Indent).Append("builder.Property(x => x.Id)\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append(".HasConversion(id => id.Value, value => new ").Append(idType).Append("(value))");
        if (root.IdStrategy == IdentityStrategy.Sequence)
        {
            sb.Append('\n').Append(Indent).Append(Indent).Append(Indent).Append(".ValueGeneratedOnAdd()");
        }

        sb.Append(";\n");

        // Optimistic-concurrency token (versioned aggregate root only). Koine emits `int Version`, so
        // the EF mapping is IsConcurrencyToken() (an int compared on UPDATE) — NOT IsRowVersion(),
        // which requires a byte[]/rowversion column and would be an invalid model for an int property.
        if (agg.IsVersioned)
        {
            sb.Append(Indent).Append(Indent).Append("builder.Property(x => x.Version).IsConcurrencyToken();\n");
        }

        foreach (Member m in persisted)
        {
            WriteMemberMapping(sb, context, "builder", m, index, indentLevel: 2);
        }

        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, $"{configName}.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: false, ConfigurationUsings));
    }

    /// <summary>
    /// Writes the EF mapping for one persisted member onto <paramref name="builderVar"/> (the
    /// entity/owned builder in scope). The lambda selector is always <c>x</c>: each <c>Owns*</c>
    /// callback opens a fresh scope, so the inner <c>x</c> never shadows an enclosing one.
    /// </summary>
    private void WriteMemberMapping(StringBuilder sb, string context, string builderVar, Member m, ModelIndex index, int indentLevel)
    {
        var prop = CSharpNaming.ToPascalCase(m.Name);
        TypeRef type = m.Type;

        if (CSharpTypeMapper.IsList(type))
        {
            if (IsValueObjectList(type, index))
            {
                WriteOwned(sb, context, builderVar, "OwnsMany", prop, type.Element!.Name, index, indentLevel, depth: 1);
            }
            else
            {
                AppendIndent(sb, indentLevel).Append("// ").Append(prop)
                  .Append(" is a primitive collection, mapped by EF Core convention.\n");
            }

            return;
        }

        if (CSharpTypeMapper.IsSet(type) || CSharpTypeMapper.IsMap(type))
        {
            AppendIndent(sb, indentLevel).Append("// ").Append(prop)
              .Append(" is a collection, mapped by EF Core convention.\n");
            return;
        }

        switch (index.Classify(type.Name))
        {
            case TypeKind.Value:
                WriteOwned(sb, context, builderVar, "OwnsOne", prop, type.Name, index, indentLevel, depth: 1);
                break;
            case TypeKind.Enum:
                AppendIndent(sb, indentLevel).Append(builderVar).Append(".Property(x => x.").Append(prop)
                  .Append(").HasConversion(").Append(ValueConvertersClass(context)).Append('.')
                  .Append(type.Name).Append("Converter);\n");
                break;
            default:
                if (index.IdTypeNames.Contains(type.Name))
                {
                    // A foreign strongly-typed ID (e.g. customer: CustomerId): convert to its backing value.
                    AppendIndent(sb, indentLevel).Append(builderVar).Append(".Property(x => x.").Append(prop)
                      .Append(").HasConversion(v => v.Value, v => new ").Append(type.Name).Append("(v));\n");
                }
                else
                {
                    // A plain primitive: an explicit Property call so EF maps the get-only auto-property
                    // and materializes it via its backing field (issue #276). Left to convention, EF does
                    // not discover a read-only auto-property on a principal entity — the column is silently
                    // dropped and the value never round-trips. (Owned types already do this; this brings the
                    // root-entity mapping in line.)
                    AppendIndent(sb, indentLevel).Append(builderVar).Append(".Property(x => x.").Append(prop).Append(");\n");
                }

                break;
        }
    }

    /// <summary>
    /// Writes an owned-type mapping (<c>OwnsOne</c> or <c>OwnsMany</c>) for a value-object member,
    /// recursing into the value object's own members (nested value objects → nested <c>OwnsOne</c>,
    /// smart enums → conversions). An owned value object with only primitive members emits explicit
    /// <c>Property</c> lines for visibility; the mapping compiles even when the value object is empty.
    /// </summary>
    private void WriteOwned(StringBuilder sb, string context, string builderVar, string ownsMethod, string prop, string voTypeName, ModelIndex index, int indentLevel, int depth)
    {
        var owned = OwnedBuilderName(prop, depth);
        var ownsMany = ownsMethod == "OwnsMany";
        var vo = index.TryGetDeclIn(context, voTypeName, out TypeDecl decl) ? decl as ValueObjectDecl : null;
        AppendIndent(sb, indentLevel).Append(builderVar).Append('.').Append(ownsMethod)
          .Append("(x => x.").Append(prop).Append(", ").Append(owned).Append(" =>\n");
        AppendIndent(sb, indentLevel).Append("{\n");

        // A value-object collection (OwnsMany) gets an explicit single-column surrogate key so its rows
        // persist on every provider (issue #171): EF's default composite synthesized key relies on a
        // store-generated shadow ordinal, which SQLite — a common dev/test provider — cannot supply.
        if (ownsMany)
        {
            var key = OwnedSurrogateKeyName(vo);
            AppendIndent(sb, indentLevel + 1).Append(owned).Append(".Property<int>(\"").Append(key).Append("\").ValueGeneratedOnAdd();\n");
            AppendIndent(sb, indentLevel + 1).Append(owned).Append(".HasKey(\"").Append(key).Append("\");\n");
        }

        if (vo is not null)
        {
            var voMemberNames = new HashSet<string>(vo.Members.Select(mm => mm.Name), StringComparer.Ordinal);
            foreach (Member vm in vo.Members.Where(mm => !MemberAnalysis.IsDerived(mm, voMemberNames)))
            {
                WriteOwnedMemberMapping(sb, context, owned, vm, index, indentLevel + 1, depth);
            }
        }

        AppendIndent(sb, indentLevel).Append("});\n");

        // Field access so EF reads/writes the mutable backing list (issue #171); the domain exposes the
        // collection read-only (=> _coll), which EF cannot materialize owned children into otherwise.
        if (ownsMany)
        {
            AppendIndent(sb, indentLevel).Append(builderVar).Append(".Navigation(x => x.").Append(prop)
              .Append(").UsePropertyAccessMode(PropertyAccessMode.Field);\n");
        }
    }

    /// <summary>
    /// Maps one member of an owned value object. Nested value objects and smart enums recurse through
    /// the same rules as the root; a plain primitive emits an explicit <c>Property</c> call so the
    /// owned shape is visible in the generated configuration.
    /// </summary>
    private void WriteOwnedMemberMapping(StringBuilder sb, string context, string ownedVar, Member m, ModelIndex index, int indentLevel, int depth)
    {
        var prop = CSharpNaming.ToPascalCase(m.Name);
        TypeRef type = m.Type;

        if (CSharpTypeMapper.IsList(type) || CSharpTypeMapper.IsSet(type) || CSharpTypeMapper.IsMap(type))
        {
            if (IsValueObjectList(type, index))
            {
                WriteOwned(sb, context, ownedVar, "OwnsMany", prop, type.Element!.Name, index, indentLevel, depth + 1);
            }
            else
            {
                AppendIndent(sb, indentLevel).Append("// ").Append(prop)
                  .Append(" is a collection, mapped by EF Core convention.\n");
            }

            return;
        }

        switch (index.Classify(type.Name))
        {
            case TypeKind.Value:
                WriteOwned(sb, context, ownedVar, "OwnsOne", prop, type.Name, index, indentLevel, depth + 1);
                break;
            case TypeKind.Enum:
                AppendIndent(sb, indentLevel).Append(ownedVar).Append(".Property(x => x.").Append(prop)
                  .Append(").HasConversion(").Append(ValueConvertersClass(context)).Append('.')
                  .Append(type.Name).Append("Converter);\n");
                break;
            default:
                if (index.IdTypeNames.Contains(type.Name))
                {
                    AppendIndent(sb, indentLevel).Append(ownedVar).Append(".Property(x => x.").Append(prop)
                      .Append(").HasConversion(v => v.Value, v => new ").Append(type.Name).Append("(v));\n");
                }
                else
                {
                    AppendIndent(sb, indentLevel).Append(ownedVar).Append(".Property(x => x.").Append(prop).Append(");\n");
                }

                break;
        }
    }

    // ----------------------------------------------------------------------
    // Smart-enum value converters (one shared holder per context)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits <c>&lt;Context&gt;ValueConverters</c>: a static holder with one
    /// <c>ValueConverter&lt;Enum, string&gt;</c> per smart enum any aggregate persists, round-tripping
    /// via <c>Name</c> / <c>FromName</c>. A single converter is shared by every configuration that maps
    /// the enum.
    /// </summary>
    private EmittedFile EmitValueConverters(EmitContext emit, string context, IReadOnlyList<string> enumTypes)
    {
        var className = ValueConvertersClass(context);
        var sb = new StringBuilder();

        WriteXmlDoc(sb, $"Shared EF Core value converters for the {context} context's smart enums.", "");
        sb.Append("public static class ").Append(className).Append("\n{\n");

        var first = true;
        foreach (var enumType in enumTypes)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            sb.Append(Indent).Append("public static readonly ValueConverter<").Append(enumType)
              .Append(", string> ").Append(enumType).Append("Converter =\n");
            sb.Append(Indent).Append(Indent).Append("new(v => v.Name, v => ").Append(enumType).Append(".FromName(v));\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, $"{className}.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: false, ValueConverterUsings));
    }

    /// <summary>The smart-enum value-converter holder class name for a context.</summary>
    private static string ValueConvertersClass(string context) => context + "ValueConverters";

    /// <summary>
    /// The distinct smart-enum type names any aggregate in the context persists, in first-seen
    /// declaration order, walking through owned value objects (so a converter exists for every enum a
    /// configuration references).
    /// </summary>
    private static IReadOnlyList<string> CollectAggregateEnumTypes(string context, IReadOnlyList<AggregateDecl> aggregates, ModelIndex index)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<string>();

        void Walk(IReadOnlyList<Member> members)
        {
            var names = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
            foreach (Member m in members.Where(mm => !MemberAnalysis.IsDerived(mm, names)))
            {
                TypeRef type = m.Type;
                var isList = CSharpTypeMapper.IsList(type);
                var typeName = isList ? type.Element?.Name : type.Name;
                if (typeName is null)
                {
                    continue;
                }

                switch (index.Classify(typeName))
                {
                    // A *scalar* smart-enum member is mapped via HasConversion, so it needs a converter.
                    // A List<Enum> is emitted as a primitive collection (no HasConversion), so collecting
                    // its element would produce a dead, never-referenced converter — skip it.
                    case TypeKind.Enum when !isList:
                        if (seen.Add(typeName))
                        {
                            ordered.Add(typeName);
                        }

                        break;
                    case TypeKind.Value:
                        // Both a scalar value object (OwnsOne) and a value-object collection (OwnsMany)
                        // recurse, so enums inside them ARE mapped and DO need converters.
                        if (index.TryGetDeclIn(context, typeName, out TypeDecl decl) && decl is ValueObjectDecl vo)
                        {
                            Walk(vo.Members);
                        }

                        break;
                }
            }
        }

        foreach (AggregateDecl agg in aggregates)
        {
            Walk(agg.RootEntity()!.Members);
        }

        return ordered;
    }

    /// <summary>
    /// The owned-builder lambda parameter for a property at nesting <paramref name="depth"/>. Its
    /// camelCase (never the <c>x</c> selector); beyond the first owned level the depth is appended so a
    /// value object nested under a same-named member can't shadow its enclosing builder parameter
    /// (CS0136). The first level keeps the clean, unsuffixed name.
    /// </summary>
    private static string OwnedBuilderName(string prop, int depth)
    {
        var name = CSharpNaming.ToCamelCase(prop);
        if (name == "x")
        {
            name = "owned";
        }

        return depth <= 1 ? name : name + depth;
    }

    /// <summary>
    /// The shadow primary-key name for an owned value-object collection's surrogate key (issue #171),
    /// defaulting to <c>Id</c> but disambiguated (<c>OwnedId</c>, …) when the value object already maps a
    /// member of that name — otherwise EF would reject two properties named <c>Id</c> with different CLR
    /// types. A null decl (unresolved type) keeps the plain <c>Id</c>; it has no mapped members to clash.
    /// </summary>
    private static string OwnedSurrogateKeyName(ValueObjectDecl? vo)
    {
        if (vo is null)
        {
            return "Id";
        }

        var taken = new HashSet<string>(vo.Members.Select(m => CSharpNaming.ToPascalCase(m.Name)), StringComparer.Ordinal);
        var name = "Id";
        while (taken.Contains(name))
        {
            name = "Owned" + name;
        }

        return name;
    }

    /// <summary>Appends <paramref name="indentLevel"/> indents to the builder and returns it for chaining.</summary>
    private static StringBuilder AppendIndent(StringBuilder sb, int indentLevel)
    {
        for (var i = 0; i < indentLevel; i++)
        {
            sb.Append(CSharpEmitter.Indent);
        }

        return sb;
    }
}
