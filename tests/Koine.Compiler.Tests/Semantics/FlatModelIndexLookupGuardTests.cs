using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Koine.Compiler.Tests;

/// <summary>
/// <para>
/// Guards against a defect family this repo has now hit close to twenty times (#1632 … #1863):
/// <c>ModelIndex</c> exposes a FLAT, last-declaration-wins lookup (<c>Classify(string)</c>,
/// <c>TryGetDecl(string, out TypeDecl)</c>) alongside a context-aware sibling
/// (<c>Classify(string?, string)</c>, <c>TryGetDecl(string?, string, out TypeDecl)</c>,
/// <c>TryGetDeclIn</c>). R13.2 lets two bounded contexts legally declare a type with the same simple
/// name, so a context-aware caller that reaches for the flat overload anyway gets an answer that
/// silently depends on <c>.koi</c> source order. #1853 closed the shared seam (<c>TryGetDeclIn</c>);
/// #1863 fixed the three residual call sites its own review found and added this test.
/// </para>
/// <para>
/// <b>What this test catches:</b> a Roslyn syntax parse (not a line-based text scan) of every
/// <c>.cs</c> file under <c>src/</c> finds every invocation of a method named <c>Classify</c> with
/// exactly 1 argument, or <c>TryGetDecl</c> with exactly 2 arguments — the flat overloads'
/// unambiguous arity (their context-aware siblings take one more argument). This works regardless of
/// formatting, line-wrapping, or how the argument expression is written, because it inspects the
/// parsed syntax tree, not the source text. Method-name + arity is enough to identify these two
/// specific overloads without full semantic binding <i>in this codebase specifically</i> — verified by
/// auditing every existing call site: no other type exposes a 1-arg <c>Classify</c> or a 2-arg
/// <c>TryGetDecl</c> with an <c>out</c> parameter (<c>BranchReconciliation.Classify</c> is the one
/// unrelated same-named method in the tree, and it always takes 2 args, so it can never collide with
/// the 1-arg flat bucket).
/// </para>
/// <para>
/// <b>What this test does NOT catch:</b> a caller that reaches the flat behavior another way — a new
/// helper method on a THIRD type that happens to also be named <c>Classify</c>/<c>TryGetDecl</c> with
/// the same arity as the flat overloads (would show up as a spurious new site here — a false positive
/// needing an allowlist note, not a false negative); or a caller that stores <c>ModelIndex.Classify</c>
/// as a delegate/method-group and invokes it indirectly (no invocation syntax to see with that shape).
/// It also does not fix anything — an allowlisted site with an available context it doesn't use stays a
/// latent bug until someone fixes it. #1870 worked that backlog down to the point where no site is left
/// holding a bounded context in a LOCAL of the same method and ignoring it; what remains are shared or
/// static helpers with no context parameter of their own, some of which nonetheless have a caller that
/// does carry one (see <c>CSharpEmitter.Api.cs:205</c> below) and could be threaded by a signature
/// refactor. Every entry below is justified by a stated reason rather than parked. The robust, complete fix
/// is Option C from #1863's own brainstorm — renaming/obsoleting the flat overloads so the compiler
/// enforces the distinction — deliberately deferred as a separate, larger public-API decision.
/// </para>
/// </summary>
public class FlatModelIndexLookupGuardTests
{
    /// <summary>Walks up from the test assembly to the directory containing <c>Koine.slnx</c>.</summary>
    private static string RepoRoot()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return dir.FullName;
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) walking up from {AppContext.BaseDirectory}");
    }

    /// <summary>One call site of a flat <c>ModelIndex</c> overload.</summary>
    private sealed record FlatCallSite(string RelativePath, int Line, string Method)
    {
        public override string ToString() => $"{RelativePath}:{Line} ({Method})";
    }

    /// <summary>
    /// Scans every <c>.cs</c> file under <c>src/</c> (excluding build output and generated parser
    /// code) for invocations of the flat overloads. <c>ModelIndex.cs</c> itself is excluded — its own
    /// declaration of <c>Classify(string?, string)</c> calls the 1-arg overload as ITS OWN documented
    /// final fallback step, which is the seam, not a caller bypassing it.
    /// </summary>
    private static IReadOnlyList<FlatCallSite> FindFlatCallSites()
    {
        string repoRoot = RepoRoot();
        string src = Path.Combine(repoRoot, "src");
        var sites = new List<FlatCallSite>();

        foreach (string file in Directory
            .EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                && !f.Contains($"{Path.DirectorySeparatorChar}gen{Path.DirectorySeparatorChar}")
                && Path.GetFileName(f) != "ModelIndex.cs")
            .OrderBy(f => f, StringComparer.Ordinal))
        {
            SyntaxTree tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file);

            foreach (InvocationExpressionSyntax invocation in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (invocation.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Classify" or "TryGetDecl" } member)
                {
                    continue;
                }

                string methodName = member.Name.Identifier.Text;
                int argCount = invocation.ArgumentList.Arguments.Count;
                bool isFlat = methodName switch
                {
                    "Classify" => argCount == 1,
                    "TryGetDecl" => argCount == 2,
                    _ => false
                };

                if (!isFlat)
                {
                    continue;
                }

                string relativePath = Path.GetRelativePath(repoRoot, file).Replace(Path.DirectorySeparatorChar, '/');
                int line = invocation.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                sites.Add(new FlatCallSite(relativePath, line, methodName));
            }
        }

        return sites;
    }

    /// <summary>
    /// Every currently-known flat call site, each with a one-line justification. A new site not listed
    /// here fails <see cref="No_new_flat_ModelIndex_call_site_appears_unjustified"/> — either fix it to
    /// route through <c>TryGetDeclIn</c>/the context-aware overload, or add it here with a real reason.
    /// </summary>
    private static readonly (string Path, int Line, string Method, string Reason)[] Allowlist =
    [
        // --- Deliberate final-fallback step of a local context-first ladder: TryGetDeclIn (or the
        //     context-aware overload) is tried FIRST in the same expression/method; the flat call only
        //     ever answers when that already failed, mirroring TryGetDecl(context, ...)'s own last step. ---
        ("src/Koine.Compiler/Ast/Binder.cs", 295, "TryGetDecl", "final fallback of ResolveTypeName's own ladder (TryGetDeclIn tried at :290)"),
        ("src/Koine.Emit.Rust/RustExpressionTranslator.cs", 1464, "TryGetDecl", "final fallback of ResolveDecl's own ladder (TryGetDeclIn tried at :1459)"),
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", 486, "TryGetDecl", "final fallback of ResolveDecl's own ladder"),
        ("src/Koine.Compiler/Semantics/SemanticValidator.cs", 956, "TryGetDecl", "final fallback after TryGetDeclIn(ctx.Name, target, ...) in ValidateSpecs"),
        ("src/Koine.Compiler/Semantics/CqrsValidator.cs", 480, "TryGetDecl", "final fallback after TryGetDeclIn(context, sourceType, ...) in ReadModelSourceMembers"),
        ("src/Koine.Execution/ScenarioExecutor.cs", 1579, "TryGetDecl", "final fallback within a DeclaringContextsOf/TryGetDeclIn walk in InvariantsDeclaredOn"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Application.cs", 571, "TryGetDecl", "combined TryGetDeclIn(context,...) || TryGetDecl(...) ladder"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Cqrs.cs", 284, "TryGetDecl", "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Behaviors.cs", 44, "TryGetDecl", "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.Common/OperatorNeedsAnalyzer.cs", 457, "TryGetDecl", "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Common/OperatorNeedsAnalyzer.cs", 610, "TryGetDecl", "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.Php/PhpEmitter.Cqrs.cs", 312, "TryGetDecl", "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Php/PhpExpressionTranslator.cs", 1174, "TryGetDecl", "combined (context is null || !TryGetDeclIn(...)) && !TryGetDecl(...) ladder in IsDerivedMemberOf"),
        ("src/Koine.Emit.Php/PhpEmitter.Services.cs", 319, "TryGetDecl", "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.TypeScript/TypeScriptEmitter.Cqrs.cs", 160, "TryGetDecl", "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.TypeScript/TypeScriptEmitter.Services.cs", 102, "TryGetDecl", "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.Python/PythonEmitter.Cqrs.cs", 222, "TryGetDecl", "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Java/JavaEmitter.Cqrs.cs", 141, "TryGetDecl", "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Rust/RustEmitter.Cqrs.cs", 243, "TryGetDecl", "combined ladder in ReadModelSourceMembers"),

        // --- A boolean existence-only guard: any declaring context makes the check true, so it can't
        //     matter WHICH context the flat lookup's last-write-wins bias happens to surface. ---
        ("src/Koine.Emit.Php/PhpEmitter.Support.cs", 451, "TryGetDecl", "UnownedIdNamesIn: is-this-name-undeclared-anywhere guard, immediately followed by the real per-context Classify(ctx.Name, name) on the next line"),

        // --- No context parameter/field anywhere in the call chain: a real signature-threading
        //     refactor, not a one-line fix (same category as #1863's own SymbolTable non-goal). ---
        ("src/Koine.Emit.OpenApi/OpenApiEmitter.Schemas.cs", 261, "Classify", "static SchemaForType/Array recursion carries no context parameter"),
        ("src/Koine.Compiler/Ast/KoineType.cs", 79, "Classify", "static From(TypeRef?, ModelIndex) has no context param; none of its ~8 call sites thread one in"),
        ("src/Koine.Compiler/Services/SemanticTokenProvider.cs", 255, "Classify", "whole-document semantic-token coloring; no per-reference context concept"),
        ("src/Koine.Compiler/Services/WorkspaceIndex.cs", 671, "TryGetDecl", "StrongHover: workspace-wide hover, no context in the hover path"),
        ("src/Koine.Compiler/Services/WorkspaceIndex.cs", 674, "Classify", "StrongHover: workspace-wide hover, no context in the hover path"),
        ("src/Koine.Compiler/Semantics/Scenarios/ScenarioInterpreter.cs", 223, "TryGetDecl", "MembersOf: dynamic scenario interpreter, no per-entity context value carried"),
        ("src/Koine.Execution/ScenarioValueBinder.cs", 471, "TryGetDecl", "DisplayCore: reflects over an arbitrary emitted runtime object by CLR type, genuinely dynamic"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", 263, "TryGetDecl", "EnumMemberIn reproduces SemanticModel.GetSymbol's legacy flat contract byte-for-byte; no context"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", 284, "TryGetDecl", "MemberOf — #1863's own non-goal: signature carries no context at all, a real refactor"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", 303, "TryGetDecl", "StrongSymbol — same #1863 non-goal as MemberOf above"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", 309, "TryGetDecl", "StrongSymbol's enum-member branch — same #1863 non-goal as MemberOf above"),
        ("src/Koine.Compiler/Services/KoineLanguageService.cs", 608, "Classify", "TypeCandidates: whole-workspace type-name completion list, no TokenContext/context param in this method's own signature"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Api.cs", 205, "Classify", "IsRouteBindable: only the Enum branch is context-sensitive (Primitive/IdValueObject are universal), and the WriteMutationEndpoint chain carries no context — but NOT fully clean: WriteQueryEndpoint(sb, ContextNode ctx, ...) reaches the same helper through BuildRouteTokenBindings with ctx.Name in scope, so one of the two callers could thread a context today (out of #1870's scope; the shared helper's other caller cannot)"),

        // --- Built-in-only query: inert by RANGE DISJOINTNESS, not by name reservation (verified for
        //     #1870, correcting an earlier note here that claimed the built-in names are "lexically
        //     reserved by the grammar" — they are NOT).
        //
        //     What is actually true: `ClassifyBuiltIn` (ModelIndex.cs:1622) is the ONLY branch of
        //     `Classify(string)` that can ever yield Primitive/List/Set/Map/Range, and it is a pure
        //     function of the name string, consulted BEFORE `_byName`. The only other branches return
        //     `ClassifyDecl(decl)` — a closed switch over TypeDecl whose range is
        //     {Value, Entity, Aggregate, Enum, Event, IntegrationEvent, ReadModel, Query, Unknown}
        //     (ModelIndex.cs:1689) — or IdValueObject/Unknown. Those two ranges are DISJOINT from
        //     {Primitive, Range, List, Set, Map}. So for these three queries specifically — each of
        //     which only ever asks "is the kind one of the built-in kinds?" and only ever consumes the
        //     answer as a local bool (the TypeKind is never stored, returned, or compared against a
        //     user-declarable kind) — the boolean is a pure function of the type NAME. `_byName`'s
        //     last-declaration-wins contents cannot change it, so .koi source order cannot either.
        //
        //     The reservation premise itself is refuted, which is exactly why disjointness is the load-
        //     bearing argument: the lexer has no keyword token for any built-in type name (they all match
        //     `Identifier`, KoineLexer.g4:138) and `valueDecl : … VALUE Identifier …` (KoineParser.g4:139)
        //     happily parses `value List`/`value Int`. Only List/Set/Map/Range are reserved at all, and
        //     by a VALIDATOR (KOI0908 ReservedTypeName, SemanticValidator.cs:312-328) — a strictly weaker
        //     guarantee that holds only for models that pass validation. Int/String/Decimal/Bool/Instant
        //     are not reserved anywhere: a probe declaring `value Int { x: String }` compiles CLEAN.
        //
        //     Do NOT "fix" these by threading `_resolver.Context` in: `Classify(context, name)` tries the
        //     context-local decl FIRST, so on a model declaring `value List` a context-aware call would
        //     classify List as that context's Value and SILENCE these reports — the #1715 regression
        //     SemanticValidator.cs:1479-1487 documents and R9ValueObjectTests' two
        //     `…_still_reports_…_alongside_KOI0908` tests pin. Built-in precedence is the intended
        //     semantics here, and the flat overload is what implements it. ---
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", 1042, "Classify", "CheckMember: result only tested against Primitive/Range, kinds no ClassifyDecl branch can return"),
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", 1063, "Classify", "IsCollection: result only tested against List/Set/Map, kinds no ClassifyDecl branch can return"),
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", 1067, "Classify", "IsIterable: result only tested against List/Set, kinds no ClassifyDecl branch can return"),

        // --- Provably inert despite an available context: the kind is consumed ONLY for questions whose
        //     answer cannot differ per context. Verified against the fixtures in
        //     AstSymbolCrossContextClassificationTests, which pin the outcome under BOTH context orders. ---
        ("src/Koine.Compiler/Ast/Binder.cs", 266, "Classify", "ResolveTypeRef asks only 'built-in?' (resolved ahead of every dict) and 'IdValueObject?' (only ever returned for a name NO context declares, where the context-aware overload falls back to this same answer); every other kind falls through to the already context-aware ResolveTypeName(name, _enclosingContextName) two lines later (#1870)"),

        // --- No site remains with a bounded context in a LOCAL of the same method that it then ignores:
        //     #1870 worked through every one of those. That is the literal claim, and it is weaker than
        //     "nothing is left to fix" — several entries above are shared/static helpers whose own
        //     signature carries no context but whose CALLERS do (CSharpEmitter.Api.cs:205's
        //     WriteQueryEndpoint is the clearest); threading those needs a signature refactor, which is
        //     out of #1870's scope, not a one-line fix that was judged unnecessary.
        //
        //     The twelve C#-emitter sites that used to sit here are GONE: #1870's C# task confirmed nine
        //     of them order-dependent with a two-order fixture and fixed them to Classify(context, name),
        //     and its own code review caught three more — the shared static helpers IsValueObjectList /
        //     ClassifyMember / EnumExpected, each of which every caller could already supply a context to.
        //     See CSharpFlatClassifyCrossContextTests and CSharpValueConverterContextScopeTests.
        //
        //     The three Rust-emitter sites (RustEmitter.Entities.cs — BuildFactoryCtorArgs' required and
        //     defaulted loops, and TransitionEnum) are GONE for the same reason: #1870's Rust task
        //     reproduced all three, fixed them to Classify(context, name) via the shared ExpectedEnum
        //     helper (TransitionEnum took a threaded-in context parameter), and pinned them under both
        //     context orders in RustEntityEnumContextScopeTests.
        //
        //     The seven LSP/tooling-cluster sites (CSharpEmitter.Infrastructure's CollectAggregateEnumTypes,
        //     and KoineLanguageService's DotCandidates / BinderReceiverMembers / EnumMemberCandidates /
        //     PrepareCallHierarchy / FindEvent / ItemFor) are GONE too: each was reproduced under both
        //     context orders through its REAL entry point — the emitted converter holder, CompleteAt,
        //     PrepareCallHierarchy, PrepareTypeHierarchy — and fixed by threading the context already in
        //     scope (ctx.EnclosingContextName, or the method's own `context` parameter; FindEvent took a
        //     threaded-in one). See CSharpValueConverterContextScopeTests and
        //     LanguageServiceFlatLookupCrossContextTests. ---
    ];

    [Fact]
    public void No_new_flat_ModelIndex_call_site_appears_unjustified()
    {
        var actual = FindFlatCallSites();
        var allowed = Allowlist.Select(a => (a.Path, a.Line, a.Method)).ToHashSet();

        List<FlatCallSite> unlisted = actual.Where(s => !allowed.Contains((s.RelativePath, s.Line, s.Method))).ToList();

        unlisted.ShouldBeEmpty(
            "New call site(s) to ModelIndex's flat, last-declaration-wins overload — Classify(string) " +
            "or TryGetDecl(string, out TypeDecl). R13.2 lets two bounded contexts legally declare a " +
            "type with the same simple name, so a context-blind lookup silently depends on .koi source " +
            "order (the defect family behind #1632 through #1863). If the caller has a bounded-context " +
            "value in scope, route through ModelIndex.TryGetDeclIn(context, name, out decl) — or the " +
            "Classify(context, name) / TryGetDecl(context, name, out decl) overloads — instead. If it " +
            "is genuinely context-less, add it to this test's Allowlist with a real one-line reason.\n\n" +
            string.Join("\n", unlisted));
    }

    [Fact]
    public void Every_allowlisted_site_still_matches_a_real_flat_call_site()
    {
        // The inverse check: an allowlist entry whose file:line:method no longer matches a real flat
        // call site is stale — the site moved (a reformat/refactor) or was already fixed and the entry
        // was never removed. Either way it hides nothing today, which is worth surfacing.
        var actual = FindFlatCallSites().Select(s => (s.RelativePath, s.Line, s.Method)).ToHashSet();
        var stale = Allowlist.Where(a => !actual.Contains((a.Path, a.Line, a.Method))).ToList();

        stale.ShouldBeEmpty(
            "Allowlist entries that no longer match a real flat call site (the site moved, was " +
            "reformatted, or was already fixed — remove or correct the entry):\n" +
            string.Join("\n", stale.Select(s => $"{s.Path}:{s.Line} ({s.Method}) — {s.Reason}")));
    }
}
