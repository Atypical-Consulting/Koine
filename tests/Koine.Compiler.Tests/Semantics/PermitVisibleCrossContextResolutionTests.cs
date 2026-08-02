using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// End-to-end coverage for the <b>permit</b> path of cross-context resolution (#1853): the type is
/// visible to the referencing context purely through the context map (R14.1), with no local
/// declaration and no <c>import</c>.
/// </summary>
/// <remarks>
/// <para><see cref="PolicyCrossContextResolutionTests"/> (#1849) and
/// <see cref="EmitCrossContextResolutionTests"/> (#1834) each fixed one construct for the case where
/// the referencing context declares the event <b>itself</b>. Neither reached the permit path, because
/// the shared seam they both resolve through — <c>ModelIndex.TryGetDeclIn</c> — knew only about local
/// declarations and imports. So the exact KOI0201 those issues fixed stayed reproducible by deleting
/// the local declaration and adding a <c>conformist</c> relation instead. These fixtures are that
/// second repro, for both constructs.</para>
/// <para>Every fixture ships in <b>both</b> source orders. The flat <c>_byName</c> table is
/// last-declaration-wins, so the order in which the two same-named declarations appear is exactly
/// what decided the old answer — a one-order test proves source-order luck, not resolution.</para>
/// <para><b>Validator and emitters are one contract.</b> #1739 relaxed a resolution rule, verified
/// only what the validator accepted, and shipped the #1797 regression because the emitters then built
/// from the wrong declaration. So the emitted payload is asserted per target, and the emitted C# is
/// handed to Roslyn — "it validates" and "it snapshots" both stay green while generated code is
/// uncompilable.</para>
/// </remarks>
public class PermitVisibleCrossContextResolutionTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static string EmitFile(string source, IEmitter emitter, string pathSuffix)
    {
        CompileResult result = new KoineCompiler().Compile(source, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith(pathSuffix, StringComparison.Ordinal)).Contents;
    }

    private static IReadOnlyList<EmittedFile> EmitAll(string source, IEmitter emitter)
    {
        CompileResult result = new KoineCompiler().Compile(source, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    // ---- `policy … when <Event>` over a permit-visible event ------------------

    /// <summary>
    /// <c>Ordering</c> declares no <c>Shipped</c> of its own and imports nothing; the map's
    /// <c>conformist</c> relation is the ONLY thing that makes <c>Sales.Shipped</c> visible to its
    /// policy. <c>Warehouse</c> is declared <b>last</b>, so its two-field <c>Shipped</c> is what won
    /// the flat last-write table — the order in which the policy was checked against a payload it can
    /// never see, yielding a false KOI0201 "unknown field 'orderId'".
    /// </summary>
    internal const string PolicyWarehouseLastFixture = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          aggregate Fulfilment root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command note(orderId: String) { shipped -> true }
            }
          }

          policy NoteOnShip when Shipped then Order.note(orderId: orderId)
        }

        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    /// <summary>
    /// The identical model with <c>Warehouse</c> declared <b>first</b> — so <c>Sales.Shipped</c>
    /// happens to win the flat table and the model compiled by luck. Asserting both orders is what
    /// turns "it compiles" into "it compiles deterministically".
    /// </summary>
    internal const string PolicyWarehouseFirstFixture = """
        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          aggregate Fulfilment root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command note(orderId: String) { shipped -> true }
            }
          }

          policy NoteOnShip when Shipped then Order.note(orderId: orderId)
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_policy_resolves_a_permit_visible_trigger_event(bool warehouseFirst)
    {
        Diagnose(warehouseFirst ? PolicyWarehouseFirstFixture : PolicyWarehouseLastFixture)
            .ShouldBeEmpty();
    }

    [Fact]
    public void Permit_visible_policy_resolution_does_not_depend_on_context_source_order()
    {
        Diagnose(PolicyWarehouseLastFixture)
            .Select(d => d.Code)
            .ShouldBe(Diagnose(PolicyWarehouseFirstFixture).Select(d => d.Code));
    }

    // ---- `emit <Event>` over a permit-visible event ---------------------------

    /// <summary>
    /// The same shape one construct over: <c>Ordering</c>'s <c>emit Shipped(orderId: code)</c> names
    /// an event only the <c>conformist</c> permit makes visible, with <c>Warehouse</c> declared last
    /// so the flat table answers the wrong payload.
    /// </summary>
    internal const string EmitWarehouseLastFixture = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          aggregate Fulfilment root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: code)
              }
            }
          }
        }

        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    /// <summary>The identical model with <c>Warehouse</c> declared first — the lucky order.</summary>
    internal const string EmitWarehouseFirstFixture = """
        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          aggregate Fulfilment root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: code)
              }
            }
          }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void An_emit_resolves_a_permit_visible_event(bool warehouseFirst)
    {
        Diagnose(warehouseFirst ? EmitWarehouseFirstFixture : EmitWarehouseLastFixture)
            .ShouldBeEmpty();
    }

    [Fact]
    public void Permit_visible_emit_resolution_does_not_depend_on_context_source_order()
    {
        Diagnose(EmitWarehouseLastFixture)
            .Select(d => d.Code)
            .ShouldBe(Diagnose(EmitWarehouseFirstFixture).Select(d => d.Code));
    }

    /// <summary>
    /// The emitter half of the contract, for every backend that renders an <c>emit</c>: the payload
    /// must be built from <b>Sales</b>'s one-field <c>Shipped</c> — the declaration the permit points
    /// at — in both source orders. A validator-only fix leaves these emitting Warehouse's two-field
    /// payload, which is the #1797 regression shape.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Every_backend_builds_a_permit_visible_emit_from_the_permitted_owner(bool warehouseFirst)
    {
        var source = warehouseFirst ? EmitWarehouseFirstFixture : EmitWarehouseLastFixture;

        EmitFile(source, new CSharpEmitter(), "/Order.cs")
            .ShouldContain("_domainEvents.Add(new Shipped(Code));");
        EmitFile(source, new TypeScriptEmitter(), "/Order.ts")
            .ShouldContain("this._domainEvents.push(new Shipped(this.code));");
        EmitFile(source, new PythonEmitter(), "/order.py")
            .ShouldContain("self._domain_events.append(Shipped(order_id=self.code))");
        EmitFile(source, new PhpEmitter(), "/Order.php")
            .ShouldContain("$this->domainEvents[] = new Shipped($this->code);");
        EmitFile(source, new JavaEmitter(), "/Order.java")
            .ShouldContain("this.domainEvents.add(new Shipped(this.code));");
        EmitFile(source, new KotlinEmitter(), "/Order.kt")
            .ShouldContain("this._domainEvents.add(Shipped(this.code))");

        // Rust is the sharpest of the seven: it emits flat modules, so the permitted owner is spelled
        // out in the path. `crate::sales::Shipped` is the resolution made visible — the flat table
        // would have written `crate::warehouse::Shipped` here in one of the two source orders.
        EmitFile(source, new RustEmitter(), "/ordering.rs")
            .ShouldContain("DomainEvent::Shipped(crate::sales::Shipped::new(self.code.to_string()))");
    }

    /// <summary>
    /// The compile gate. Neither the validator nor a snapshot executes the generated code, so only
    /// Roslyn catches <c>new Shipped(default!, default!)</c> against a one-parameter constructor —
    /// and only Roslyn proves the cross-context reference actually resolves in the emitted C#, since
    /// the event now lives in <c>Sales</c>'s namespace rather than the emitting context's.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_permit_visible_emit_output_compiles(bool warehouseFirst)
    {
        var (assembly, errors) = TestSupport.Compile(
            EmitAll(warehouseFirst ? EmitWarehouseFirstFixture : EmitWarehouseLastFixture, new CSharpEmitter()));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    // ---- `publish <IntegrationEvent>` over a permit-visible event -------------

    /// <summary>
    /// The <c>publish</c> counterpart (#1796/#1816's construct). <c>Ordering</c> declares no
    /// <c>OrderPlaced</c> and imports none; the <c>conformist</c> permit alone makes
    /// <c>Sales.OrderPlaced</c> visible, and <c>Warehouse</c> is declared last so the flat table
    /// answers the wrong payload.
    /// </summary>
    /// <remarks>
    /// The permit path is <b>reachable</b> here rather than vacuous, and it lands the construct on the
    /// behaviour the <c>import</c> rung has always had: <c>publishes X</c> naming an integration event
    /// this context can see but does not declare was already accepted through an <c>import</c> before
    /// #1853 (that rung of <c>TryGetDeclIn</c> is untouched by this change), so making the map permit
    /// resolve the same way is a consistency fix, not a new relaxation. What #1853 must not do is let
    /// the two visibility routes disagree.
    /// </remarks>
    internal const string PublishWarehouseLastFixture = """
        context Sales {
          integration event OrderPlaced { orderId: String }
          publishes OrderPlaced
        }

        context Ordering {
          publishes OrderPlaced

          aggregate Fulfilment root Order {
            entity Order identified by OrderId {
              code: String
              done: Bool = false

              command place {
                done -> true
                publish OrderPlaced(orderId: code)
              }
            }
          }
        }

        context Warehouse {
          integration event OrderPlaced {
            packageId: String
            carrier: String
          }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    /// <summary>The identical model with <c>Warehouse</c> declared first — the lucky order.</summary>
    internal const string PublishWarehouseFirstFixture = """
        context Warehouse {
          integration event OrderPlaced {
            packageId: String
            carrier: String
          }
        }

        context Sales {
          integration event OrderPlaced { orderId: String }
          publishes OrderPlaced
        }

        context Ordering {
          publishes OrderPlaced

          aggregate Fulfilment root Order {
            entity Order identified by OrderId {
              code: String
              done: Bool = false

              command place {
                done -> true
                publish OrderPlaced(orderId: code)
              }
            }
          }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_publish_resolves_a_permit_visible_integration_event(bool warehouseFirst)
    {
        // Before #1853 the Warehouse-last order reported KOI1420 ("'OrderPlaced' is not an integration
        // event of context 'Ordering'") plus KOI1410 on the `publishes` line — while the identical
        // model with an `import Sales.{ OrderPlaced }` in place of the permit compiled clean.
        Diagnose(warehouseFirst ? PublishWarehouseFirstFixture : PublishWarehouseLastFixture)
            .ShouldBeEmpty();
    }

    [Fact]
    public void Permit_visible_publish_resolution_does_not_depend_on_context_source_order()
    {
        Diagnose(PublishWarehouseLastFixture)
            .Select(d => d.Code)
            .ShouldBe(Diagnose(PublishWarehouseFirstFixture).Select(d => d.Code));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_permit_visible_publish_builds_the_permitted_owner_s_payload(bool warehouseFirst)
    {
        var source = warehouseFirst ? PublishWarehouseFirstFixture : PublishWarehouseLastFixture;

        // Sales's OrderPlaced takes ONE field; Warehouse's same-named event takes two.
        EmitFile(source, new CSharpEmitter(), "/Order.cs")
            .ShouldContain("_integrationEvents.Add(new OrderPlaced(Code));");
    }

    /// <summary>
    /// The compile gate that matters most for <c>publish</c>: <c>Ordering/Order.cs</c> refers to
    /// <c>OrderPlaced</c> by its bare name while <b>two</b> emitted namespaces declare that name. Only
    /// a correctly-resolved <c>using</c> (<c>Sales</c>, and not <c>Warehouse</c>) keeps that
    /// unambiguous — a flat resolution would emit both and produce CS0104, or emit the wrong arity.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_permit_visible_publish_output_compiles(bool warehouseFirst)
    {
        var (assembly, errors) = TestSupport.Compile(
            EmitAll(warehouseFirst ? PublishWarehouseFirstFixture : PublishWarehouseLastFixture, new CSharpEmitter()));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }
}
