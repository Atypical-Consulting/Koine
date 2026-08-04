using System.Reflection;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1897 — the seams <see cref="FlatModelIndexLookupGuardTests"/> did not scan. That guard
/// covered only <c>Classify(string)</c>/<c>TryGetDecl(string, out)</c>, so four more flat entry points
/// into <see cref="ModelIndex"/>'s last-declaration-wins <c>_byName</c> view — <c>IsEnumType(string)</c>,
/// <c>IsKnownType(string)</c>, <c>TryGetMemberType(string, string, out)</c> and <c>MemberNames(string)</c>
/// — reached it unpoliced. Widening the scan surfaced <b>sixteen</b> call sites.
/// </summary>
/// <remarks>
/// <para>Every behavioural fixture here ships in BOTH context declaration orders and asserts the SAME
/// answer in each. That is not ceremony: the flat table is filled by walking <c>model.Contexts</c> in
/// order, so whichever context is declared LAST wins it — a one-order assertion can pass purely because
/// that order happened to be the lucky one, which is precisely how this family kept re-opening.</para>
/// <para>The first two tests are of a different kind: they pin the ARGUMENTS two allowlist entries in
/// <see cref="FlatModelIndexLookupGuardTests"/> rest on. An allowlist reason that has quietly stopped
/// being true is worse than no entry at all, so the reasoning is executable rather than prose-only.</para>
/// </remarks>
public class ModelIndexFlatSeamEquivalenceTests
{
    /// <summary><c>Catalog</c> first, so <c>Support</c>'s <c>value Status</c> is indexed last and wins
    /// the flat table.</summary>
    private const string CatalogFirst = """
        context Catalog {
          enum Status { Draft, Active }

          value Listing {
            title:  String
            status: Status = Draft
          }
        }

        context Support {
          value Status {
            code: String
          }

          value Ticket {
            subject: String
            status:  Status
          }
        }
        """;

    /// <summary>The identical model with the two <c>context</c> blocks swapped.</summary>
    private const string SupportFirst = """
        context Support {
          value Status {
            code: String
          }

          value Ticket {
            subject: String
            status:  Status
          }
        }

        context Catalog {
          enum Status { Draft, Active }

          value Listing {
            title:  String
            status: Status = Draft
          }
        }
        """;

    public static TheoryData<string, string> BothOrders => new()
    {
        { nameof(CatalogFirst), CatalogFirst },
        { nameof(SupportFirst), SupportFirst },
    };

    /// <summary>A scope with no locals — the receiver in these fixtures is a TYPE name, not a field.</summary>
    private static TypeScope EmptyScope => new(Array.Empty<KeyValuePair<string, KoineType>>());

