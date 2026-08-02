using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Guards that a <c>policy … when &lt;Event&gt; then …</c> resolves its trigger event in the bounded
/// context that encloses it, rather than through <see cref="Ast.ModelIndex"/>'s flat,
/// last-declaration-wins view (#1849).
/// </summary>
/// <remarks>
/// <para>Two bounded contexts may each declare a same-named domain <c>event</c> with a different
/// payload — R13.2/R14 make that explicit, because a context owns its own ubiquitous language. The
/// flat view keeps only whichever was indexed last, so resolving through it makes the whole model's
/// legality depend on the <b>source order</b> of its contexts. Every fixture below therefore ships in
/// two orders, and both must behave identically.</para>
/// <para><b>The validator and the emitters are one contract.</b> #1844 (implementing #1834) fixed the
/// same defect one construct over, for <c>emit</c>; #1816 (implementing #1796) fixed the mirror image
/// for <c>publish</c>, where a context-aware validator over flat emitters let a legal model
/// type-check and then emit another context's payload. Moving only one half of <c>policy</c> re-opens
/// exactly that hole — so these tests deliberately assert on <b>both</b> halves (no diagnostics
/// <i>and</i> the emitted reaction sketch, for every backend that emits policies).</para>
/// <para><b>The permit path is covered elsewhere.</b> Every fixture below has <c>Ordering</c>
/// declaring the event itself. A context can also see a type purely through the context map (R14.1),
/// with no local declaration and no <c>import</c> — that route bypassed all of this until #1853 fixed
/// the shared seam <c>ModelIndex.TryGetDeclIn</c>, which is what actually closed the family. See
/// <see cref="PermitVisibleCrossContextResolutionTests"/>.</para>
/// </remarks>
public class PolicyCrossContextResolutionTests
{
    /// <summary>
    /// The repro from #1849, with <c>Ordering</c> declared <b>first</b> — the rejecting order, and the
    /// one a directory-mode build hits naturally (files are read alphabetically, so <c>Ordering</c>
    /// lands before <c>Warehouse</c>). <c>Warehouse.Shipped</c> is indexed last and wins the flat
    /// table, so <c>Ordering</c>'s policy was checked against a payload it never declared.
    /// </summary>
    internal const string OrderingFirstFixture = """
        context Ordering {
          event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: code)
              }
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

          aggregate Storage root Package {
            entity Package identified by PackageId {
              label: String
            }
          }
        }
        """;

