using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// R19 (issue #1796) — every code emitter must RENDER the <c>publish</c> clause, not silently drop it.
/// The C# emitter grew the published-language recording in its own task; this suite is the net for the
/// other six backends (TypeScript, Python, PHP, Rust, Java, Kotlin).
///
/// <para>Each target asserts the same three properties, expressed in that target's own idiom:</para>
/// <list type="number">
///   <item><description>the publishing root carries an integration-event collection that is
///   <b>separate</b> from its domain-event one (<c>emit</c> and <c>publish</c> mean different things —
///   in-process dispatch vs. the transactional outbox — so they never share a buffer);</description></item>
///   <item><description>the command body appends the constructed integration event to that
///   collection, <b>after</b> the <c>emit</c> statements (recording reads inside-out);</description></item>
///   <item><description>an entity that only <c>emit</c>s grows no integration-event collection, so the
///   feature is gated on the model's shape rather than emitted unconditionally.</description></item>
/// </list>
///
/// <para>None of these six backends emits a concrete application/handler layer (only C# does, behind
/// <c>EmitApplication</c>), so there is nowhere for a <c>WritePublishRelay</c> analogue to live: this is
/// the recording half only, by design.</para>
/// </summary>
public class R19PublishEmissionTests
{
    /// <summary>
    /// A root command that both <c>emit</c>s an intra-aggregate domain event and <c>publish</c>es a
    /// published-language integration event, so every assertion below can check the two stay apart.
    /// </summary>
    private const string PublishingRoot = """
        context Ordering {
          publishes OrderPlaced

          integration event OrderPlaced {
            orderId: String
            lines:   Int
          }

          aggregate Sales root Order {
            event OrderDrafted { orderId: OrderId }

            entity Order identified by OrderId {
              lineCount: Int = 0

              command place {
                emit OrderDrafted(orderId: id)
                publish OrderPlaced(orderId: id.value, lines: lineCount)
              }
            }
          }
        }
        """;

    /// <summary>The same aggregate with the <c>publish</c> removed — the negative gate for every target.</summary>
    private const string EmitOnlyRoot = """
        context Ordering {
          aggregate Sales root Order {
            event OrderDrafted { orderId: OrderId }

            entity Order identified by OrderId {
              lineCount: Int = 0

              command place {
                emit OrderDrafted(orderId: id)
              }
            }
          }
        }
        """;

    private static string EmitFile(string source, IEmitter emitter, string pathSuffix)
    {
        CompileResult result = new KoineCompiler().Compile(source, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith(pathSuffix, StringComparison.Ordinal)).Contents;
    }

    // ---- TypeScript ---------------------------------------------------------

    [Fact]
    public void TypeScript_records_a_published_integration_event_on_its_own_collection()
    {
        var order = EmitFile(PublishingRoot, new TypeScriptEmitter(), "/Order.ts");

        // A separate buffer + accessor + drain, mirroring the domain-event trio right above it. The
        // element type is `object`, this emitter's own convention for a published-language contract
        // (its unit of work takes `enqueue(integrationEvent: object)`).
        order.ShouldContain("private readonly _domainEvents: DomainEvent[] = [];");
        order.ShouldContain("private readonly _integrationEvents: object[] = [];");
        order.ShouldContain("get integrationEvents(): readonly object[] {");
        order.ShouldContain("clearIntegrationEvents(): void {");
        order.ShouldContain("this._integrationEvents.length = 0;");

        // The publish appends to the integration buffer, after the emit.
        order.ShouldContain("this._domainEvents.push(new OrderDrafted(this.id));");
        order.ShouldContain("this._integrationEvents.push(new OrderPlaced(this.id.value, this.lineCount));");
        order.IndexOf("_integrationEvents.push", StringComparison.Ordinal)
            .ShouldBeGreaterThan(order.IndexOf("_domainEvents.push", StringComparison.Ordinal));
    }

    [Fact]
    public void TypeScript_emits_no_integration_collection_for_an_emit_only_root()
    {
        var order = EmitFile(EmitOnlyRoot, new TypeScriptEmitter(), "/Order.ts");

        order.ShouldContain("_domainEvents");
        order.ShouldNotContain("_integrationEvents");
    }

    // ---- Python -------------------------------------------------------------

    [Fact]
    public void Python_records_a_published_integration_event_on_its_own_buffer()
    {
        var order = EmitFile(PublishingRoot, new PythonEmitter(), "/order.py");

        order.ShouldContain("_domain_events: list[object] = field(default_factory=list, init=False)");
        order.ShouldContain("_integration_events: list[object] = field(default_factory=list, init=False)");
        order.ShouldContain("def integration_events(self) -> tuple[object, ...]:");
        order.ShouldContain("def clear_integration_events(self) -> None:");

        order.ShouldContain("self._domain_events.append(OrderDrafted(order_id=self.id))");
        order.ShouldContain("self._integration_events.append(OrderPlaced(order_id=self.id.value, lines=self.line_count))");
        order.IndexOf("_integration_events.append", StringComparison.Ordinal)
            .ShouldBeGreaterThan(order.IndexOf("_domain_events.append", StringComparison.Ordinal));
    }

    [Fact]
    public void Python_emits_no_integration_buffer_for_an_emit_only_root()
    {
        var order = EmitFile(EmitOnlyRoot, new PythonEmitter(), "/order.py");

        order.ShouldContain("_domain_events");
        order.ShouldNotContain("_integration_events");
    }