    private static SemanticModel Build(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    // ------------------------------------------------------------------------
    // The two allowlist justifications, made executable
    // ------------------------------------------------------------------------

    /// <summary>
    /// Pins the claim that lets every remaining <c>IsKnownType(string)</c> site stay allowlisted:
    /// <c>IsKnownType(ctx, n)</c> and <c>IsKnownType(n)</c> cannot disagree. <c>Classify(ctx, n)</c>
    /// either returns <c>ClassifyDecl(decl)</c> for a context-local hit or falls through to the flat
    /// <c>Classify(n)</c>, and <c>ClassifyDecl</c> never yields <c>Unknown</c> for a real declaration
    /// (see the exhaustiveness test below) — so the boolean is a pure function of the NAME.
    /// </summary>
    [Theory]
    [MemberData(nameof(BothOrders))]
    public void IsKnownType_answers_identically_with_and_without_a_context(string order, string src)
    {
        ModelIndex index = Build(src).Index;

        string[] contexts = ["Catalog", "Support", "Nonexistent"];
        string[] names =
        [
            "Status", "Listing", "Ticket",          // declared — one of them in BOTH contexts
            "String", "Int", "Decimal", "Bool",     // built-ins
            "List", "Set", "Map", "Range",          // collection/range keywords
            "OrderId",                              // the *Id convention
            "NoSuchTypeAnywhere",                   // genuinely unknown
        ];

        foreach (string name in names)
        {
            bool flat = index.IsKnownType(name);

            index.IsKnownType(null, name).ShouldBe(
                flat, $"[{order}] IsKnownType(null, \"{name}\") must match the flat answer");

            foreach (string context in contexts)
            {
                index.IsKnownType(context, name).ShouldBe(
                    flat,
                    $"[{order}] IsKnownType(\"{context}\", \"{name}\") diverged from the flat IsKnownType(\"{name}\"). " +
                    "The allowlist entries for the remaining IsKnownType(string) sites in " +
                    "FlatModelIndexLookupGuardTests rest on these two never disagreeing — fix those sites " +
                    "or re-argue the entries.");
            }
        }
    }

    /// <summary>
    /// The load-bearing half of the equivalence above: <c>ModelIndex.ClassifyDecl</c>'s switch must
    /// cover every concrete <see cref="TypeDecl"/> subtype, or its <c>_ => Unknown</c> arm becomes
    /// reachable and a context-local hit could classify as <c>Unknown</c> while the flat view answers
    /// "known". Add a ninth <c>TypeDecl</c> and this fails before the allowlist silently rots.
    /// </summary>
    [Fact]
    public void ClassifyDecl_covers_every_concrete_TypeDecl_subtype()
    {
        // The subtypes ClassifyDecl (ModelIndex.cs) enumerates, and therefore the ones the equivalence
        // proof above is allowed to assume are the whole world.
        string[] classified =
        [
            nameof(ValueObjectDecl), nameof(EntityDecl), nameof(AggregateDecl), nameof(EnumDecl),
            nameof(EventDecl), nameof(IntegrationEventDecl), nameof(ReadModelDecl), nameof(QueryDecl),
        ];

        var concrete = typeof(TypeDecl).Assembly
            .GetTypes()
            .Where(t => t is { IsAbstract: false, IsClass: true } && typeof(TypeDecl).IsAssignableFrom(t))
            .Select(t => t.Name)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray();

        concrete.ShouldBe(
            classified.OrderBy(n => n, StringComparer.Ordinal).ToArray(),
            "ModelIndex.ClassifyDecl's switch and the concrete TypeDecl subtypes have drifted apart. " +
            "Every concrete TypeDecl must map to a non-Unknown TypeKind, otherwise " +
            "IsKnownType(context, name) can answer false where IsKnownType(name) answers true — which " +
            "is exactly the equivalence the IsKnownType allowlist entries in " +
            "FlatModelIndexLookupGuardTests depend on.");
    }

    // ------------------------------------------------------------------------
    // Ast/ — Binder.ResolveMemberAccessSelector and TypeResolver.VisitMemberAccess (IsEnumType)
    // ------------------------------------------------------------------------

    /// <summary>
    /// <c>Binder.ResolveMemberAccessSelector</c> asked <c>IsEnumType(id.Name)</c> while
    /// <c>_enclosingContextName</c> sat in a field it used two lines later. In <c>Support</c> — which
    /// declares <c>Status</c> as a VALUE — a <c>Status.Draft</c>-shaped access must never bind to
    /// <c>Catalog</c>'s enum member just because <c>Catalog</c> happens to be indexed last.
    /// </summary>
    [Theory]
    [MemberData(nameof(BothOrders))]
    public void Qualified_enum_reference_types_from_the_referencing_context(string order, string src)
    {
        SemanticModel sema = Build(src);

        // `Status.Draft` as seen from Catalog (an enum there) versus from Support (a value there).
        var access = new MemberAccessExpr(new IdentifierExpr("Status"), "Draft");

        KoineType fromCatalog = sema.GetTypeInfo(access, EmptyScope, "Catalog");
        KoineType fromSupport = sema.GetTypeInfo(access, EmptyScope, "Support");

        fromCatalog.Kind.ShouldBe(
            TypeKind.Enum,
            $"[{order}] Catalog declares `enum Status`, so `Status.Draft` is a qualified enum reference there");

        fromSupport.Kind.ShouldNotBe(
            TypeKind.Enum,
            $"[{order}] Support declares `value Status` — nothing there makes `Status.Draft` an enum " +
            "reference, and the flat IsEnumType let Catalog's enum answer for it by source order");
    }

    // ------------------------------------------------------------------------
    // Services/ — SemanticTokenProvider.CollectPropertyNames (MemberNames)
    // ------------------------------------------------------------------------

    /// <summary>
    /// <c>CollectPropertyNames</c> walked <c>AllTypes()</c> — which correctly yields BOTH same-named
    /// declarations — but then re-looked each one up by NAME through the flat view, so it read the
    /// winner's members twice and never collected the loser's. The losing <c>Status</c>'s field was
    /// therefore missing from property highlighting entirely.
    /// </summary>
    [Theory]
    [MemberData(nameof(BothOrders))]
    public void Property_name_highlighting_collects_both_same_named_types_members(string order, string src)
    {
        ModelIndex index = Build(src).Index;

        var collected = new HashSet<string>(StringComparer.Ordinal);
        foreach (TypeDecl t in index.AllTypes())
        {
            foreach (string n in ModelIndex.MemberNamesOf(t))
            {
                collected.Add(n);
            }
        }

        collected.ShouldContain("code", $"[{order}] Support.Status declares `code`");
        collected.ShouldContain("title", $"[{order}] Catalog.Listing declares `title`");
        collected.ShouldContain("subject", $"[{order}] Support.Ticket declares `subject`");
    }

    /// <summary>The same claim through the real editor entry point: every declared field name is
    /// classified as a property token, whichever context declared it.</summary>
    [Theory]
    [MemberData(nameof(BothOrders))]
    public void Semantic_tokens_classify_both_contexts_fields_as_properties(string order, string src)
    {
        IReadOnlyList<SemanticToken> tokens = new SemanticTokenProvider().Tokenize(src);

        // `code` is Support.Status's only field; it is the member the flat lookup dropped whenever
        // Catalog's `enum Status` (which has no `code`) won the _byName slot.
        int codeLine = src.Split('\n').ToList().FindIndex(l => l.Contains("code:", StringComparison.Ordinal));
        codeLine.ShouldBeGreaterThanOrEqualTo(0);

        tokens.ShouldContain(
            t => t.Line == codeLine && t.Type == SemanticTokenType.Property,
            $"[{order}] Support.Status's `code` field must highlight as a property");
    }

    // ------------------------------------------------------------------------
    // Emit/ — OpenApiEmitter.ReadModelSchema (TryGetMemberType)
    // ------------------------------------------------------------------------

    /// <summary><c>Catalog</c>'s <c>Item.note</c> is a <c>String</c>; <c>Support</c>'s is an <c>Int</c>,
    /// and Support is the context that projects it. Whichever <c>Item</c> is indexed last wins the flat
    /// table, so the flat member lookup typed the projected field by source order.</summary>
    private const string ReadModelCatalogFirst = """
        context Catalog {
          entity Item identified by ItemId {
            note: String
          }
        }

        context Support {
          entity Item identified by ItemId {
            note: Int
          }

          readmodel ItemView from Item {
            id
            note
          }
        }
        """;

    /// <summary>The identical model with the two <c>context</c> blocks swapped.</summary>
    private const string ReadModelSupportFirst = """
        context Support {
          entity Item identified by ItemId {
            note: Int
          }

          readmodel ItemView from Item {
            id
            note
          }
        }

        context Catalog {
          entity Item identified by ItemId {
            note: String
          }
        }
        """;

    public static TheoryData<string, string> BothReadModelOrders => new()
    {
        { nameof(ReadModelCatalogFirst), ReadModelCatalogFirst },
        { nameof(ReadModelSupportFirst), ReadModelSupportFirst },
    };

    /// <summary>
    /// <c>ReadModelSchema</c> computed <c>sourceContext</c> via <c>ResolveOwner</c> — and then resolved
    /// the source member through the FLAT overload anyway, contradicting the very next call
    /// (<c>QualifyForeignReference</c>, which does use it). A read model must take its direct fields'
    /// types from its SOURCE type's own context under either declaration order.
    /// </summary>
    [Theory]
    [MemberData(nameof(BothReadModelOrders))]
    public void Read_model_schema_resolves_direct_fields_in_the_source_types_own_context(string order, string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();

        IReadOnlyList<EmittedFile> files = new OpenApiEmitter().Emit(model);
        string yaml = string.Join("\n", files.Select(f => f.Contents));

        int viewAt = yaml.IndexOf("ItemView", StringComparison.Ordinal);
        viewAt.ShouldBeGreaterThanOrEqualTo(0, $"[{order}] the ItemView schema should be emitted");

        // The `note` property inside the ItemView schema, typed from Support's own Item.
        string viewSchema = yaml[viewAt..];
        int noteAt = viewSchema.IndexOf("note:", StringComparison.Ordinal);
        noteAt.ShouldBeGreaterThanOrEqualTo(0, $"[{order}] ItemView projects `note`");

        string noteProperty = viewSchema[noteAt..Math.Min(noteAt + 120, viewSchema.Length)];

        noteProperty.ShouldContain(
            "integer",
            customMessage:
            $"[{order}] ItemView is declared in Support, whose Item.note is an Int. The flat " +
            "TryGetMemberType contradicted the sourceContext ResolveOwner had already computed two " +
            $"lines above, so the schema could take Catalog's String instead. Emitted:\n{noteProperty}");
    }
}
