using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1870, the C#-emitter cluster: twelve <c>CSharpEmitter</c>/<c>CSharpExpressionTranslator</c>
/// call sites asked <see cref="Ast.ModelIndex"/> "what kind of type is this name?" through the FLAT,
/// last-declaration-wins <c>Classify(string)</c> overload while a bounded-context value was already in
/// scope (nine directly, plus <c>IsValueObjectList</c>/<c>ClassifyMember</c>/<c>EnumExpected</c> — three
/// shared static helpers whose callers all had one to thread in, caught by this branch's own review).
/// R13.2 lets two contexts legally declare a type with the same simple name, so the answer — and
/// therefore the emitted C# — silently depended on <c>.koi</c> source order.
/// </summary>
/// <remarks>
/// <para>Every fixture ships in BOTH context declaration orders and asserts the SAME emitted text in
/// each. A single-order test proves luck, not correctness: the flat table is filled by walking
/// <c>model.Contexts</c> in order, so whichever context is declared LAST wins it, and a one-order
/// assertion can pass purely because that order happens to be the lucky one.</para>
/// <para>Each fixture pairs the collided declaration (<c>Zeta</c> declaring a <c>value</c> whose simple
/// name <c>Alpha</c> declares as an <c>enum</c>) with a construct whose emission genuinely hinges on
/// the enum-ness of that name — a nullable-parameter enum default, a state transition's qualifier, a
/// factory constructor argument, a service body, a read-model projection, an inlined derived member,
/// or a quantity's unit-checked operator set.</para>
/// <para>Where a shared enum MEMBER name is used to make the mis-classification observable, the two
/// owning enums both live in <c>Alpha</c> on purpose: <c>ModelIndex.EnumsDeclaring(context, member)</c>
/// is already context-scoped (#1739), so an enum in an unrelated context would be filtered out before
/// it could ever win. The ambiguity has to be genuine and local for the missing enum HINT to matter.</para>
/// </remarks>
public class CSharpFlatClassifyCrossContextTests
{
    /// <summary>
    /// The colliding context: it declares <c>Status</c> as a <c>value</c>, which is what wins
    /// <c>ModelIndex</c>'s flat table whenever this context is declared last.
    /// </summary>
    private const string ZetaStatusValue = """
        context Zeta {
          value Status { code: String }
        }
        """;

    /// <summary>Assembles a model with the colliding context either before or after <paramref name="alpha"/>.</summary>
    private static string Model(string alpha, bool zetaLast, string zeta = ZetaStatusValue) =>
        zetaLast ? alpha + "\n\n" + zeta : zeta + "\n\n" + alpha;

