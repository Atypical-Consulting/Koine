using Koine.Compiler.Services;
using Xunit;

namespace Koine.Compiler.Tests;

/// <summary>
/// OpenAPI 3.1 spec emitter (issue #126): proves <c>--target openapi</c> turns a validated model into
/// a deterministic OpenAPI YAML document per bounded context. Schema/path output is snapshot-tested via
/// Verify; structural facts are asserted directly. Changes to emitter output must be reviewed through
/// the <c>.verified.txt</c> diff.
/// </summary>
public class R18OpenApiEmitterTests(ITestOutputHelper output)
{
    private readonly ITestOutputHelper _output = output;

    [Fact]
    public void Target_name_is_openapi() =>
        new OpenApiEmitter().TargetName.ShouldBe("openapi");

    [Fact]
    public void Emits_an_openapi_3_1_document_per_context()
    {
        const string src = """
            context Billing {
              value Money { amount: Decimal }
            }
            """;

        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("billing.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var file = result.Files.ShouldHaveSingleItem();
        file.RelativePath.ShouldEndWith("openapi.yaml");
        file.Contents.ShouldContain("openapi: 3.1.0");
        file.Contents.ShouldContain("info:");
    }

    /// <summary>The §catalog fixture exercises every Task 2 schema kind in one document.</summary>
    private const string CatalogFixture = """
        context Catalog {
          /// A supported settlement currency.
          enum Currency(symbol: String, decimals: Int) {
            EUR("€", 2)
            USD("$", 2)
          }

          value Money {
            amount: Decimal
            currency: Currency
          }

          value Product {
            sku: String
            name: String
            price: Money
            tags: List<String>
            discount: Decimal?
          }

          aggregate Catalog root Item {
            entity Item identified by ItemId {
              sku: String
              price: Money
            }
          }

          readmodel ItemRow from Item {
            sku
            price
          }
        }
        """;

    [Fact]
    public Task Schemas_from_value_objects_read_models_and_enums()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("catalog.koi", CatalogFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("components:");
        yaml.ShouldContain("schemas:");

        // One named schema per value object, read model, and enum.
        yaml.ShouldContain("Currency:");
        yaml.ShouldContain("Money:");
        yaml.ShouldContain("Product:");
        yaml.ShouldContain("ItemRow:");

        // The smart enum lowers to a string enum of its member names.
        yaml.ShouldContain("enum:");
        yaml.ShouldContain("- EUR");
        yaml.ShouldContain("- USD");

        // Nested value objects / enums are referenced, collections become arrays, optional is nullable.
        yaml.ShouldContain("$ref: \"#/components/schemas/Money\"");
        yaml.ShouldContain("type: array");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    /// <summary>The §constraints fixture carries static length, regex, and numeric value-object invariants.</summary>
    private const string ConstraintsFixture = """
        context Catalog {
          value Sku {
            code: String
            invariant code.length >= 3 "a SKU has at least three characters"
            invariant code.length <= 12 "a SKU has at most twelve characters"
            invariant code matches /[A-Z]{3}-[0-9]+/ "three letters, a dash, then digits"
          }

          value Quantity {
            amount: Int
            invariant amount >= 1 "at least one unit"
            invariant amount <= 999 "at most 999 units"
          }
        }
        """;

    [Fact]
    public Task Static_value_object_invariants_lower_to_schema_keywords()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("constraints.koi", ConstraintsFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // The string length bound and the regex lower onto the `code` property's schema.
        yaml.ShouldContain("minLength: 3");
        yaml.ShouldContain("maxLength: 12");
        yaml.ShouldContain("pattern: \"[A-Z]{3}-[0-9]+\"");

        // The numeric bounds lower onto the `amount` property's schema.
        yaml.ShouldContain("minimum: 1");
        yaml.ShouldContain("maximum: 999");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    /// <summary>The §ordering fixture pairs an entity command with a query so both path shapes appear.</summary>
    private const string OrderingFixture = """
        context Ordering {
          enum OrderStatus { Draft, Submitted, Cancelled }

          value Money { amount: Decimal }

          aggregate Order root Order {
            entity Order identified by OrderId {
              total: Money
              status: OrderStatus = Draft

              /// Submit a draft order for fulfilment.
              command submit(note: String) {
                requires status == Draft "only a draft order can be submitted"
                status -> Submitted
              }
            }
          }

          readmodel OrderRow from Order {
            status
          }

          /// All orders in a given lifecycle state.
          query OrdersByStatus(status: OrderStatus): List<OrderRow>
        }
        """;

    [Fact]
    public Task Paths_map_commands_to_post_and_queries_to_get()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", OrderingFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("paths:");

        // A command becomes a POST with a JSON request body built from its parameters.
        yaml.ShouldContain("/order/submit:");
        yaml.ShouldContain("post:");
        yaml.ShouldContain("requestBody:");

        // A query becomes a GET with its criteria as query parameters.
        yaml.ShouldContain("/orders-by-status:");
        yaml.ShouldContain("get:");
        yaml.ShouldContain("parameters:");
        yaml.ShouldContain("in: query");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    /// <summary>A factory whose repository exposes <c>add</c> — the fixture the C# <c>api</c> layer would
    /// also map (#1747).</summary>
    private const string FactoryFixture = """
        context Ordering {
          aggregate Order root Order {
            repository {
              operations: add, getById
            }

            entity Order identified by OrderId {
              /// Open a new order for a customer.
              create open(customer: String) {
              }
            }
          }
        }
        """;

    [Fact]
    public void Paths_map_factories_to_post_with_a_created_response()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", FactoryFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("/order/open:");
        yaml.ShouldContain("post:");
        yaml.ShouldContain("operationId: Order_open");
        yaml.ShouldContain("summary: \"Open a new order for a customer.\"");
        yaml.ShouldContain("requestBody:");
        yaml.ShouldContain("required: true");
        yaml.ShouldContain("\"200\":");
        yaml.ShouldContain("description: \"The created Order.\"");
        yaml.ShouldContain("\"400\":");
        yaml.ShouldContain("description: \"A precondition or invariant was violated.\"");
    }

    /// <summary>The deliberate superset (#1747): a factory on an aggregate whose repository does NOT
    /// expose <c>add</c> still gets an OpenAPI operation, even though <c>CSharpEmitter.Api.cs</c> would
    /// emit no endpoint for it (gated on <c>repoOps.Contains("add")</c>).</summary>
    private const string FactoryWithoutAddFixture = """
        context Ordering {
          aggregate Order root Order {
            repository {
              operations: getById
            }

            entity Order identified by OrderId {
              create open(customer: String) {
              }
            }
          }
        }
        """;

    [Fact]
    public void Paths_map_a_factory_even_when_the_repository_omits_add()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", FactoryWithoutAddFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("/order/open:");
        yaml.ShouldContain("operationId: Order_open");
    }

    /// <summary>A factory carrying all three R19 axes at once (#1846) — an authored, token-carrying path,
    /// an overridden verb, and a role — the shape a command's <see cref="AnnotatedOrderingFixture"/>
    /// exercises, now on the declaration kind that was conventional-only until #1846.</summary>
    private const string AnnotatedFactoryFixture = """
        context Ordering {
          aggregate Order root Order {
            entity Order identified by OrderId {
              /// Open a new order for a customer.
              @route("/orders/{customer}")
              @put
              @auth("admin")
              create open(customer: CustomerId) {
              }
            }
          }
        }
        """;

    /// <summary>
    /// The annotated factory's operation is keyed under the <c>@route</c> path and the <c>@put</c> verb —
    /// the conventional <c>POST /order/open</c> is gone entirely — and every <c>{token}</c> of that path
    /// is declared as a required <c>in: path</c> parameter typed off what it binds to, exactly as a
    /// command's is.
    /// </summary>
    [Fact]
    public void Paths_honor_a_factorys_route_and_verb_annotations()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", AnnotatedFactoryFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("\"/orders/{customer}\":");
        yaml.ShouldContain("put:");
        yaml.ShouldNotContain("post:");
        yaml.ShouldNotContain("/order/open:");
        yaml.ShouldContain("operationId: Order_open");
        yaml.ShouldContain("summary: \"Open a new order for a customer.\"");

