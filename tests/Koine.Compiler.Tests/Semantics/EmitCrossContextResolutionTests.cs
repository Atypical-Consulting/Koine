using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Guards that an <c>emit</c>'s event name resolves in the bounded context that encloses it, rather
/// than through <see cref="Ast.ModelIndex"/>'s flat, last-declaration-wins view (#1834).
/// </summary>
/// <remarks>
/// <para>Two bounded contexts may each declare a same-named domain <c>event</c> with a different
/// payload — R13.2/R14 make that explicit, because a context owns its own ubiquitous language. The
/// flat view keeps only whichever was indexed last, so resolving through it makes the whole model's
/// legality depend on the <b>source order</b> of its contexts. Every fixture below therefore ships in
/// two orders, and both must behave identically.</para>
/// <para><b>The validator and the emitters are one contract.</b> #1816 (implementing #1796) fixed the
/// mirror image of this defect for <c>publish</c>: there the validator already resolved context-aware
/// while the emitters stayed flat, so a legal model type-checked and then emitted an uncompilable
/// constructor call of the wrong arity. Moving only one half of <c>emit</c> re-opens exactly that hole
/// — so these tests deliberately assert on <b>both</b> halves (no diagnostics <i>and</i> the emitted
/// payload, for every target).</para>
/// <para><b>The permit path is covered elsewhere.</b> Every fixture below has <c>Ordering</c>
/// declaring the event itself. A context can also see a type purely through the context map (R14.1),
/// with no local declaration and no <c>import</c> — that route bypassed all of this until #1853 fixed
/// the shared seam <c>ModelIndex.TryGetDeclIn</c>, which is what actually closed the family. See
/// <see cref="PermitVisibleCrossContextResolutionTests"/>.</para>
/// </remarks>
public class EmitCrossContextResolutionTests
{
    /// <summary>
    /// The repro from #1834, with <c>Ordering</c> declared <b>first</b> — the rejecting order, and the
    /// one a directory-mode build hits naturally (files are read alphabetically, so <c>Ordering</c>
    /// lands before <c>Warehouse</c>). <c>Warehouse.Shipped</c> is indexed last and wins the flat
    /// table, so <c>Ordering</c>'s <c>emit</c> was checked against a payload it never declared.
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
            }
          }
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
            }
          }
        }
        """;

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    [Fact]
    public void Emit_resolves_a_same_named_event_in_its_own_context()
    {
        // `Ordering` first: `Warehouse.Shipped` wins the flat table. Before #1834 this produced three
        // false KOI0602s — one "no field 'orderId'" plus one missing-field per Warehouse-only field.
        Diagnose(OrderingFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Emit_resolves_a_same_named_event_regardless_of_context_declaration_order()
    {
        // The same model, contexts swapped. This order always compiled — asserting it alongside the
        // other is what turns "it compiles" into "it compiles *deterministically*".
        Diagnose(WarehouseFirstFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Emit_resolution_does_not_depend_on_context_source_order()
    {
        Diagnose(OrderingFirstFixture)
            .Select(d => d.Code)
            .ShouldBe(Diagnose(WarehouseFirstFixture).Select(d => d.Code));
    }

    // ---- The emitter half of the contract -----------------------------------
    //
    // A green validator over flat emitters is NOT a fix — it is the #1797 regression shape: #1739
    // relaxed a resolution rule without checking what the emitters then did, and shipped code built
    // from the wrong declaration. With the validator context-aware and the emitters still flat, the
    // fixture below type-checks and then emits `new Shipped(default!, default!)` — Warehouse's
    // two-field payload for Ordering's one-field event, which does not compile. So every target is
    // asserted on its own emitted payload, in BOTH context orders.

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
    public void CSharp_emits_the_enclosing_context_s_event_payload(bool warehouseFirst)
    {
        var source = warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture;

        // Ordering.Shipped takes ONE field (orderId). Warehouse's same-named event takes two.
        EmitFile(source, new CSharpEmitter(), "/Order.cs")
            .ShouldContain("_domainEvents.Add(new Shipped(Code));");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Emitted_cross_context_emit_output_compiles(bool warehouseFirst)
    {
        // The compile gate #1796/#1816 established: "it validates" and "it snapshots" both stay green
        // while the emitted C# is uncompilable, because neither executes the generated code. Only
        // Roslyn catches `new Shipped(default!, default!)` against a one-parameter constructor.
        var (assembly, errors) =
            TestSupport.Compile(EmitAll(warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture, new CSharpEmitter()));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TypeScript_emits_the_enclosing_context_s_event_payload(bool warehouseFirst)
    {
        var source = warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture;

        EmitFile(source, new TypeScriptEmitter(), "/Order.ts")
            .ShouldContain("this._domainEvents.push(new Shipped(this.code));");
    }

    /// <summary>
    /// The lockstep guard: every backend builds the <c>emit</c> payload from <b>Ordering's</b>
    /// one-field <c>Shipped</c>, in both context orders. A half-conversion — the validator alone, or
    /// one emitter alone — fails here loudly rather than silently emitting another context's payload.
    /// </summary>
    /// <remarks>
    /// <para><b>The eight sites that must move together</b> (#1834), each resolving the event name
    /// through <c>ModelIndex.TryGetDecl(context, name, out _)</c> rather than the flat overload:
    /// <c>EntityBehaviorValidator.ValidateEmit</c>, <c>CSharpEmitter.BuildEmitStatement</c>,
    /// <c>TypeScriptEmitter.BuildEmitStatement</c>, <c>PythonEmitter.BuildEmitStatement</c>,
    /// <c>PhpEmitter.BuildEmitStatement</c>, and the <c>BuildEmitExpression</c> call sites in the
    /// Rust, Java and Kotlin emitters (which forward the context into the <c>BuildEventExpression</c>
    /// core #1816 already added for <c>publish</c>).</para>
    /// <para>Revert any ONE of them and this test fails — which is the point. #1816 (implementing
    /// #1796) closed the mirror-image hole for <c>publish</c>, and #1739 shipped the regression #1797
    /// had to fix precisely because a resolution rule was relaxed on one side without checking what
    /// the other side then produced.</para>
    /// </remarks>
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Every_backend_resolves_a_same_named_emitted_event_in_its_own_context(bool warehouseFirst)
    {
        var source = warehouseFirst ? WarehouseFirstFixture : OrderingFirstFixture;

        EmitFile(source, new CSharpEmitter(), "/Order.cs")
            .ShouldContain("_domainEvents.Add(new Shipped(Code));");
        EmitFile(source, new TypeScriptEmitter(), "/Order.ts")
            .ShouldContain("this._domainEvents.push(new Shipped(this.code));");
        EmitFile(source, new PythonEmitter(), "/order.py")
            .ShouldContain("self._domain_events.append(Shipped(order_id=self.code))");
        EmitFile(source, new PhpEmitter(), "/Order.php")
            .ShouldContain("$this->domainEvents[] = new Shipped($this->code);");
        EmitFile(source, new RustEmitter(), "/ordering.rs")
            .ShouldContain("self.events.push(DomainEvent::Shipped(Shipped::new(self.code.to_string())));");
        EmitFile(source, new JavaEmitter(), "/Order.java")
            .ShouldContain("this.domainEvents.add(new Shipped(this.code));");
        EmitFile(source, new KotlinEmitter(), "/Order.kt")
            .ShouldContain("this._domainEvents.add(Shipped(this.code))");
    }
}
