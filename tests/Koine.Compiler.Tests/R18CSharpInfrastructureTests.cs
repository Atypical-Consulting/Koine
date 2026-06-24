using System.Collections;
using System.Reflection;
using System.Text.RegularExpressions;
using Koine.Cli;
using Koine.Cli.Commands;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// R18: the opt-in C# Infrastructure layer (issue #128). The layer is selected via
/// <c>--layers domain,infrastructure</c> (CLI) / <c>targets.csharp.layers</c> (config) and threads
/// <c>KoineConfig</c>/<c>TargetOptions</c> → neutral <c>EmitterOptions</c> →
/// <c>CSharpEmitterOptions</c> → <c>CSharpEmitter</c>. Default = Domain-only, so output is
/// byte-identical to today when the layer is off.
/// </summary>
public class R18CSharpInfrastructureTests
{
    // A representative model: two contexts, a versioned aggregate, a value object, a smart enum,
    // an integration event published across an open-host relation, and a subscriber.
    private const string Fixture = """
        context Sales {
          enum OrderStatus { Pending, Paid, Shipped }
          value Money { amount: Decimal  currency: String }
          aggregate Order root Order versioned {
            repository {
              find byStatus(status: OrderStatus): List<Order>
              find mostRecent(status: OrderStatus): Order
            }
            entity Order identified by OrderId {
              total: Money
              status: OrderStatus
            }
          }
          publishes OrderPlaced
          integration event OrderPlaced { orderId: OrderId  total: Decimal }
        }
        context Shipping {
          subscribes Sales.OrderPlaced
          value Address { city: String }
          aggregate Shipment root Shipment {
            entity Shipment identified by ShipmentId { address: Address }
          }
        }
        contextmap {
          Sales -> Shipping : open-host
        }
        """;

    private static IReadOnlyList<EmittedFile> Emit(CSharpEmitterOptions options)
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    // ----------------------------------------------------------------------
    // Default = Domain-only ⇒ byte-identical to the unconfigured emitter
    // ----------------------------------------------------------------------

    [Fact]
    public void Default_options_are_domain_only()
    {
        CSharpEmitterOptions.Empty.EmitsInfrastructure.ShouldBeFalse();
        new CSharpEmitter().GetType().ShouldBe(typeof(CSharpEmitter)); // sanity
    }