    /// <summary>
    /// The identical model with the two <c>context</c> blocks swapped — the order that accidentally
    /// compiled clean, because the flat table then happened to hold <c>Ordering</c>'s declaration.
    /// </summary>
    internal const string WarehouseFirstFixture = """
        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }

          aggregate Storage root Package {
            entity Package identified by PackageId {
              label: String
            }
          }
        }

        context Ordering {
          event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command ship {
                shipped -> true
                emit Shipped(orderId: code)
              }
              command note(orderId: String) { shipped -> true }
            }
          }

          policy NoteOnShip when Shipped then Order.note(orderId: orderId)
        }
        """;

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void Policy_resolves_a_same_named_trigger_event_in_its_own_context()
    {
        // `Ordering` first: `Warehouse.Shipped` wins the flat table, so the reaction argument
        // `orderId` was checked against Warehouse's {packageId, carrier} payload — a false KOI0201
        // "unknown field 'orderId'" on a model R13.2/R14 explicitly allow.
        Diagnose(OrderingFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Policy_resolves_a_same_named_trigger_event_regardless_of_context_declaration_order()
    {
        // The same model, contexts swapped. This order always compiled — asserting it alongside the
        // other is what turns "it compiles" into "it compiles *deterministically*".
        Diagnose(WarehouseFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Policy_resolution_does_not_depend_on_context_source_order()
    {
        Diagnose(OrderingFirstFixture)
            .Select(d => d.Code)
            .ShouldBe(Diagnose(WarehouseFirstFixture).Select(d => d.Code));
    }

    // ---- The reaction TARGET, same hazard three lines over --------------------

    /// <summary>
    /// The policy's reaction target (<c>Order</c> in <c>then Order.note(…)</c>) resolved through the
    /// same flat view as its trigger, so two contexts each declaring a same-named aggregate made the
    /// model's legality depend on source order too. <c>Ordering</c> is declared FIRST — the rejecting
    /// order — and <c>Warehouse.Order</c> won the flat table, so the reaction was checked against
    /// <i>Warehouse's</i> <c>note(label: String)</c>.
    /// </summary>
    /// <remarks>
    /// This is not only a false diagnostic: every emitter renders the target name textually into its
    /// own namespace and <c>ScenarioFanOutResolver</c> resolves it declaring-context-first, so the flat
    /// lookup let the validator check a reaction against a different entity than the generated code and
    /// the runtime actually call.
    /// </remarks>
    internal const string SameNamedTargetOrderingFirstFixture = """
        context Ordering {
          event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command note(orderId: String) { shipped -> true }
            }
          }

          policy NoteOnShip when Shipped then Order.note(orderId: orderId)
        }

        context Warehouse {
          aggregate Storage root Order {
            entity Order identified by OrderId {
              label: String
              stored: Bool = false

              command note(label: String) { stored -> true }
            }
          }
        }
        """;

    /// <summary>The same model with the two <c>context</c> blocks swapped — the order that compiled.</summary>
    internal const string SameNamedTargetWarehouseFirstFixture = """
        context Warehouse {
          aggregate Storage root Order {
            entity Order identified by OrderId {
              label: String
              stored: Bool = false

              command note(label: String) { stored -> true }
            }
          }
        }

        context Ordering {
          event Shipped { orderId: String }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              shipped: Bool = false

              command note(orderId: String) { shipped -> true }
            }
          }

          policy NoteOnShip when Shipped then Order.note(orderId: orderId)
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Policy_resolves_a_same_named_reaction_target_in_its_own_context(bool warehouseFirst)
    {
        // Before the fix, the Ordering-first order reported KOI1033 twice — "command 'note' has no
        // parameter 'orderId'" plus a missing-argument for Warehouse's `label`.
        Diagnose(warehouseFirst ? SameNamedTargetWarehouseFirstFixture : SameNamedTargetOrderingFirstFixture)
            .ShouldBeEmpty();
    }

    /// <summary>
    /// The deliberate strictness increase that context-first resolution brings: a name declared
    /// locally as something OTHER than an event now shadows a foreign same-named event, rather than
    /// silently reaching past it through the flat view. This model compiled before #1849.
    /// </summary>
    [Fact]
    public void A_local_non_event_shadows_a_foreign_same_named_event()
    {
        const string source = """
            context Ordering {
              value Shipped { at: String }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  code: String
                  shipped: Bool = false

                  command note(orderId: String) { shipped -> true }
                }
              }

              policy NoteOnShip when Shipped then Order.note(orderId: code)
            }

            context Warehouse {
              event Shipped { orderId: String }
            }
            """;

        // `Ordering` owns the word `Shipped`, and there it is a value object — so the policy has no
        // event to react to. Reaching into `Warehouse` for one would violate R13.2's whole premise.
        Diagnose(source).Select(d => d.Code).ShouldContain(DiagnosticCodes.PolicyUnknownEvent);
    }

    // ---- The emitter half of the contract -----------------------------------
    //
    // A green validator over flat emitters is NOT a fix — it is the #1797 regression shape: #1739
    // relaxed a resolution rule without checking what the emitters then did, and shipped code built
    // from the wrong declaration. It is directly observable here. A policy's reaction arguments are
    // rendered from the TRIGGER EVENT's members, rooted at the handler parameter — so with the
    // validator context-aware and an emitter still flat, `orderId` is not among the members the
    // emitter believes the event has (it sees Warehouse's {packageId, carrier}) and silently loses
    // its receiver: the sketch degrades from `Order.note(orderId: e.OrderId)` to a bare
    // `Order.note(orderId: orderId)`. In TypeScript that same degradation lands in EXECUTABLE code —
    // `reactionArgs` returns `{ orderId: orderId }`, referencing an identifier that does not exist.
    //
    // So every backend that emits policies is asserted on its own rendered reaction, in BOTH context
    // orders.

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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CSharp_roots_the_reaction_in_the_enclosing_context_s_event(bool warehouseFirst)
    {
        var source = warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture;

        // `orderId` is a member of ORDERING's Shipped, so it roots at the handler parameter `e`.
        // Flat resolution saw Warehouse's {packageId, carrier} and emitted a bare `orderId`.
        EmitFile(source, new CSharpEmitter(), "/NoteOnShipPolicy.cs")
            .ShouldContain("Order.note(orderId: e.OrderId)");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Python_roots_the_reaction_in_the_enclosing_context_s_event(bool warehouseFirst)
    {
        EmitFile(warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture, new PythonEmitter(), "/note_on_ship.py")
            .ShouldContain("Order.note(order_id=event.order_id)");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Php_roots_the_reaction_in_the_enclosing_context_s_event(bool warehouseFirst)
    {
        EmitFile(warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture, new PhpEmitter(), "/NoteOnShipPolicy.php")
            .ShouldContain("Order::note(orderId: $event->orderId)");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_cross_context_policy_output_compiles(bool warehouseFirst)
    {
        // The compile gate #1796/#1816 established: "it validates" and "it snapshots" both stay green
        // while emitted code is uncompilable, because neither executes the generated output.
        var (assembly, errors) =
            TestSupport.Compile(EmitAll(warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture, new CSharpEmitter()));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    /// <summary>
    /// The lockstep guard: every backend that emits policies renders the reaction from
    /// <b>Ordering's</b> one-field <c>Shipped</c>, in both context orders. A half-conversion — the
    /// validator alone, or one emitter alone — fails here loudly rather than silently documenting (or,
    /// in TypeScript, <i>generating</i>) a reaction against another context's payload.
    /// </summary>
    /// <remarks>
    /// <para><b>The six sites that must move together</b> (#1849), each resolving the policy's trigger
    /// through <c>ModelIndex.TryGetDecl(context, name, out _)</c> rather than the flat overload:
    /// <c>SemanticValidator.ValidatePolicies</c>, <c>CSharpEmitter.EmitPolicy</c>,
    /// <c>PythonEmitter.EmitPolicy</c>, <c>PhpEmitter.EmitPolicy</c>,
    /// <c>TypeScriptEmitter.EmitPolicy</c> and <c>JavaEmitter.EventMembers</c>. The Rust and Kotlin
    /// emitters do not emit policies at all, so they have no site to convert (tracked separately).</para>
    /// <para>TypeScript and Java already resolved context-aware before #1849 — by hand, via
    /// <c>TryGetDeclIn</c> plus a flat fallback — while the other three and the validator did not.
    /// That pre-existing split is exactly the #1796 mirror-image hazard, so all six now call the one
    /// shared overload and this test pins them to the same answer. Revert any of the four
    /// <b>newly-converted</b> sites — validator, C#, Python, PHP — and this fails; TypeScript and Java
    /// were already context-first, and are pinned here against a future flattening.</para>
    /// <para><b>Scope of the guarantee.</b> "One answer" means the emit-time sites listed above. Two
    /// known consumers stay outside it: <c>ScenarioFanOutResolver</c> matches policies model-wide by
    /// bare event name (deliberately, and predating this rule), and <c>ModelIndex.TryGetDeclIn</c>
    /// resolves only local declarations plus unambiguous imports — a type made visible purely by a
    /// context-map permit (<c>conformist</c> and friends, with no <c>import</c>) still falls through to
    /// the flat view. Both are tracked separately; neither is introduced here.</para>
    /// </remarks>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Every_backend_resolves_a_policy_trigger_in_its_own_context(bool warehouseFirst)
    {
        var source = warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture;

        EmitFile(source, new CSharpEmitter(), "/NoteOnShipPolicy.cs")
            .ShouldContain("Order.note(orderId: e.OrderId)");
        EmitFile(source, new TypeScriptEmitter(), "/NoteOnShipPolicy.ts")
            .ShouldContain("orderId: event.orderId,");
        EmitFile(source, new PythonEmitter(), "/note_on_ship.py")
            .ShouldContain("Order.note(order_id=event.order_id)");
        EmitFile(source, new PhpEmitter(), "/NoteOnShipPolicy.php")
            .ShouldContain("Order::note(orderId: $event->orderId)");
        EmitFile(source, new JavaEmitter(), "/NoteOnShipPolicy.java")
            .ShouldContain("Order.note(orderId: event.orderId())");
    }

    /// <summary>
    /// The regression that made this defect user-visible in generated <i>code</i> rather than only in
    /// a doc sketch: TypeScript's <c>reactionArgs</c> is executable, so a flat trigger lookup emits
    /// <c>{ orderId: orderId }</c> — a reference to an identifier that is not in scope.
    /// </summary>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TypeScript_reaction_args_reference_the_handler_parameter(bool warehouseFirst)
    {
        var ts = EmitFile(warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture, new TypeScriptEmitter(), "/NoteOnShipPolicy.ts");

        ts.ShouldContain("orderId: event.orderId,");
        ts.ShouldNotContain("orderId: orderId,");
    }
}
