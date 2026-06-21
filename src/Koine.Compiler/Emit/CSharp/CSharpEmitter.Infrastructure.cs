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
    /// <summary>The EF Core namespace a <see cref="DbContext"/> file needs.</summary>
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
        }
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
    /// strongly-typed-ID value converter, the concurrency token as <c>IsRowVersion()</c> (versioned
    /// roots only), value-object members as owned types (<c>OwnsOne</c> / <c>OwnsMany</c>, nested →
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
        // backing primitive (the ID value object exposes Value and a single-arg constructor).
        sb.Append(Indent).Append(Indent).Append("builder.HasKey(x => x.Id);\n");
        sb.Append(Indent).Append(Indent).Append("builder.Property(x => x.Id)\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append(".HasConversion(id => id.Value, value => new ").Append(idType).Append("(value));\n");

        // Optimistic-concurrency token (versioned aggregate root only).
        if (agg.IsVersioned)
        {
            sb.Append(Indent).Append(Indent).Append("builder.Property(x => x.Version).IsRowVersion();\n");
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
            var elem = type.Element?.Name;
            if (elem is not null && index.Classify(elem) == TypeKind.Value)
            {
                WriteOwned(sb, context, builderVar, "OwnsMany", prop, elem, index, indentLevel);
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
                WriteOwned(sb, context, builderVar, "OwnsOne", prop, type.Name, index, indentLevel);
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

                // A plain primitive maps by EF Core convention — no explicit configuration.
                break;
        }
    }

    /// <summary>
    /// Writes an owned-type mapping (<c>OwnsOne</c> or <c>OwnsMany</c>) for a value-object member,
    /// recursing into the value object's own members (nested value objects → nested <c>OwnsOne</c>,
    /// smart enums → conversions). An owned value object with only primitive members emits explicit
    /// <c>Property</c> lines for visibility; the mapping compiles even when the value object is empty.
    /// </summary>
    private void WriteOwned(StringBuilder sb, string context, string builderVar, string ownsMethod, string prop, string voTypeName, ModelIndex index, int indentLevel)
    {
        var owned = OwnedBuilderName(prop);
        AppendIndent(sb, indentLevel).Append(builderVar).Append('.').Append(ownsMethod)
          .Append("(x => x.").Append(prop).Append(", ").Append(owned).Append(" =>\n");
        AppendIndent(sb, indentLevel).Append("{\n");

        if (index.TryGetDeclIn(context, voTypeName, out TypeDecl decl) && decl is ValueObjectDecl vo)
        {
            var voMemberNames = new HashSet<string>(vo.Members.Select(mm => mm.Name), StringComparer.Ordinal);
            foreach (Member vm in vo.Members.Where(mm => !MemberAnalysis.IsDerived(mm, voMemberNames)))
            {
                WriteOwnedMemberMapping(sb, context, owned, vm, index, indentLevel + 1);
            }
        }

        AppendIndent(sb, indentLevel).Append("});\n");
    }

    /// <summary>
    /// Maps one member of an owned value object. Nested value objects and smart enums recurse through
    /// the same rules as the root; a plain primitive emits an explicit <c>Property</c> call so the
    /// owned shape is visible in the generated configuration.
    /// </summary>
    private void WriteOwnedMemberMapping(StringBuilder sb, string context, string ownedVar, Member m, ModelIndex index, int indentLevel)
    {
        var prop = CSharpNaming.ToPascalCase(m.Name);
        TypeRef type = m.Type;

        if (CSharpTypeMapper.IsList(type) || CSharpTypeMapper.IsSet(type) || CSharpTypeMapper.IsMap(type))
        {
            var elem = type.Element?.Name;
            if (CSharpTypeMapper.IsList(type) && elem is not null && index.Classify(elem) == TypeKind.Value)
            {
                WriteOwned(sb, context, ownedVar, "OwnsMany", prop, elem, index, indentLevel);
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
                WriteOwned(sb, context, ownedVar, "OwnsOne", prop, type.Name, index, indentLevel);
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
                var typeName = CSharpTypeMapper.IsList(type) ? type.Element?.Name : type.Name;
                if (typeName is null)
                {
                    continue;
                }

                switch (index.Classify(typeName))
                {
                    case TypeKind.Enum:
                        if (seen.Add(typeName))
                        {
                            ordered.Add(typeName);
                        }

                        break;
                    case TypeKind.Value:
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

    /// <summary>The owned-builder lambda parameter for a property — its camelCase, never colliding with the <c>x</c> selector.</summary>
    private static string OwnedBuilderName(string prop)
    {
        var name = CSharpNaming.ToCamelCase(prop);
        return name == "x" ? "owned" : name;
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