    // ---- PHP ----------------------------------------------------------------

    [Fact]
    public void Php_records_a_published_integration_event_on_its_own_buffer()
    {
        var order = EmitFile(PublishingRoot, new PhpEmitter(), "/Order.php");

        order.ShouldContain("private array $domainEvents = [];");
        order.ShouldContain("private array $integrationEvents = [];");
        order.ShouldContain("public function integrationEvents(): array");
        order.ShouldContain("public function releaseIntegrationEvents(): array");
        order.ShouldContain("public function clearIntegrationEvents(): void");

        order.ShouldContain("$this->domainEvents[] = new OrderDrafted($this->id);");
        order.ShouldContain("$this->integrationEvents[] = new OrderPlaced($this->id->value, $this->lineCount);");
        order.IndexOf("$this->integrationEvents[] = new", StringComparison.Ordinal)
            .ShouldBeGreaterThan(order.IndexOf("$this->domainEvents[] = new", StringComparison.Ordinal));
    }

    [Fact]
    public void Php_emits_no_integration_buffer_for_an_emit_only_root()
    {
        var order = EmitFile(EmitOnlyRoot, new PhpEmitter(), "/Order.php");

        order.ShouldContain("domainEvents");
        order.ShouldNotContain("integrationEvents");
    }

    // ---- Rust ---------------------------------------------------------------

    [Fact]
    public void Rust_records_a_published_integration_event_on_its_own_collector()
    {
        var module = EmitFile(PublishingRoot, new RustEmitter(), "/ordering.rs");

        // Two `Vec<DomainEvent>` collectors: the context-wide `DomainEvent` enum already carries a
        // variant per integration event, so no second enum is invented — only a second collector.
        module.ShouldContain("events: Vec<DomainEvent>,");
        module.ShouldContain("integration_events: Vec<DomainEvent>,");
        module.ShouldContain("pub fn integration_events(&self) -> &[DomainEvent] { &self.integration_events }");
        module.ShouldContain("pub fn drain_integration_events(&mut self) -> Vec<DomainEvent> { std::mem::take(&mut self.integration_events) }");

        module.ShouldContain("self.integration_events.push(DomainEvent::OrderPlaced(OrderPlaced::new(self.id.value(), self.line_count)));");
        module.IndexOf("self.integration_events.push", StringComparison.Ordinal)
            .ShouldBeGreaterThan(module.IndexOf("self.events.push", StringComparison.Ordinal));
    }

    [Fact]
    public void Rust_emits_no_integration_collector_for_an_emit_only_root()
    {
        var module = EmitFile(EmitOnlyRoot, new RustEmitter(), "/ordering.rs");

        module.ShouldContain("events: Vec<DomainEvent>,");
        module.ShouldNotContain("integration_events");
    }

    // ---- Java ---------------------------------------------------------------

    [Fact]
    public void Java_records_a_published_integration_event_on_its_own_list()
    {
        var order = EmitFile(PublishingRoot, new JavaEmitter(), "/Order.java");

        order.ShouldContain("private final java.util.List<DomainEvent> domainEvents = new java.util.ArrayList<>();");
        order.ShouldContain("private final java.util.List<DomainEvent> integrationEvents = new java.util.ArrayList<>();");
        order.ShouldContain("public java.util.List<DomainEvent> integrationEvents() {");
        order.ShouldContain("return java.util.List.copyOf(this.integrationEvents);");

        order.ShouldContain("this.integrationEvents.add(new OrderPlaced(this.id.value(), this.lineCount));");
        order.IndexOf("this.integrationEvents.add", StringComparison.Ordinal)
            .ShouldBeGreaterThan(order.IndexOf("this.domainEvents.add", StringComparison.Ordinal));
    }

    [Fact]
    public void Java_emits_no_integration_list_for_an_emit_only_root()
    {
        var order = EmitFile(EmitOnlyRoot, new JavaEmitter(), "/Order.java");

        order.ShouldContain("domainEvents");
        order.ShouldNotContain("integrationEvents");
    }

    // ---- Kotlin -------------------------------------------------------------

    [Fact]
    public void Kotlin_records_a_published_integration_event_on_its_own_list()
    {
        var order = EmitFile(PublishingRoot, new KotlinEmitter(), "/Order.kt");

        order.ShouldContain("private val _domainEvents: MutableList<DomainEvent> = mutableListOf()");
        order.ShouldContain("private val _integrationEvents: MutableList<DomainEvent> = mutableListOf()");
        order.ShouldContain("fun integrationEvents(): List<DomainEvent> = this._integrationEvents.toList()");

        order.ShouldContain("this._integrationEvents.add(OrderPlaced(this.id.value, this.lineCount))");
        order.IndexOf("this._integrationEvents.add", StringComparison.Ordinal)
            .ShouldBeGreaterThan(order.IndexOf("this._domainEvents.add", StringComparison.Ordinal));
    }

    [Fact]
    public void Kotlin_emits_no_integration_list_for_an_emit_only_root()
    {
        var order = EmitFile(EmitOnlyRoot, new KotlinEmitter(), "/Order.kt");

        order.ShouldContain("_domainEvents");
        order.ShouldNotContain("_integrationEvents");
    }
}