    [Fact]
    public void Domain_only_layer_is_byte_identical_to_default_emitter()
    {
        var defaultRender = TestSupport.Render(
            new KoineCompiler().Compile(Fixture, new CSharpEmitter()).Files);

        var domainOnly = TestSupport.Render(Emit(new CSharpEmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal),
            Layers: new HashSet<CSharpLayer> { CSharpLayer.Domain })));

        domainOnly.ShouldBe(defaultRender);
    }

    [Fact]
    public void Empty_options_layer_is_byte_identical_to_default_emitter()
    {
        var defaultRender = TestSupport.Render(
            new KoineCompiler().Compile(Fixture, new CSharpEmitter()).Files);

        TestSupport.Render(Emit(CSharpEmitterOptions.Empty)).ShouldBe(defaultRender);
    }

    // ----------------------------------------------------------------------
    // Config / options / CLI plumbing
    // ----------------------------------------------------------------------

    [Fact]
    public void Config_parses_layers_key()
    {
        var cfg = KoineConfig.Parse(
            "target = csharp\n" +
            "targets.csharp.layers = domain,infrastructure\n");

        cfg.OptionsFor("csharp").Layers.ShouldBe(new[] { "domain", "infrastructure" });
    }

    [Fact]
    public void Layers_flag_overrides_config_and_implies_domain()
    {
        // No --layers: config drives it; infrastructure implies domain.
        var settings = new BuildSettings { Path = "x.koi", Layers = "infrastructure" };
        settings.TryResolve(out var plan, out var error).ShouldBeTrue(error);
        plan.Options.Layers.ShouldBe(new[] { "domain", "infrastructure" });
    }

    [Fact]
    public void Unknown_layer_is_a_hard_error()
    {
        var settings = new BuildSettings { Path = "x.koi", Layers = "domain,bogus" };
        settings.TryResolve(out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNull();
        error.ShouldContain("bogus");
    }

    [Fact]
    public void Infrastructure_layer_option_threads_through_to_emitter_options()
    {
        var neutral = new EmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal),
            Layers: "domain,infrastructure");
        neutral.Layers.ShouldBe("domain,infrastructure");
    }

    // ----------------------------------------------------------------------
    // EF Core + DI are reachable by the Roslyn meta-test (so generated infra compiles)
    // ----------------------------------------------------------------------

    [Fact]
    public void Ef_core_and_di_are_referenceable_by_the_roslyn_meta_test()
    {
        // The generated Infrastructure layer references Microsoft.EntityFrameworkCore and
        // Microsoft.Extensions.DependencyInjection — neither ships in the running framework's
        // reference set, so this proves the test project's package references land in TPA and the
        // Roslyn compile harness can therefore type-check the generated EF Core code.
        var snippet = """
            // <auto-generated/>
            #nullable enable
            using Microsoft.EntityFrameworkCore;
            using Microsoft.Extensions.DependencyInjection;

            namespace Probe;

            public sealed class ProbeDbContext : DbContext
            {
                public ProbeDbContext(DbContextOptions<ProbeDbContext> options) : base(options) { }
            }

            public static class ProbeRegistration
            {
                public static IServiceCollection AddProbe(this IServiceCollection services)
                    => services;
            }
            """;

        var (asm, errors) = TestSupport.Compile(new[] { new EmittedFile("Probe.cs", snippet) });
        asm.ShouldNotBeNull(string.Join("\n", errors));
    }

    // ----------------------------------------------------------------------
    // DbContext + entity configurations (Task 3)
    // ----------------------------------------------------------------------

    private static readonly CSharpEmitterOptions Infrastructure = new(
        new Dictionary<string, string>(StringComparer.Ordinal),
        Layers: new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Infrastructure });

    private static EmittedFile File(IReadOnlyList<EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal));

    [Fact]
    public void Infrastructure_emits_a_dbcontext_with_a_dbset_per_aggregate()
    {
        var files = Emit(Infrastructure);
        var db = File(files, "Sales/Infrastructure/SalesDbContext.cs");

        db.Contents.ShouldContain("public class SalesDbContext : DbContext");
        db.Contents.ShouldContain("public DbSet<Order> Orders => Set<Order>();");
        db.Contents.ShouldContain("modelBuilder.ApplyConfiguration(new OrderConfiguration());");
        db.Contents.ShouldContain("using Microsoft.EntityFrameworkCore;");
    }

    [Fact]
    public void Entity_configuration_maps_key_owned_type_rowversion_and_enum()
    {
        var files = Emit(Infrastructure);
        var cfg = File(files, "Sales/Infrastructure/OrderConfiguration.cs");

        cfg.Contents.ShouldContain("public sealed class OrderConfiguration : IEntityTypeConfiguration<Order>");
        cfg.Contents.ShouldContain("builder.HasKey(x => x.Id);");
        cfg.Contents.ShouldContain(".HasConversion(id => id.Value, value => new OrderId(value));");
        cfg.Contents.ShouldContain("builder.Property(x => x.Version).IsConcurrencyToken();");
        // Value object → owned type.
        cfg.Contents.ShouldContain("builder.OwnsOne(x => x.Total,");
        // Smart enum → shared value converter.
        cfg.Contents.ShouldContain("builder.Property(x => x.Status).HasConversion(SalesValueConverters.OrderStatusConverter);");
    }

    [Fact]
    public void Infrastructure_emits_a_shared_value_converter_per_smart_enum()
    {
        var files = Emit(Infrastructure);
        var conv = File(files, "Sales/Infrastructure/SalesValueConverters.cs");

        conv.Contents.ShouldContain("public static class SalesValueConverters");
        conv.Contents.ShouldContain("public static readonly ValueConverter<OrderStatus, string> OrderStatusConverter =");
        conv.Contents.ShouldContain("new(v => v.Name, v => OrderStatus.FromName(v));");
    }

    // ----------------------------------------------------------------------
    // Concrete repositories + UnitOfWork (Task 4)
    // ----------------------------------------------------------------------

    [Fact]
    public void Repository_implements_crud_and_finders_over_the_dbcontext()
    {
        var files = Emit(Infrastructure);
        var repo = File(files, "Sales/Infrastructure/OrderRepository.cs");

        repo.Contents.ShouldContain("public sealed class OrderRepository : IOrderRepository");
        repo.Contents.ShouldContain("private readonly SalesDbContext _context;");
        repo.Contents.ShouldContain("public async Task<Order?> GetByIdAsync(OrderId id, CancellationToken ct = default)");
        repo.Contents.ShouldContain("=> await _context.Orders.FindAsync(new object?[] { id }, ct);");
        repo.Contents.ShouldContain("public async Task AddAsync(Order aggregate, CancellationToken ct = default)");
        repo.Contents.ShouldContain("_context.Orders.Update(aggregate);");
        repo.Contents.ShouldContain("_context.Orders.Remove(aggregate);");
        // List finder → convention Where + ToListAsync; single finder → FirstOrDefaultAsync.
        repo.Contents.ShouldContain("public async Task<IReadOnlyList<Order>> ByStatusAsync(OrderStatus status, CancellationToken ct = default)");
        repo.Contents.ShouldContain("=> await _context.Orders.Where(x => x.Status == status).ToListAsync(ct);");
        repo.Contents.ShouldContain("=> _context.Orders.FirstOrDefaultAsync(x => x.Status == status, ct);");
    }

    [Fact]
    public void Unit_of_work_exposes_a_repository_per_aggregate_and_saves()
    {
        var files = Emit(Infrastructure);
        var uow = File(files, "Sales/Infrastructure/UnitOfWork.cs");

        uow.Contents.ShouldContain("public sealed class UnitOfWork : IUnitOfWork");
        uow.Contents.ShouldContain("public IOrderRepository Orders { get; }");
        uow.Contents.ShouldContain("public async Task<int> SaveChangesAsync(CancellationToken ct = default)");
        // Versioned context maps EF's concurrency failure to the runtime exception.
        uow.Contents.ShouldContain("catch (DbUpdateConcurrencyException ex)");
        uow.Contents.ShouldContain("throw new ConcurrencyConflictException(entry.Metadata.DisplayName(), expected, actual);");
    }

    [Fact]
    public void Unversioned_context_has_a_plain_save_with_no_concurrency_handling()
    {
        const string unversioned = """
            context Catalog {
              value Sku { code: String }
              aggregate Product root Product {
                entity Product identified by ProductId { sku: Sku }
              }
            }
            """;
        var result = new KoineCompiler().Compile(unversioned, new CSharpEmitter(Infrastructure));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var uow = File(result.Files, "Catalog/Infrastructure/UnitOfWork.cs");

        uow.Contents.ShouldContain("=> _context.SaveChangesAsync(ct);");
        uow.Contents.ShouldNotContain("DbUpdateConcurrencyException");
    }

    // ----------------------------------------------------------------------
    // Transactional outbox + dispatcher (Task 5)
    // ----------------------------------------------------------------------

    [Fact]
    public void Publishing_context_emits_outbox_and_dispatcher()
    {
        var files = Emit(Infrastructure);

        files.ShouldContain(f => f.RelativePath == "Sales/Infrastructure/OutboxMessage.cs");
        files.ShouldContain(f => f.RelativePath == "Sales/Infrastructure/IntegrationEventDispatcher.cs");
        files.ShouldContain(f => f.RelativePath == "Sales/Abstractions/IIntegrationEventHandler.cs");

        // The DbContext gains the outbox table; the UnitOfWork gains the enqueue seam + flush.
        File(files, "Sales/Infrastructure/SalesDbContext.cs").Contents
            .ShouldContain("public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();");
        var uow = File(files, "Sales/Infrastructure/UnitOfWork.cs").Contents;
        uow.ShouldContain("public void Enqueue(IIntegrationEvent integrationEvent)");
        uow.ShouldContain("_context.Set<OutboxMessage>().Add(OutboxMessage.From(integrationEvent));");

        // The dispatcher drains unprocessed rows and hands each to the delivery seam.
        var dispatcher = File(files, "Sales/Infrastructure/IntegrationEventDispatcher.cs").Contents;
        dispatcher.ShouldContain("public sealed class IntegrationEventDispatcher");
        dispatcher.ShouldContain(".Where(m => m.ProcessedOn == null)");
        dispatcher.ShouldContain("await _handler.HandleAsync(integrationEvent, ct);");
    }

    [Fact]
    public void Subscribe_only_context_has_no_outbox_or_dispatcher()
    {
        var files = Emit(Infrastructure);

        // Shipping has an aggregate (so it gets a DbContext + UoW) but only subscribes — no outbox.
        files.ShouldContain(f => f.RelativePath == "Shipping/Infrastructure/ShippingDbContext.cs");
        files.ShouldNotContain(f => f.RelativePath == "Shipping/Infrastructure/OutboxMessage.cs");
        files.ShouldNotContain(f => f.RelativePath == "Shipping/Infrastructure/IntegrationEventDispatcher.cs");

        File(files, "Shipping/Infrastructure/ShippingDbContext.cs").Contents
            .ShouldNotContain("OutboxMessage");
        File(files, "Shipping/Infrastructure/UnitOfWork.cs").Contents
            .ShouldNotContain("Enqueue");
    }

    // ----------------------------------------------------------------------
    // DI registration extension (Task 6)
    // ----------------------------------------------------------------------

    [Fact]
    public void Di_extension_registers_dbcontext_repositories_uow_and_dispatcher()
    {
        var files = Emit(Infrastructure);
        var di = File(files, "Sales/Infrastructure/SalesServiceCollectionExtensions.cs").Contents;

        di.ShouldContain("public static class SalesServiceCollectionExtensions");
        di.ShouldContain("public static IServiceCollection AddSalesInfrastructure(this IServiceCollection services, Action<DbContextOptionsBuilder> configureDbContext)");
        di.ShouldContain("services.AddDbContext<SalesDbContext>(configureDbContext);");
        di.ShouldContain("services.AddScoped<IOrderRepository, OrderRepository>();");
        di.ShouldContain("services.AddScoped<IUnitOfWork, UnitOfWork>();");
        di.ShouldContain("services.AddScoped<IntegrationEventDispatcher>();");
        di.ShouldContain("return services;");
    }

    [Fact]
    public void Di_extension_for_a_non_publishing_context_omits_the_dispatcher()
    {
        var files = Emit(Infrastructure);
        var di = File(files, "Shipping/Infrastructure/ShippingServiceCollectionExtensions.cs").Contents;

        di.ShouldContain("services.AddDbContext<ShippingDbContext>(configureDbContext);");
        di.ShouldContain("services.AddScoped<IShipmentRepository, ShipmentRepository>();");
        di.ShouldNotContain("IntegrationEventDispatcher");
    }

    [Fact]
    public void The_generated_infrastructure_layer_compiles()
    {
        var files = Emit(Infrastructure);
        var (asm, errors) = TestSupport.Compile(files);
        asm.ShouldNotBeNull(string.Join("\n", errors));
    }

    // ----------------------------------------------------------------------
    // Edge cases (Task 7)
    // ----------------------------------------------------------------------

    private static IReadOnlyList<EmittedFile> EmitInfra(string fixture)
    {
        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter(Infrastructure));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    [Fact]
    public void Aggregate_with_no_value_object_fields_emits_a_minimal_configuration()
    {
        // Only a primitive field — no OwnsOne, just the key (+ Version), and it must still compile.
        var files = EmitInfra("""
            context Catalog {
              aggregate Product root Product versioned {
                entity Product identified by ProductId { name: String }
              }
            }
            """);

        var cfg = File(files, "Catalog/Infrastructure/ProductConfiguration.cs").Contents;
        cfg.ShouldContain("builder.HasKey(x => x.Id);");
        cfg.ShouldContain("builder.Property(x => x.Version).IsConcurrencyToken();");
        cfg.ShouldNotContain("OwnsOne");
        TestSupport.Compile(files).Assembly.ShouldNotBeNull();
    }

    [Fact]
    public void Context_with_no_aggregates_emits_no_infrastructure()
    {
        // A context of only value objects / enums has no aggregate root → no DbContext, no error.
        var files = EmitInfra("""
            context Reference {
              enum Color { Red, Green }
              value Label { text: String }
            }
            """);

        files.ShouldNotContain(f => f.RelativePath.Contains("/Infrastructure/", StringComparison.Ordinal));
    }

    [Fact]
    public void Nested_same_named_value_objects_do_not_shadow_owned_builder_parameters()
    {
        // A value object nested under a same-named member must not produce two owned-builder lambdas
        // with the same parameter name (CS0136). The depth-suffixed name keeps them distinct.
        // The member `location` repeats at two nesting levels (Address.location → Geo.location),
        // so the owned-builder lambda parameters would collide without the depth suffix.
        var files = EmitInfra("""
            context T {
              value Geo { lat: Decimal }
              value Address { location: Geo }
              aggregate A root A { entity A identified by AId { location: Address } }
            }
            """);

        var cfg = File(files, "T/Infrastructure/AConfiguration.cs").Contents;
        cfg.ShouldContain("builder.OwnsOne(x => x.Location, location =>");
        cfg.ShouldContain("location.OwnsOne(x => x.Location, location2 =>"); // distinct inner parameter
        var (asm, errors) = TestSupport.Compile(files);
        asm.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Sequence_identity_key_is_marked_value_generated()
    {
        // A store-assigned sequence key must be ValueGeneratedOnAdd so EF lets the DB produce it.
        var files = EmitInfra("""
            context Billing {
              aggregate Invoice root Invoice {
                entity Invoice identified by InvoiceId as sequence { amount: Decimal }
              }
            }
            """);

        var cfg = File(files, "Billing/Infrastructure/InvoiceConfiguration.cs").Contents;
        cfg.ShouldContain(".HasConversion(id => id.Value, value => new InvoiceId(value))");
        cfg.ShouldContain(".ValueGeneratedOnAdd();");
        TestSupport.Compile(files).Assembly.ShouldNotBeNull();
    }

    [Fact]
    public void List_of_enum_does_not_produce_a_dead_value_converter()
    {
        // A smart enum used ONLY as a List<Enum> element is emitted as a primitive collection (no
        // HasConversion), so no converter should be generated for it.
        var files = EmitInfra("""
            context Docs {
              enum Tag { Draft, Final }
              aggregate Doc root Doc { entity Doc identified by DocId { tags: List<Tag> } }
            }
            """);

        // No converter holder at all (the only enum is list-only and therefore unmapped).
        files.ShouldNotContain(f => f.RelativePath == "Docs/Infrastructure/DocsValueConverters.cs");
        File(files, "Docs/Infrastructure/DocConfiguration.cs").Contents
            .ShouldNotContain("Converter");
    }

    // ----------------------------------------------------------------------
    // EF Core round-trip: owned value-object collections must MATERIALIZE (issue #171)
    // ----------------------------------------------------------------------

    // The exact shape issue #171 is about: an aggregate that owns a value-object collection. Today the
    // domain emitter exposes it as a read-only IReadOnlyList<T> over a ReadOnlyCollection, which EF Core
    // cannot populate when materializing an OwnsMany — so this round-trips only once the collection is
    // backed by a mutable list with field access configured.
    private const string VoCollectionFixture = """
        context Sales {
          value OrderLine { sku: String  quantity: Int }
          aggregate Order root Order {
            entity Order identified by OrderId { lines: List<OrderLine> }
          }
        }
        """;

    [Fact]
    public void Round_trip_harness_persists_and_reloads_a_simple_aggregate()
    {
        // Proves the SQLite round-trip plumbing itself works against generated EF code with no owned
        // *collection* — so a RED on the value-object-collection model below is the bug, not the harness.
        // A smart-enum member is explicitly mapped (HasConversion), so EF binds it in the aggregate's
        // constructor and the aggregate materializes without any of issue #171's machinery.
        var files = EmitInfra("""
            context Catalog {
              enum Color { Red, Green }
              aggregate Product root Product {
                entity Product identified by ProductId { color: Color }
              }
            }
            """);
        using var harness = TestSupport.EfRoundTripHarness.Create(files, "CatalogDbContext");

        var productType = harness.Type("Product");
        var productIdType = harness.Type("ProductId");
        var colorType = harness.Type("Color");

        var productId = productIdType.GetMethod("New", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null)!;
        var product = Activator.CreateInstance(productType, productId, TestSupport.EnumValue(colorType, "Red"))!;

        using (var write = harness.NewContext())
        {
            write.Add(product);
            write.SaveChanges();
        }

        using var read = harness.NewContext();
        var loaded = TestSupport.EfRoundTripHarness.Query(read, productType).ShouldHaveSingleItem();
        var loadedColor = productType.GetProperty("Color")!.GetValue(loaded);
        colorType.GetProperty("Name")!.GetValue(loadedColor).ShouldBe("Red");
    }

    [Fact]
    public void Owns_many_configures_field_access_so_ef_binds_the_backing_list()
    {
        var cfg = File(EmitInfra(VoCollectionFixture), "Sales/Infrastructure/OrderConfiguration.cs").Contents;

        cfg.ShouldContain("builder.OwnsMany(x => x.Lines,");
        // Field access so EF reads/writes the mutable _lines backing field, not the read-only property.
        cfg.ShouldContain("builder.Navigation(x => x.Lines).UsePropertyAccessMode(PropertyAccessMode.Field);");
        // A single-column surrogate key so the owned rows persist on every provider (the default
        // composite synthesized key is not auto-generated on SQLite).
        cfg.ShouldContain("lines.Property<int>(\"Id\").ValueGeneratedOnAdd();");
        cfg.ShouldContain("lines.HasKey(\"Id\");");
    }

    [Fact]
    public void Owned_value_object_collection_round_trips_through_ef_core()
    {
        var files = EmitInfra(VoCollectionFixture);
        using var harness = TestSupport.EfRoundTripHarness.Create(files, "SalesDbContext");

        var orderType = harness.Type("Order");
        var orderIdType = harness.Type("OrderId");
        var lineType = harness.Type("OrderLine");

        // new Order(OrderId.New(), new List<OrderLine> { new OrderLine("SKU-1", 2) })
        var line = Activator.CreateInstance(lineType, "SKU-1", 2)!;
        var lines = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(lineType))!;
        lines.Add(line);
        var orderId = orderIdType.GetMethod("New", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null)!;
        var order = Activator.CreateInstance(orderType, orderId, lines)!;

        using (var write = harness.NewContext())
        {
            write.Add(order);
            write.SaveChanges();
        }

        using var read = harness.NewContext();
        var loaded = TestSupport.EfRoundTripHarness.Query(read, orderType).ShouldHaveSingleItem();
        var loadedLines = ((IEnumerable)orderType.GetProperty("Lines")!.GetValue(loaded)!).Cast<object>().ToList();
        var loadedLine = loadedLines.ShouldHaveSingleItem();
        lineType.GetProperty("Sku")!.GetValue(loadedLine).ShouldBe("SKU-1");
        lineType.GetProperty("Quantity")!.GetValue(loadedLine).ShouldBe(2);
    }

    // ----------------------------------------------------------------------
    // Domain shape: value-object collections are backed by a mutable list (issue #171)
    // ----------------------------------------------------------------------

    private static string DomainEntity(string fixture, string entityFile)
    {
        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith(entityFile, StringComparison.Ordinal)).Contents;
    }

    [Fact]
    public void Value_object_collection_entity_is_backed_by_a_mutable_list_with_readonly_surface()
    {
        var order = DomainEntity("""
            context Sales {
              value OrderLine { sku: String  quantity: Int }
              aggregate Order root Order {
                entity Order identified by OrderId { lines: List<OrderLine> }
              }
            }
            """, "Order.cs");

        // Mutable private backing list EF can materialize into, exposed read-only.
        order.ShouldContain("private readonly List<OrderLine> _lines = new();");
        order.ShouldContain("public IReadOnlyList<OrderLine> Lines => _lines;");
        // Defensive copy preserved (constructor copies the caller's list into the backing field).
        order.ShouldContain("_lines.AddRange(lines);");
        order.ShouldNotContain("new List<OrderLine>(lines).AsReadOnly()");
        // A parameterless constructor so EF can materialize the aggregate (its collection
        // constructor parameter can never bind to a navigation).
        order.ShouldContain("private Order()");
    }

    [Fact]
    public void Scalar_collection_entity_keeps_the_read_only_collection_shape_byte_for_byte()
    {
        var doc = DomainEntity("""
            context Docs {
              aggregate Doc root Doc { entity Doc identified by DocId { tags: List<String> } }
            }
            """, "Doc.cs");

        // A scalar (String) collection is intentionally left to EF's primitive-collection convention:
        // unchanged read-only property + defensive AsReadOnly copy, no backing field, no EF ctor.
        doc.ShouldContain("public IReadOnlyList<string> Tags { get; }");
        doc.ShouldContain("Tags = new List<string>(tags).AsReadOnly();");
        doc.ShouldNotContain("_tags");
        doc.ShouldNotContain("private Doc()");
    }

    [Fact]
    public void Smart_enum_used_by_multiple_aggregates_shares_one_converter()
    {
        var files = EmitInfra("""
            context Sales {
              enum Status { Open, Closed }
              aggregate Order root Order {
                entity Order identified by OrderId { status: Status }
              }
              aggregate Ticket root Ticket {
                entity Ticket identified by TicketId { status: Status }
              }
            }
            """);

        var conv = File(files, "Sales/Infrastructure/SalesValueConverters.cs").Contents;
        // Exactly one shared converter for the enum, referenced by both configurations.
        Regex.Matches(conv, "StatusConverter =").Count.ShouldBe(1);
        File(files, "Sales/Infrastructure/OrderConfiguration.cs").Contents
            .ShouldContain("SalesValueConverters.StatusConverter");
        File(files, "Sales/Infrastructure/TicketConfiguration.cs").Contents
            .ShouldContain("SalesValueConverters.StatusConverter");
        TestSupport.Compile(files).Assembly.ShouldNotBeNull();
    }
}