        // The path token is declared, and typed off the parameter it name-matches (a factory has no
        // identity fallback — it mints the identity it creates).
        yaml.ShouldContain("- name: customer");
        yaml.ShouldContain("in: path");

        // The created aggregate is still the 200, unchanged by the annotations.
        yaml.ShouldContain("description: \"The created Order.\"");
    }

    /// <summary>A factory's <c>@auth("role")</c> lowers to the identical per-operation security
    /// requirement a command's does (<see cref="Paths_honor_the_route_verb_and_auth_annotations"/>) —
    /// both go through <c>OpenApiEmitter.Paths.AddSecurity</c> off the shared <c>RouteInfo</c>.</summary>
    [Fact]
    public void A_factorys_auth_annotation_emits_the_same_security_shape_a_commands_does()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", AnnotatedFactoryFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("security:");
        yaml.ShouldContain("- admin: []");
    }

    /// <summary>
    /// The same real-validator harness the annotated command document goes through (#1219 code review):
    /// substring assertions cannot see a <c>path-parameters-defined</c> violation, which is precisely the
    /// class of bug an authored <c>@route</c> on a new declaration kind can reintroduce. INCONCLUSIVE
    /// when no validator is available — see <see cref="ExternallyValidate"/>.
    /// </summary>
    [Fact]
    public void Annotated_factory_document_passes_external_openapi_validation_when_available() =>
        ExternallyValidate(AnnotatedFactoryFixture);

    [Fact]
    public void Model_with_no_commands_or_queries_emits_an_empty_paths_object()
    {
        const string src = """
            context Reference {
              enum Color { Red, Green, Blue }
              value Point { x: Int  y: Int }
            }
            """;

        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("reference.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("openapi: 3.1.0");
        // No behavioral surface → an empty (but present, as the spec requires) paths object …
        yaml.ShouldContain("paths: {}");
        // … while the schemas are still declared.
        yaml.ShouldContain("components:");
        yaml.ShouldContain("Point:");
        yaml.ShouldContain("Color:");
    }

    [Fact]
    public void Truly_empty_context_omits_the_components_block()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("empty.koi", "context Empty { }\n") }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("openapi: 3.1.0");
        yaml.ShouldContain("paths: {}");
        // Nothing to declare → no dangling, empty `components: {}`.
        yaml.ShouldNotContain("components:");
    }

    [Fact]
    public void Emitted_document_passes_external_openapi_validation_when_available() =>
        // A rich model exercising schemas, refs, paths, parameters, and lowered keywords in one doc.
        ExternallyValidate(OrderingFixture);

    /// <summary>
    /// Compiles <paramref name="fixture"/> to an OpenAPI document and runs it through a real external
    /// validator when one is available. INCONCLUSIVE otherwise: validation is opt-in (set
    /// <c>KOINE_OPENAPI_VALIDATE</c>) and needs a validator on PATH. Mirrors the TS/Python/Rust
    /// external-toolchain conformance pattern — skip, never fail.
    /// </summary>
    private void ExternallyValidate(string fixture)
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", fixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.ValidateOpenApi(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine("OpenAPI validation not enabled or no validator found; skipping conformance check.");
            return;
        }

        check.Ok.ShouldBeTrue("expected the emitted OpenAPI document to validate:\n" + string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // R19 (#1219) — the openapi document reflects the @route / @get|@post|
    // @put|@delete|@patch / @auth annotations, via the shared RouteDerivation.
    // The three axes are independent, so an un-annotated model's document
    // (the OrderingFixture snapshot above) stays byte-identical.
    // ------------------------------------------------------------------

    /// <summary>
    /// The §annotated fixture points two commands at the same overridden path under different verbs — so
    /// the emitted <c>paths</c> must merge them under one key — while the query carries only
    /// <c>@auth</c> and therefore keeps its conventional <c>GET /orders-by-status</c>.
    /// </summary>
    private const string AnnotatedOrderingFixture = """
        context Ordering {
          enum OrderStatus { Draft, Submitted, Cancelled }

          aggregate Order root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft

              /// Submit a draft order for fulfilment.
              @route("/orders/{id}")
              @put
              @auth("admin")
              command submit(note: String) {
                requires status == Draft "only a draft order can be submitted"
                status -> Submitted
              }

              /// Cancel an order that has not shipped yet.
              @route("/orders/{id}")
              @delete
              command cancel {
                requires status == Submitted "only a submitted order can be cancelled"
                status -> Cancelled
              }
            }
          }

          readmodel OrderRow from Order {
            status
          }

          /// All orders in a given lifecycle state.
          @auth("analyst")
          query OrdersByStatus(status: OrderStatus): List<OrderRow>
        }
        """;

    [Fact]
    public Task Paths_honor_the_route_verb_and_auth_annotations()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", AnnotatedOrderingFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // The overridden path replaces the conventional one, and the verb key follows @put/@delete.
        yaml.ShouldContain("\"/orders/{id}\":");
        yaml.ShouldNotContain("/order/submit:");
        yaml.ShouldNotContain("/order/cancel:");
        yaml.ShouldContain("put:");
        yaml.ShouldContain("delete:");
        yaml.ShouldNotContain("post:");

        // @auth("role") becomes an OpenAPI security-requirement object on the operation.
        yaml.ShouldContain("security:");
        yaml.ShouldContain("- admin: []");

        // The query moved neither path nor verb — only its role axis was annotated.
        yaml.ShouldContain("/orders-by-status:");
        yaml.ShouldContain("get:");
        yaml.ShouldContain("- analyst: []");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    /// <summary>
    /// Two commands overriding to the same <c>@route</c> must merge under a single path key carrying both
    /// verbs — a second entry for the same key would be a duplicate YAML mapping key, and an overwrite
    /// would silently drop an operation.
    /// </summary>
    [Fact]
    public void Commands_sharing_an_overridden_route_merge_under_one_path_key()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", AnnotatedOrderingFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        var lines = yaml.Split('\n');

        lines.Count(l => l.Trim() == "\"/orders/{id}\":").ShouldBe(1);
        lines.Count(l => l.Trim() == "put:").ShouldBe(1);
        lines.Count(l => l.Trim() == "delete:").ShouldBe(1);

        // Both operations survived the merge.
        yaml.ShouldContain("operationId: Order_submit");
        yaml.ShouldContain("operationId: Order_cancel");
    }

    /// <summary>An un-annotated operation gains no <c>security</c> block — the role axis is opt-in.</summary>
    [Fact]
    public void Unannotated_operations_carry_no_security_block()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", OrderingFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        result.Files.ShouldHaveSingleItem().Contents.ShouldNotContain("security:");
    }

    /// <summary>
    /// The annotated document goes through the same real validator as the un-annotated one (#1219 code
    /// review): substring assertions and a Verify snapshot both agreed on output that <c>redocly lint</c>
    /// rejected with two <c>path-parameters-defined</c> errors, because the <c>@route</c> template's
    /// <c>{id}</c> was never declared as a parameter. Pointing the existing harness at this fixture is
    /// what closes that blind spot.
    /// </summary>
    [Fact]
    public void Annotated_document_passes_external_openapi_validation_when_available() =>
        ExternallyValidate(AnnotatedOrderingFixture);

    /// <summary>
    /// OpenAPI requires every <c>{token}</c> of a templated path to be declared as a required
    /// <c>in: path</c> parameter — on <b>each</b> operation under that path, hence twice here.
    /// </summary>
    [Fact]
    public void Route_template_tokens_are_declared_as_path_parameters()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", AnnotatedOrderingFixture) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        var lines = yaml.Split('\n');

        lines.Count(l => l.Trim() == "- name: id").ShouldBe(2);
        lines.Count(l => l.Trim() == "in: path").ShouldBe(2);

        // The un-annotated query keeps its criteria as query parameters, untouched.
        yaml.ShouldContain("in: query");
    }

    /// <summary>
    /// The ASP.NET template syntax a <c>@route</c> may carry is not part of the OpenAPI parameter name:
    /// a constraint, an optional marker and a catch-all all reduce to the bare token, de-duplicated and
    /// in declaration order, and a <c>{{</c>/<c>}}</c> literal-brace escape declares nothing.
    /// </summary>
    [Fact]
    public void Path_parameter_names_strip_route_constraints_and_modifiers()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/tenants/{tenant}/orders/{id:int}/notes/{note?}/files/{*rest}/{{literal}}")
                  @put
                  command submit(note: String) {
                    requires status == Draft "only a draft order can be submitted"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var names = result.Files.ShouldHaveSingleItem().Contents
            .Split('\n')
            .Where(l => l.TrimStart().StartsWith("- name: ", StringComparison.Ordinal))
            .Select(l => l.Trim()["- name: ".Length..])
            .ToArray();

        names.ShouldBe(["tenant", "id", "note", "rest"]);
    }

    /// <summary>
    /// Defence in depth for the KOI1211 collision (#1219 code review): the emitter can be driven without
    /// the validator, and emitting the same verb key twice under one path yields a document no YAML parser
    /// will read. The later operation is dropped deterministically — a lossy document beats an invalid one.
    /// </summary>
    [Fact]
    public void Two_operations_sharing_a_route_and_verb_never_emit_a_duplicate_mapping_key()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted, Cancelled }

              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{id}")
                  @put
                  command submit(note: String) {
                    requires status == Draft "only a draft order can be submitted"
                    status -> Submitted
                  }

                  @route("/orders/{id}")
                  @put
                  command cancel {
                    requires status == Submitted "only a submitted order can be cancelled"
                    status -> Cancelled
                  }
                }
              }
            }
            """;

        // The model is invalid (KOI1211), so the emitter is driven directly rather than through Compile.
        (Ast.KoineModel? model, IReadOnlyList<Diagnostics.Diagnostic> diagnostics) = new KoineCompiler().Parse(src);
        model.ShouldNotBeNull(string.Join("\n", diagnostics.Select(d => d.ToString())));

        var yaml = new OpenApiEmitter().Emit(model!).ShouldHaveSingleItem().Contents;

        yaml.Split('\n').Count(l => l.Trim() == "put:").ShouldBe(1);
        // First wins: the declaration that claimed the (route, verb) pair is the one that survives.
        yaml.ShouldContain("operationId: Order_submit");
        yaml.ShouldNotContain("operationId: Order_cancel");
    }

    // ------------------------------------------------------------------
    // #1748 — a path parameter is typed off its RouteTokenBinding instead of
    // a blanket `string`: the aggregate identity's own strategy (Guid/
    // Sequence/Natural), a member's declared type, or `string` for a token
    // KOI1215 already flags as unbound.
    // ------------------------------------------------------------------

    /// <summary>A Guid-strategy (the default) aggregate identity types its path parameter as a UUID string.</summary>
    [Fact]
    public void An_identity_bound_path_parameter_on_a_guid_entity_is_typed_uuid()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{id}")
                  @put
                  command submit(note: String) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(new[] { new SourceFile("ordering.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("name: id\n          in: path\n          required: true\n          schema:\n            type: string\n            format: uuid");
    }

    /// <summary>A token bound to a member parameter is typed off that parameter's own declared type, not the identity.</summary>
    [Fact]
    public void A_member_bound_path_parameter_is_typed_off_the_parameters_own_type()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{revision}")
                  @put
                  command submit(revision: Int) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(new[] { new SourceFile("ordering.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("name: revision\n          in: path\n          required: true\n          schema:\n            type: integer");
        yaml.ShouldNotContain("format: uuid");
    }

    /// <summary>An unbound token (KOI1215's concern, not this one) still degrades to a bare <c>string</c>, as before #1748.</summary>
    [Fact]
    public void An_unbound_path_parameter_stays_typed_string()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{ref}")
                  @put
                  command submit(note: String) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        // The model carries a KOI1215 warning (an unrelated concern to this test) but Success only
        // reflects Error-severity diagnostics, so Compile still runs the emitter.
        var result = new KoineCompiler().Compile(new[] { new SourceFile("ordering.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;
        yaml.ShouldContain("name: ref\n          in: path\n          required: true\n          schema:\n            type: string");
        yaml.ShouldNotContain("format: uuid");
    }

    // ------------------------------------------------------------------
    // #1961 — Task 2. #1750 found that a `@post` query's emitted C# binds
    // its criteria per PROPERTY (`[AsParameters]`) while this document
    // described every criterion, including a complex one, as an
    // unconditional `in: query` parameter — a client built strictly from
    // this document got a clean 400, since the JSON-body shape ASP.NET
    // actually needed for the complex criterion wasn't documented at all.
    // #1961's Task 1 made WriteQueryEndpoint verb-aware (the WHOLE criteria
    // record binds via a single [FromBody] for a body-taking verb, mirroring
    // the mutation side). QueryOperation now follows the same rule: a
    // body-taking verb's criteria document as a `requestBody` instead of
    // `in: query` parameters — matching the new binding exactly, closing the
    // doc/binding gap this issue exists to close.
    // ------------------------------------------------------------------

    /// <summary>
    /// Pins the fixed <c>@post</c> query documentation: the verb follows the annotation (matching the C#
    /// emitter's <c>MapPost</c>), and the WHOLE criteria record — both the complex <c>range</c> criterion
    /// and the scalar/enum <c>status</c> criterion — documents as a single <c>requestBody</c>, matching
    /// the emitted C# <c>[Microsoft.AspNetCore.Mvc.FromBody] OrdersInRange query</c> binding exactly. An
    /// un-annotated query's document is unaffected: it is the same <see cref="OrderingFixture"/> Verify
    /// snapshot <see cref="Paths_map_commands_to_post_and_queries_to_get"/> already pins, and that
    /// snapshot staying byte-identical across this PR is the un-annotated-query guarantee.
    /// </summary>
    [Fact]
    public void A_post_querys_criteria_are_documented_as_a_request_body()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", R18CSharpApplicationTests.PostQueryComplexCriterionFixture) },
            new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        // The verb follows @post — matching the C# emitter's MapPost for the same model.
        yaml.ShouldContain("/orders-in-range:");
        yaml.ShouldContain("post:");
        yaml.ShouldNotContain("get:");

        // No `in: query` parameters for this operation — the criteria moved into the body.
        yaml.ShouldNotContain("in: query");

        // The whole criteria record — both the complex `range` (a $ref to the DateRange schema) and the
        // scalar/enum `status` — documents as one JSON requestBody object schema.
        yaml.ShouldContain(
            "requestBody:\n        required: true\n        content:\n          application/json:\n" +
            "            schema:\n              type: object\n              properties:\n" +
            "                range:\n                  $ref: \"#/components/schemas/DateRange\"\n" +
            "                status:\n                  $ref: \"#/components/schemas/OrderStatus\"\n" +
            "              required:\n                - range\n                - status");
    }

    /// <summary>
    /// Edge case: a route-token criterion on a `@post` query stays an `in: path` parameter regardless of
    /// verb — only the REMAINING (non-token) criteria move into the requestBody.
    /// </summary>
    [Fact]
    public void A_post_querys_route_token_criterion_stays_a_path_parameter()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted, Cancelled }

              value DateRange {
                startsAt: Instant
                endsAt:   Instant
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft
                }
              }

              readmodel OrderRow from Order {
                status
              }

              @route("/orders/{status}")
              @post
              query OrdersInRangeByStatus(status: OrderStatus, range: DateRange): List<OrderRow>
            }
            """;

        var result = new KoineCompiler().Compile(new[] { new SourceFile("ordering.koi", src) }, new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("\"/orders/{status}\":");
        yaml.ShouldContain("name: status\n          in: path\n          required: true");
        yaml.ShouldContain("requestBody:");
        yaml.ShouldNotContain("in: query");
    }

    /// <summary>An un-annotated (conventional GET) query's document stays byte-identical: only a
    /// body-taking verb's criteria move into a requestBody.</summary>
    [Fact]
    public void Unannotated_querys_criteria_still_document_as_in_query_parameters()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", R18CSharpApplicationTests.PostQueryScalarOnlyCriterionFixture.Replace("@post\n", "")) },
            new OpenApiEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var yaml = result.Files.ShouldHaveSingleItem().Contents;

        yaml.ShouldContain("get:");
        yaml.ShouldNotContain("requestBody:");
        yaml.ShouldContain("name: status\n          in: query\n          required: true\n          schema:\n            $ref: \"#/components/schemas/OrderStatus\"");
    }
}