    private static string EmitFile(string source, string pathSuffix)
    {
        CompileResult result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith(pathSuffix, StringComparison.Ordinal)).Contents;
    }

    private static IReadOnlyList<EmittedFile> EmitAll(string source)
    {
        CompileResult result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files;
    }

    // ------------------------------------------------------------------
    // CSharpEmitter.cs AppendParam + WriteEnumDefaultCoalesce
    // ------------------------------------------------------------------

    /// <summary>
    /// An entity member with an enum-typed DEFAULT. A smart-enum value is not a C# compile-time
    /// constant, so the parameter must become nullable (<c>Status? lifecycle = null</c>) and the body
    /// must coalesce it (<c>lifecycle ??= Status.Draft;</c>). Mis-classified as a plain value, the
    /// emitter writes <c>Status lifecycle = Status.Draft</c> — CS1736, uncompilable.
    /// </summary>
    private const string EnumDefaultAlpha = """
        context Alpha {
          enum Status { Draft, Active }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              lifecycle: Status = Draft
            }
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Enum_typed_member_default_is_classified_in_its_own_context(bool zetaLast)
    {
        var order = EmitFile(Model(EnumDefaultAlpha, zetaLast), "/Order.cs");

        order.ShouldContain("Status? lifecycle = null");
        order.ShouldContain("lifecycle ??= Status.Draft;");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Enum_typed_member_default_emits_compiling_csharp(bool zetaLast)
    {
        // Only Roslyn catches the mis-classified form: `Status lifecycle = Status.Draft` is a
        // non-constant default value (CS1736), which neither validation nor a snapshot notices.
        var (assembly, errors) = TestSupport.Compile(EmitAll(Model(EnumDefaultAlpha, zetaLast)));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    // ------------------------------------------------------------------
    // CSharpEmitter.cs WriteCommand (transition) + CSharpExpressionTranslator EnumTypeName
    // ------------------------------------------------------------------

    /// <summary>
    /// A transition whose target is a bare enum member shared by two of <c>Alpha</c>'s own enums.
    /// The transition field's declared type is the only thing that disambiguates it, so losing the
    /// enum classification silently binds the WRONG enum (<c>Phase.Active</c>, declared last).
    /// </summary>
    private const string TransitionAlpha = """
        context Alpha {
          enum Status { Draft, Active }
          enum Phase { Active, Done }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              lifecycle: Status
              phase: Phase

              command activate {
                lifecycle -> Active
              }
            }
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Transition_target_enum_is_classified_in_its_own_context(bool zetaLast)
    {
        var order = EmitFile(Model(TransitionAlpha, zetaLast), "/Order.cs");

        order.ShouldContain("Lifecycle = Status.Active;");
        order.ShouldNotContain("Phase.Active");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Transition_target_enum_emits_compiling_csharp(bool zetaLast)
    {
        var (assembly, errors) = TestSupport.Compile(EmitAll(Model(TransitionAlpha, zetaLast)));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    /// <summary>
    /// A <c>requires</c> comparison against a bare, shared enum member: the hint comes from the OTHER
    /// operand's inferred type (<c>CSharpExpressionTranslator.EnumTypeName</c>), which classifies that
    /// type through the model index.
    /// </summary>
    private const string RequiresAlpha = """
        context Alpha {
          enum Status { Draft, Active }
          enum Phase { Active, Done }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              lifecycle: Status
              phase: Phase

              command touch {
                requires lifecycle != Active "an active order cannot be touched"
                code -> "touched"
              }
            }
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Comparison_operand_enum_is_classified_in_its_own_context(bool zetaLast)
    {
        var order = EmitFile(Model(RequiresAlpha, zetaLast), "/Order.cs");

        order.ShouldContain("Status.Active");
        order.ShouldNotContain("Phase.Active");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Comparison_operand_enum_emits_compiling_csharp(bool zetaLast)
    {
        var (assembly, errors) = TestSupport.Compile(EmitAll(Model(RequiresAlpha, zetaLast)));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    // ------------------------------------------------------------------
    // CSharpEmitter.cs factory constructor argument
    // ------------------------------------------------------------------

    private const string FactoryAlpha = """
        context Alpha {
          enum Status { Draft, Active }
          enum Phase { Active, Done }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              lifecycle: Status
              phase: Phase

              create open(phase: Phase) {
                lifecycle -> Active
              }
            }
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Factory_constructor_argument_enum_is_classified_in_its_own_context(bool zetaLast)
    {
        var order = EmitFile(Model(FactoryAlpha, zetaLast), "/Order.cs");

        order.ShouldContain("lifecycle: Status.Active");
        order.ShouldNotContain("lifecycle: Phase.Active");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Factory_constructor_argument_enum_emits_compiling_csharp(bool zetaLast)
    {
        var (assembly, errors) = TestSupport.Compile(EmitAll(Model(FactoryAlpha, zetaLast)));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    // ------------------------------------------------------------------
    // CSharpEmitter.Behaviors.cs EmitService
    // ------------------------------------------------------------------

    private const string ServiceAlpha = """
        context Alpha {
          enum Status { Draft, Active }
          enum Phase { Active, Done }

          service Router {
            operation pick(): Status = Active
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Service_operation_return_enum_is_classified_in_its_own_context(bool zetaLast)
    {
        var router = EmitFile(Model(ServiceAlpha, zetaLast), "/Router.cs");

        router.ShouldContain("=> Status.Active;");
        router.ShouldNotContain("Phase.Active");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Service_operation_return_enum_emits_compiling_csharp(bool zetaLast)
    {
        var (assembly, errors) = TestSupport.Compile(EmitAll(Model(ServiceAlpha, zetaLast)));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    // ------------------------------------------------------------------
    // CSharpEmitter.Cqrs.cs EmitReadModel
    // ------------------------------------------------------------------

    private const string ReadModelAlpha = """
        context Alpha {
          enum Status { Draft, Active }
          enum Phase { Active, Done }

          aggregate Sales root Order {
            entity Order identified by OrderId {
              code: String
              lifecycle: Status
              phase: Phase
            }
          }

          readmodel OrderRow from Order {
            code
            stage: Status = if code.length > 0 then Draft else Active
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Read_model_projection_enum_is_classified_in_its_own_context(bool zetaLast)
    {
        var row = EmitFile(Model(ReadModelAlpha, zetaLast), "/OrderRow.cs");

        row.ShouldContain("Status.Active");
        row.ShouldNotContain("Phase.Active");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Read_model_projection_enum_emits_compiling_csharp(bool zetaLast)
    {
        var (assembly, errors) = TestSupport.Compile(EmitAll(Model(ReadModelAlpha, zetaLast)));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    // ------------------------------------------------------------------
    // CSharpExpressionTranslator constructor (derived-member ExpectedEnum)
    // ------------------------------------------------------------------

    /// <summary>
    /// A DERIVED member of enum type, referenced from an invariant guard. The guard runs at the top of
    /// the constructor, before any assignment, so #1756 substitutes the derivation inline over the
    /// constructor PARAMETERS — and the substituted body is rendered under the expected-enum hint the
    /// translator's constructor computed for that member.
    /// </summary>
    /// <remarks>
    /// The derived PROPERTY body is rendered from a SECOND helper — <c>CSharpEmitter.EnumExpected</c> —
    /// which was left flat when the translator's constructor was fixed, so the two disagreed about the
    /// same member: the guard qualified it against <c>Status</c> while the property body emitted
    /// <c>=&gt; (Urgent ? Phase.Active : Status.Draft)</c> (CS0029). Both are now classified in the
    /// emitting context, which is why this fixture is compile-asserted like every other one here.
    /// </remarks>
    private const string DerivedMemberAlpha = """
        context Alpha {
          enum Status { Draft, Active }
          enum Phase { Active, Done }

          value Ticket {
            urgent: Bool
            lifecycle: Status = if urgent then Active else Draft
            invariant lifecycle != Active "a new ticket cannot already be active"
          }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Derived_member_expected_enum_is_classified_in_its_own_context(bool zetaLast)
    {
        var ticket = EmitFile(Model(DerivedMemberAlpha, zetaLast), "/Ticket.cs");

        ticket.ShouldContain("(urgent ? Status.Active : Status.Draft)");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Derived_member_expected_enum_emits_compiling_csharp(bool zetaLast)
    {
        // The derived PROPERTY body comes from CSharpEmitter.EnumExpected, not the translator's
        // constructor. While that helper stayed flat, the two hints disagreed on the same member and the
        // property emitted `=> (Urgent ? Phase.Active : Status.Draft)` — CS0029 (cannot convert
        // 'Alpha.Phase' to 'Alpha.Status'), which only Roslyn catches.
        var (assembly, errors) = TestSupport.Compile(EmitAll(Model(DerivedMemberAlpha, zetaLast)));

        errors.ShouldBeEmpty();
        assembly.ShouldNotBeNull();
    }

    // ------------------------------------------------------------------
    // CSharpEmitter.ValueObjects.cs WriteQuantityOperators
    // ------------------------------------------------------------------

    /// <summary>
    /// A quantity's unit member is found by classifying each stored field's type as an enum. Lose that
    /// and the quantity silently emits NO unit-checked arithmetic at all.
    /// </summary>
    private const string QuantityAlpha = """
        context Alpha {
          enum MassUnit { Gram, Kilogram }

          quantity Weight {
            amount: Decimal
            unit: MassUnit
          }
        }
        """;

    private const string ZetaMassUnitValue = """
        context Zeta {
          value MassUnit { code: String }
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Quantity_unit_enum_is_classified_in_its_own_context(bool zetaLast)
    {
        var weight = EmitFile(Model(QuantityAlpha, zetaLast, ZetaMassUnitValue), "/Weight.cs");

        weight.ShouldContain("public static Weight operator +(Weight left, Weight right)");
        weight.ShouldContain("public static Weight operator *(Weight left, int right)");
    }
}
