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
/// <c>.cs</c> file under <c>src/</c> finds every invocation of one of the SIX flat seams below, keyed
/// by method name + argument count — the flat overloads' unambiguous arity (each context-aware sibling
/// takes one more argument). This works regardless of formatting, line-wrapping, or how the argument
/// expression is written, because it inspects the parsed syntax tree, not the source text.
/// </para>
/// <para>
/// <b>The scanned seams, and why exactly these six (#1897).</b> The scan originally covered only
/// <c>Classify</c>/<c>TryGetDecl</c>, which under-reported: #1870 found two LSP sites that routed
/// through <c>IsEnumType(receiver)</c> <i>as well as</i> the flagged <c>TryGetDecl</c>, so fixing only
/// the flagged half would have left both sites order-dependent behind a GREEN guard. #1897 therefore
/// re-derived the seam set from the source rather than adding the two names by hand: every member of
/// <c>ModelIndex</c> that reads the <c>_byName</c> dictionary, plus every thin wrapper over one of
/// those. That enumeration is exhaustive and mechanical — <c>_byName</c> is read at exactly six places
/// in <c>ModelIndex.cs</c> — and it yields:
/// <list type="table">
///   <item><term><c>Classify(string)</c> — 1 arg</term>
///     <description>reads <c>_byName</c>; sibling <c>Classify(string?, string)</c>.</description></item>
///   <item><term><c>TryGetDecl(string, out TypeDecl)</c> — 2 args</term>
///     <description>reads <c>_byName</c>; sibling <c>TryGetDecl(string?, string, out TypeDecl)</c>.</description></item>
///   <item><term><c>TryGetMemberType(string, string, out TypeRef)</c> — 3 args</term>
///     <description>reads <c>_byName</c>; sibling <c>TryGetMemberType(string?, string, string, out TypeRef)</c>.</description></item>
///   <item><term><c>MemberNames(string)</c> — 1 arg</term>
///     <description>reads <c>_byName</c>; has NO context-aware sibling, so every call is flat by
///     construction.</description></item>
///   <item><term><c>IsEnumType(string)</c> — 1 arg</term>
///     <description>thin wrapper: <c>Classify(name) == TypeKind.Enum</c>. No sibling — a context-aware
///     caller must spell out <c>Classify(context, name) == TypeKind.Enum</c>.</description></item>
///   <item><term><c>IsKnownType(string)</c> — 1 arg</term>
///     <description>thin wrapper: <c>Classify(name) != TypeKind.Unknown</c>; sibling
///     <c>IsKnownType(string?, string)</c>.</description></item>
/// </list>
/// The two remaining <c>_byName</c> readers are deliberately NOT scanned because they are provably
/// order-independent rather than merely unaudited: <c>AllTypes()</c> iterates <c>_byName.Values</c>
/// only as an additive second pass over a <c>seen</c> set (it can only ever ADD visibility, never
/// shadow), and <c>CandidateTypeNames</c> unions <c>_byName.Keys</c> into a name list where a name
/// shadowed in the dictionary is still present in the union. Neither can return a different answer
/// under a different <c>.koi</c> declaration order.
/// </para>
/// <para>
/// <b>The seventh seam: <c>EnumsDeclaring(string)</c> — 1 arg (#1886).</b> <c>ModelIndex</c>'s OTHER
/// last-write-wins map, <c>_enumMemberToType</c>, is a distinct family from <c>_byName</c> and was
/// previously left unscanned and untracked. It is now covered here through its reader
/// <c>EnumsDeclaring(member)</c>, whose context-aware sibling <c>EnumsDeclaring(string?, string)</c>
/// (#1739) again takes exactly one more argument, so the same name+arity discrimination applies.
/// (<c>EnumsDeclaring</c> is declared ONLY on <c>ModelIndex</c>, in these two overloads.) The map's
/// raw <c>EnumMemberToType</c> property is deliberately NOT scanned: it is a PROPERTY, so it yields no
/// invocation syntax, and its ~30 references are the five code emitters threading the dictionary into
/// their translators as a constructor argument — where every translator uses it only as a tie-break
/// constrained to the context-scoped owner set. Pinning thirty lines of plumbing would cost churn
/// without guarding a lookup.
/// </para>
/// <para>
/// Method-name + arity is enough to identify these six specific overloads without full semantic
/// binding <i>in this codebase specifically</i> — re-verified for #1897 by grepping every declaration
/// of each name in <c>src/</c>, <c>tests/</c> and <c>tooling/</c>: <c>IsEnumType</c>,
/// <c>TryGetMemberType</c> and the method <c>MemberNames</c> are declared ONLY on <c>ModelIndex</c>,
/// and <c>IsKnownType</c>'s only other declaration is its own context-aware 2-arg sibling.
/// (<c>EnumDecl.MemberNames</c> shares the name but is a PROPERTY, so it never produces invocation
/// syntax — <c>decl.MemberNames.Contains(x)</c> parses with <c>Contains</c>, not <c>MemberNames</c>, as
/// the invoked name.) <c>BranchReconciliation.Classify</c> is the one unrelated same-named method in
/// the tree, and it always takes 2 args, so it can never collide with the 1-arg flat bucket.
/// </para>
/// <para>
/// <b>What this test does NOT catch:</b> a caller that reaches the flat behavior another way — a new
/// helper method on a THIRD type that happens to also carry one of the six scanned names with the same
/// arity as the flat overload (would show up as a spurious new site here — a false positive needing an
/// allowlist note, not a false negative); or a caller that stores <c>ModelIndex.Classify</c>
/// as a delegate/method-group and invokes it indirectly (no invocation syntax to see with that shape).
/// A NEW flat member added to <c>ModelIndex</c> tomorrow is also invisible until its name is added
/// here — the enumeration above is a snapshot of the type, re-derive it when <c>ModelIndex</c> grows a
/// <c>_byName</c> reader (the principled fix, scanning by semantic binding, is #1863's Option C).
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
    private sealed record FlatCallSite(string RelativePath, string EnclosingSymbol, int Line, string Method)
    {
        public override string ToString() => $"{RelativePath}:{Line} ({EnclosingSymbol}, {Method})";
    }

    /// <summary>
    /// The name of the nearest enclosing member (method, local function, constructor, property,
    /// indexer, or operator) around <paramref name="node"/> — stable under reformatting/reordering,
    /// unlike a line number. Falls through nodes with no name of their own (blocks, lambdas, accessor
    /// bodies) so a call inside a lambda or a property accessor is attributed to the member that
    /// declares it.
    /// </summary>
    private static string EnclosingSymbolName(SyntaxNode node)
    {
        for (SyntaxNode? current = node.Parent; current is not null; current = current.Parent)
        {
            switch (current)
            {
                case LocalFunctionStatementSyntax local:
                    return local.Identifier.Text;
                case MethodDeclarationSyntax method:
                    return method.Identifier.Text;
                case ConstructorDeclarationSyntax ctor:
                    return ctor.Identifier.Text;
                case PropertyDeclarationSyntax property:
                    return property.Identifier.Text;
                case IndexerDeclarationSyntax indexer:
                    return $"this[{indexer.ParameterList.Parameters}]";
                case OperatorDeclarationSyntax op:
                    return $"operator {op.OperatorToken.Text}";
            }
        }

        throw new InvalidOperationException(
            $"could not resolve an enclosing member name for a flat call site at "
            + $"{node.GetLocation().GetLineSpan()} — unexpected syntax shape, extend EnclosingSymbolName");
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
                if (invocation.Expression is not MemberAccessExpressionSyntax
                    {
                        Name.Identifier.Text: "Classify" or "TryGetDecl" or "IsEnumType" or "IsKnownType"
                            or "TryGetMemberType" or "MemberNames" or "EnumsDeclaring"
                    } member)
                {
                    continue;
                }

                string methodName = member.Name.Identifier.Text;
                int argCount = invocation.ArgumentList.Arguments.Count;
                bool isFlat = methodName switch
                {
                    "Classify" => argCount == 1,
                    "TryGetDecl" => argCount == 2,
                    "IsEnumType" => argCount == 1,
                    "IsKnownType" => argCount == 1,
                    "TryGetMemberType" => argCount == 3,
                    "MemberNames" => argCount == 1,
                    "EnumsDeclaring" => argCount == 1,
                    _ => false
                };

                if (!isFlat)
                {
                    continue;
                }

                string relativePath = Path.GetRelativePath(repoRoot, file).Replace(Path.DirectorySeparatorChar, '/');
                int line = invocation.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                string enclosingSymbol = EnclosingSymbolName(invocation);
                sites.Add(new FlatCallSite(relativePath, enclosingSymbol, line, methodName));
            }
        }

        return sites;
    }

    /// <summary>
    /// Every currently-known flat call site, each with a one-line justification. A new site not listed
    /// here fails <see cref="No_new_flat_ModelIndex_call_site_appears_unjustified"/> — either fix it to
    /// route through <c>TryGetDeclIn</c>/the context-aware overload, or add it here with a real reason.
    /// </summary>
    /// <remarks>
    /// Keyed by (<c>Path</c>, <c>EnclosingSymbol</c>, <c>Method</c>) rather than a line number — a line
    /// number breaks on ANY unrelated edit that shifts lines in the file, which is mechanically
    /// indistinguishable from a suppression (#1945). <c>ExpectedCount</c> is how many distinct flat call
    /// sites are expected inside that one enclosing symbol (almost always 1; occasionally more, e.g.
    /// <c>SymbolTable.StrongSymbol</c> below, which has two separate <c>TryGetDecl</c> call sites).
    /// </remarks>
    private static readonly (string Path, string EnclosingSymbol, string Method, int ExpectedCount, string Reason)[] Allowlist =
    [
        // --- Deliberate final-fallback step of a local context-first ladder: TryGetDeclIn (or the
        //     context-aware overload) is tried FIRST in the same expression/method; the flat call only
        //     ever answers when that already failed, mirroring TryGetDecl(context, ...)'s own last step. ---
        ("src/Koine.Compiler/Ast/Binder.cs", "ResolveTypeName", "TryGetDecl", 1, "final fallback of ResolveTypeName's own ladder (TryGetDeclIn tried earlier in the same method)"),
        ("src/Koine.Emit.Rust/RustExpressionTranslator.cs", "ResolveDecl", "TryGetDecl", 1, "final fallback of ResolveDecl's own ladder (TryGetDeclIn tried earlier in the same method)"),
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", "ResolveDecl", "TryGetDecl", 1, "final fallback of ResolveDecl's own ladder"),
        ("src/Koine.Compiler/Semantics/SemanticValidator.cs", "ValidateSpecs", "TryGetDecl", 1, "final fallback after TryGetDeclIn(ctx.Name, target, ...) in ValidateSpecs"),
        ("src/Koine.Compiler/Semantics/CqrsValidator.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "final fallback after TryGetDeclIn(context, sourceType, ...) in ReadModelSourceMembers"),
        ("src/Koine.Execution/ScenarioExecutor.cs", "InvariantsDeclaredOn", "TryGetDecl", 1, "final fallback within a DeclaringContextsOf/TryGetDeclIn walk in InvariantsDeclaredOn"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Application.cs", "TryGetValueObject", "TryGetDecl", 1, "combined TryGetDeclIn(context,...) || TryGetDecl(...) ladder"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Cqrs.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Behaviors.cs", "SpecTargetMembers", "TryGetDecl", 1, "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.Common/OperatorNeedsAnalyzer.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Common/OperatorNeedsAnalyzer.cs", "SpecTargetMembers", "TryGetDecl", 1, "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.Php/PhpEmitter.Cqrs.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Php/PhpExpressionTranslator.cs", "IsDerivedMemberOf", "TryGetDecl", 1, "combined (context is null || !TryGetDeclIn(...)) && !TryGetDecl(...) ladder in IsDerivedMemberOf"),
        ("src/Koine.Emit.Php/PhpEmitter.Services.cs", "SpecTargetMembers", "TryGetDecl", 1, "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.TypeScript/TypeScriptEmitter.Cqrs.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.TypeScript/TypeScriptEmitter.Services.cs", "SpecTargetMembers", "TryGetDecl", 1, "combined ladder in SpecTargetMembers"),
        ("src/Koine.Emit.Python/PythonEmitter.Cqrs.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Java/JavaEmitter.Cqrs.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "combined ladder in ReadModelSourceMembers"),
        ("src/Koine.Emit.Rust/RustEmitter.Cqrs.cs", "ReadModelSourceMembers", "TryGetDecl", 1, "combined ladder in ReadModelSourceMembers"),

        // --- A boolean existence-only guard: any declaring context makes the check true, so it can't
        //     matter WHICH context the flat lookup's last-write-wins bias happens to surface. ---
        ("src/Koine.Emit.Php/PhpEmitter.Support.cs", "UnownedIdNamesIn", "TryGetDecl", 1, "UnownedIdNamesIn: is-this-name-undeclared-anywhere guard, immediately followed by the real per-context Classify(ctx.Name, name) on the next line"),

        // --- No context parameter/field anywhere in the call chain: a real signature-threading
        //     refactor, not a one-line fix (same category as #1863's own SymbolTable non-goal). ---
        ("src/Koine.Emit.OpenApi/OpenApiEmitter.Schemas.cs", "BaseSchema", "Classify", 1, "static SchemaForType/Array recursion carries no context parameter"),
        ("src/Koine.Compiler/Ast/KoineType.cs", "From", "Classify", 1, "static From(TypeRef?, ModelIndex) has no context param; none of its ~8 call sites thread one in"),
        ("src/Koine.Compiler/Services/SemanticTokenProvider.cs", "CollectConceptKindBits", "Classify", 1, "whole-document semantic-token coloring; no per-reference context concept"),
        ("src/Koine.Compiler/Services/WorkspaceIndex.cs", "StrongHover", "TryGetDecl", 1, "StrongHover: workspace-wide hover, no context in the hover path"),
        ("src/Koine.Compiler/Services/WorkspaceIndex.cs", "StrongHover", "Classify", 1, "StrongHover: workspace-wide hover, no context in the hover path"),
        ("src/Koine.Execution/ScenarioValueBinder.cs", "DisplayCore", "TryGetDecl", 1, "DisplayCore: reflects over an arbitrary emitted runtime object by CLR type, genuinely dynamic"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", "EnumMemberIn", "TryGetDecl", 1, "EnumMemberIn reproduces SemanticModel.GetSymbol's legacy flat contract byte-for-byte; no context"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", "MemberOf", "TryGetDecl", 1, "MemberOf — #1863's own non-goal: signature carries no context at all, a real refactor"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", "StrongSymbol", "TryGetDecl", 2, "StrongSymbol — two TryGetDecl call sites (the direct-decl branch and the enum-member fallback branch), same #1863 non-goal as MemberOf above"),
        ("src/Koine.Compiler/Services/KoineLanguageService.cs", "TypeCandidates", "Classify", 1, "TypeCandidates: whole-workspace type-name completion list, no TokenContext/context param in this method's own signature"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.Api.cs", "IsRouteBindable", "Classify", 1, "IsRouteBindable: only the Enum branch is context-sensitive (Primitive/IdValueObject are universal), and the WriteMutationEndpoint chain carries no context — but NOT fully clean: WriteQueryEndpoint(sb, ContextNode ctx, ...) reaches the same helper through BuildRouteTokenBindings with ctx.Name in scope, so one of the two callers could thread a context today (out of #1870's scope; the shared helper's other caller cannot)"),

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
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", "CheckMember", "Classify", 1, "CheckMember: result only tested against Primitive/Range, kinds no ClassifyDecl branch can return"),
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", "IsCollection", "Classify", 1, "IsCollection: result only tested against List/Set/Map, kinds no ClassifyDecl branch can return"),
        ("src/Koine.Compiler/Semantics/ExpressionChecker.cs", "IsIterable", "Classify", 1, "IsIterable: result only tested against List/Set, kinds no ClassifyDecl branch can return"),

        // --- IsKnownType(string): provably EQUIVALENT to its own context-aware sibling, so these are
        //     inert by construction rather than by a per-site argument (#1897).
        //
        //     `IsKnownType(ctx, n)` is `Classify(ctx, n) != Unknown`, and `Classify(ctx, n)` returns
        //     `ClassifyDecl(decl)` when `TryGetDeclIn(ctx, n, ...)` hits, else falls through to the flat
        //     `Classify(n)`. So the two answers can only diverge if `ClassifyDecl` can return `Unknown`
        //     for a real declaration — and it cannot: its switch covers all EIGHT concrete `TypeDecl`
        //     subtypes in the tree (ValueObjectDecl, EntityDecl, AggregateDecl, EnumDecl, EventDecl,
        //     IntegrationEventDecl, ReadModelDecl, QueryDecl — Nodes.cs:257/289/326/356/378/388/626/654),
        //     leaving its `_ => Unknown` arm unreachable. The converse divergence is impossible too:
        //     anything `TryGetDeclIn` can reach was written to `_byName` by the same `IndexType` pass, so
        //     the flat view is a superset. Pinned by
        //     ModelIndexFlatSeamEquivalenceTests.IsKnownType_answers_identically_with_and_without_a_context.
        //
        //     These entries are therefore justified but NOT permanent: add a ninth TypeDecl subtype
        //     without extending ClassifyDecl and the equivalence breaks — which is what that test exists
        //     to catch. Sites that could cheaply pass a context were threaded anyway (KoineLanguageService
        //     :383/:591 now call the 2-arg overload) rather than parked here. ---
        ("src/Koine.Compiler/Services/SemanticTokenProvider.cs", "Classify", "IsKnownType", 1, "Classify(text,…): whole-document token coloring, no per-reference context concept (same Classify helper as the co-located IsEnumType entry below, and the same pattern as the CollectConceptKindBits entry above) — and inert regardless, per the equivalence proof above"),

        // --- IsEnumType(string) in whole-document semantic-token coloring: the one seam here that is
        //     NOT provably inert, kept flat only because the method genuinely has no context to thread.
        //     `SemanticTokenProvider.Classify(text, line, col, index, …)` is a static per-TOKEN classifier
        //     over a whole document; it is handed a bare identifier string and no enclosing-context
        //     value, and the surrounding pipeline builds none (that is the same judgement #1870 recorded
        //     for the Classify site at :255 in this very method). A document declaring `enum Phase` in
        //     one context and `value Phase` in another can therefore colour a `Phase` reference by .koi
        //     source order. That is a real, if cosmetic, limitation of token colouring — filed as its own
        //     issue rather than hidden here, because giving this method a context means teaching the
        //     token pipeline an enclosing-context notion it does not have (see the follow-up on #1897). ---
        ("src/Koine.Compiler/Services/SemanticTokenProvider.cs", "Classify", "IsEnumType", 1, "same static per-token Classify helper as the co-located IsKnownType entry above, and the same CollectConceptKindBits entry: no enclosing-context value exists in the token-colouring pipeline to thread — a real cosmetic limitation, tracked as a follow-up on #1897, not a one-line fix"),

        // --- Provably inert despite an available context: the kind is consumed ONLY for questions whose
        //     answer cannot differ per context. Verified against the fixtures in
        //     AstSymbolCrossContextClassificationTests, which pin the outcome under BOTH context orders. ---
        ("src/Koine.Compiler/Ast/Binder.cs", "ResolveTypeRef", "Classify", 1, "ResolveTypeRef asks only 'built-in?' (resolved ahead of every dict) and 'IdValueObject?' (only ever returned for a name NO context declares, where the context-aware overload falls back to this same answer); every other kind falls through to the already context-aware ResolveTypeName(name, _enclosingContextName) two lines later (#1870)"),

        // --- The _enumMemberToType seam, read through EnumsDeclaring(member) (#1886). Newly scanned, so
        //     every entry below is a PRE-EXISTING site this guard is cataloguing for the first time — not
        //     a site #1886 introduced. All eight are order-independent, but for two different reasons, so
        //     they are grouped rather than given one blanket excuse: the first four never select an owner
        //     at all, the last four are superset-only membership tests. ---

        // Owner-selection-free: the flat list's ORDER and EXTRA entries are both unobservable here.
        ("src/Koine.Compiler/Semantics/Scenarios/ScenarioInterpreter.cs", "VisitIdentifier", "EnumsDeclaring", 1, "existence only (`.Count > 0`) — asks whether the identifier is an enum member at all, then tags the value by its own NAME (ScenarioValue.EnumMember(n.Name)); it never selects an owning enum, so no order can change the answer"),
        ("src/Koine.Compiler/Ast/SymbolTable.cs", "StrongSymbol", "EnumsDeclaring", 1, "conservative by construction: StrongSymbol resolves ONLY when the member has exactly one owner globally (`owners.Count == 1`) and returns null otherwise, so an ambiguous member yields no symbol rather than an order-dependent one"),
        ("src/Koine.Compiler/Services/WorkspaceIndex.cs", "StrongHover", "EnumsDeclaring", 1, "same conservative `owners.Count == 1` shape for hover text — an ambiguous member falls through to the un-owned rendering instead of naming an arbitrary enum"),
        ("src/Koine.Compiler/Services/WorkspaceIndex.cs", "WouldCollide", "EnumsDeclaring", 1, "already scoped by a different axis: reads `enumOwner.Index`, the index of the model that OWNS the active document, so a same-named enum in another document's context cannot drive the rename-collision decision (the surrounding comment states this intent)"),

        // The four state-machine `.Contains(<enum name already resolved in context>)` membership tests.
        // These LOOK like the straggler shape — EntityBehaviorValidator.cs:727 even sits one line under a
        // context-aware Classify(resolver.Context, ...) — but switching them to the context-aware overload
        // provably changes NOTHING, which was measured rather than assumed (#1886):
        //
        //   * EnumsDeclaring keys on enum SIMPLE names at every rung, and EnumsDeclaring(context, member)
        //     filters that same name list by a set of visible enum NAMES. When the collision IS two
        //     same-named enums in different contexts — the only case where these sites could be fooled —
        //     both lists read ["Status"] and the filter is a no-op.
        //   * It also widens back: the overload returns the flat list whenever the scoped set comes out
        //     empty ("never narrower than flat"), so it cannot remove a foreign-only owner either.
        //
        // Verified by patching :727 to EnumsDeclaring(resolver.Context, ...) and re-running a fixture whose
        // transition targets a member only a FOREIGN same-named `Status` declares: KOI0703 fires
        // identically before and after. Switching them would therefore be churn — and the one direction
        // that could differ is the wrong one, since an early return here SKIPS the reachability
        // diagnostic (a #1797-shaped false negative), not emits one.
        //
        // Inertness does not depend on that argument alone: flat can only ever return a SUPERSET, so
        // `.Contains` can only be spuriously TRUE, never spuriously FALSE. A spurious TRUE merely lets
        // control reach a check that independently rejects the model (KOI0703 above; and the three emitter
        // sites only ever run on a model validation already accepted, where the member genuinely is a
        // legal state of the bound enum).
        ("src/Koine.Compiler/Semantics/EntityBehaviorValidator.cs", "CheckTransitionReachable", "EnumsDeclaring", 1, "state-machine reachability gate: superset-only, so it can only be spuriously TRUE, which routes into the KOI0703 check that rejects the model anyway — and the context-aware overload is a measured no-op here"),
        ("src/Koine.Emit.CSharp/CSharpEmitter.cs", "BuildStateMachineConditions", "EnumsDeclaring", 1, "BuildStateMachineConditions' literal-target check, reached only for a model validation already accepted, where the target IS a legal state of the bound enum"),
        ("src/Koine.Emit.Java/JavaEmitter.Behaviors.cs", "BuildStateMachineConditions", "EnumsDeclaring", 1, "BuildStateMachineConditions' literal-target check, Java peer of the C# site — same post-validation reachability"),
        ("src/Koine.Emit.Python/PythonEmitter.Behaviors.cs", "BuildStateMachineConditions", "EnumsDeclaring", 1, "BuildStateMachineConditions' literal-target check, Python peer of the C# site — same post-validation reachability"),

        // --- No site remains with a bounded context in a LOCAL of the same method that it then ignores:
        //     #1870 worked through every one of those. That is the literal claim, and it is weaker than
        //     "nothing is left to fix" — several entries above are shared/static helpers whose own
        //     signature carries no context but whose CALLERS do (CSharpEmitter.Api.cs's IsRouteBindable
        //     entry above — WriteQueryEndpoint is the clearest caller); threading those needs a signature
        //     refactor, which is out of #1870's scope, not a one-line fix that was judged unnecessary.
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
        var actualGroups = FindFlatCallSites()
            .GroupBy(s => (s.RelativePath, s.EnclosingSymbol, s.Method))
            .ToDictionary(g => g.Key, g => g.OrderBy(s => s.Line).ToList());
        var expectedCounts = Allowlist.ToDictionary(a => (a.Path, a.EnclosingSymbol, a.Method), a => a.ExpectedCount);

        // Any site beyond an entry's ExpectedCount — including every site of a symbol with no entry at
        // all (ExpectedCount 0) — is unjustified. Reported with the enclosing symbol name, so a worker
        // can tell "my edit moved a known site" (still zero unjustified sites) from "I introduced a new
        // one" (a real, named site here) at a glance.
        List<FlatCallSite> unjustified = [];
        foreach ((var key, List<FlatCallSite> sites) in actualGroups)
        {
            expectedCounts.TryGetValue(key, out int expected);
            if (sites.Count > expected)
            {
                unjustified.AddRange(sites.Skip(expected));
            }
        }

        unjustified.ShouldBeEmpty(
            "New call site(s) to one of ModelIndex's flat, last-declaration-wins seams — Classify(string), " +
            "TryGetDecl(string, out TypeDecl), TryGetMemberType(string, string, out TypeRef), " +
            "MemberNames(string), IsEnumType(string) or IsKnownType(string). R13.2 lets two bounded " +
            "contexts legally declare a type with the same simple name, so a context-blind lookup " +
            "silently depends on .koi source order (the defect family behind #1632 through #1897). If " +
            "the caller has a bounded-context value in scope, route through " +
            "ModelIndex.TryGetDeclIn(context, name, out decl) — or the context-aware sibling overload: " +
            "Classify(context, name), TryGetDecl(context, name, out decl), " +
            "TryGetMemberType(context, name, member, out type), IsKnownType(context, name), and for " +
            "IsEnumType (which has no sibling) spell out Classify(context, name) == TypeKind.Enum. " +
            "MemberNames(string) has no sibling either — resolve the decl with TryGetDeclIn(context, ...) " +
            "first and read its members off that. If the site is genuinely context-less, add it to this " +
            "test's Allowlist with a real reason, keyed by (path, enclosing symbol, method, expected " +
            "count).\n\n" +
            string.Join("\n", unjustified));
    }

    [Fact]
    public void Every_allowlisted_site_still_matches_a_real_flat_call_site()
    {
        // The inverse check: an allowlist entry whose (path, enclosing symbol, method) no longer has as
        // many real flat call sites as it claims is stale — either the enclosing symbol was renamed or
        // removed (actual count 0) or one of its flat calls was fixed/removed without updating the entry
        // (actual count > 0 but still short). Either way the entry is obsolete and hides nothing today.
        var actualCounts = FindFlatCallSites()
            .GroupBy(s => (s.RelativePath, s.EnclosingSymbol, s.Method))
            .ToDictionary(g => g.Key, g => g.Count());

        List<string> stale = [];
        foreach (var entry in Allowlist)
        {
            actualCounts.TryGetValue((entry.Path, entry.EnclosingSymbol, entry.Method), out int actual);
            if (actual < entry.ExpectedCount)
            {
                string why = actual == 0
                    ? $"'{entry.EnclosingSymbol}' no longer has a matching {entry.Method} call site at all — renamed, removed, or already fixed"
                    : $"site count dropped from {entry.ExpectedCount} to {actual} — one of the call sites was fixed or removed";
                stale.Add($"{entry.Path} ({entry.EnclosingSymbol}, {entry.Method}) expects {entry.ExpectedCount} site(s) but found {actual} — " +
                    $"this allowlist entry is obsolete, remove it: {why}. Reason on file: {entry.Reason}");
            }
        }

        stale.ShouldBeEmpty(
            "Allowlist entries that no longer match their claimed number of real flat call sites:\n" +
            string.Join("\n", stale));
    }

    [Fact]
    public void Migrated_allowlist_preserves_every_pre_migration_entry()
    {
        // Before #1945, the allowlist held one physical tuple per line-pinned call site (46 total, one
        // row per distinct (Path, Line, Method)). Re-keying on (Path, EnclosingSymbol, Method) merges
        // rows that share an enclosing symbol into one entry with a higher ExpectedCount (the only such
        // merge today is SymbolTable.StrongSymbol's two separate TryGetDecl call sites) — so the *tuple*
        // count shrinks, but the sum of ExpectedCount must not: a silently-dropped count would
        // permanently (and invisibly) excuse a real flat call site.
        const int PreMigrationSiteCount = 46;
        Allowlist.Sum(a => a.ExpectedCount).ShouldBe(PreMigrationSiteCount);
    }
}
