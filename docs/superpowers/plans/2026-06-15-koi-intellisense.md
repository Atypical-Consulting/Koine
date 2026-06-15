# Koine `.koi` IntelliSense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add completion, hover, and go-to-definition for `.koi` files to the existing Koine LSP server, built on a shared lexer-only token-locator.

**Architecture:** A new editor-agnostic `KoineLanguageService` in `Koine.Compiler.Services` exposes `CompleteAt`/`HoverAt`/`DefinitionAt` over `(source, line, character)` and returns plain records. A new `TokenLocator` (reusing the real `KoineLexer`) finds what is under the cursor without needing a successful parse, so completion survives mid-edit syntax errors. `src/Koine.Cli/LspServer.cs` stays a thin LSP-JSON shell: it advertises the new capabilities, caches document text, and translates the records to/from JSON-RPC.

**Tech Stack:** C# / .NET 10, ANTLR4 (`Antlr4.Runtime.Standard`), xUnit. Spec: `docs/superpowers/specs/2026-06-15-koi-intellisense-design.md`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/Koine.Compiler/Koine.Compiler.csproj` | Modify | Add `InternalsVisibleTo` for the test project so `TokenLocator` is testable |
| `src/Koine.Compiler/Services/TokenLocator.cs` | Create | Lexer-only cursor locator: `TokenContext`, `Locate`, `EnclosingKeyword` scan |
| `src/Koine.Compiler/Services/KoineLanguageService.cs` | Create | `CompleteAt`/`HoverAt`/`DefinitionAt`, result records, `CompletionItemKind` |
| `src/Koine.Cli/LspServer.cs` | Modify | Capabilities, `_docs` cache, 3 request cases, `TryGetPosition`, kind mapping |
| `tests/Koine.Compiler.Tests/TokenLocatorTests.cs` | Create | Unit tests for the locator |
| `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs` | Create | Service-layer tests for the three features |
| `tests/Koine.Compiler.Tests/LspServerTests.cs` | Modify | Protocol-layer tests + capability assertions |
| `README.md`, `tooling/README.md` | Modify | Document the new IntelliSense capabilities |

**Conventions confirmed in the codebase:**
- `KoineLexer` is generated into namespace `Koine.Compiler.Grammar`; token kinds are named constants (`KoineLexer.COLON`, `.DOT`, `.LT`, `.COMMA`, `.LPAREN`, `.RPAREN`, `.LBRACE`, `.RBRACE`, `.ASSIGN`, `.RARROW`, `.StringLiteral`, `.Identifier`, `.Regex`, `.DocComment`, `.ON`, `.FROM`, `.THEN`, `.NATURAL`). **Never hard-code the integer values.**
- ANTLR `IToken` exposes `Line` (1-based), `Column` (0-based), `Text`, `Type`, `Channel`. Doc comments are on a non-default channel (`KoineLexer.DOC`); `WS`/`//`/`/* */` are `-> skip` and never enter the token stream.
- `KoineCompiler.Parse(source)` returns `(KoineModel? Model, IReadOnlyList<Diagnostic>)` and yields `(null, errors)` on **any** syntax error. The service builds its own `new ModelIndex(model)` (as `SemanticValidator.cs:17` does).
- `SourceSpan` is `readonly record struct SourceSpan(int Line, int Column)` (1-based). `KoineModelBuilderVisitor.SpanOf` points at the declaration **keyword**, not the name token.
- Tests use xUnit `[Fact]`. The test project references both `Koine.Compiler` and `Koine.Cli`, and `Koine.Cli` already has `<InternalsVisibleTo Include="Koine.Compiler.Tests" />`.
- **Run tests with:** `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj` (add `--filter "FullyQualifiedName~ClassName"` to scope).

---

## Task 1: TokenLocator (lexer-only cursor core)

**Files:**
- Modify: `src/Koine.Compiler/Koine.Compiler.csproj`
- Create: `src/Koine.Compiler/Services/TokenLocator.cs`
- Test: `tests/Koine.Compiler.Tests/TokenLocatorTests.cs`

- [ ] **Step 1: Make compiler internals visible to tests**

In `src/Koine.Compiler/Koine.Compiler.csproj`, find the first `<ItemGroup>` that contains `<PackageReference ...>` and add this new item group just after the `</PropertyGroup>` (mirroring how `Koine.Cli.csproj` does it):

```xml
  <ItemGroup>
    <InternalsVisibleTo Include="Koine.Compiler.Tests" />
  </ItemGroup>
```

- [ ] **Step 2: Write the failing test file**

Create `tests/Koine.Compiler.Tests/TokenLocatorTests.cs`:

```csharp
using Koine.Compiler.Grammar;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class TokenLocatorTests
{
    [Fact]
    public void After_colon_and_space_preceding_is_colon_with_empty_partial()
    {
        // "  amount: " — cursor at end of line 1 (0-based), char 10 (after the space)
        var ctx = TokenLocator.Locate("value V {\n  amount: \n}\n", line: 1, character: 10);
        Assert.NotNull(ctx.PrecedingToken);
        Assert.Equal(KoineLexer.COLON, ctx.PrecedingToken!.Type);
        Assert.Equal("", ctx.Partial);
        Assert.Null(ctx.CurrentToken);
    }

    [Fact]
    public void Mid_identifier_yields_partial_prefix()
    {
        // "  status: Dr" — cursor right after "Dr" on line 1, char 12
        var ctx = TokenLocator.Locate("value V {\n  status: Dr\n}\n", line: 1, character: 12);
        Assert.NotNull(ctx.CurrentToken);
        Assert.Equal("Dr", ctx.Partial);
    }

    [Fact]
    public void After_dot_preceding_is_dot()
    {
        // "  invariant lines." — cursor right after the dot on line 1
        var src = "entity E identified by EId {\n  invariant lines.\n}\n";
        var ctx = TokenLocator.Locate(src, line: 1, character: 18);
        Assert.NotNull(ctx.PrecedingToken);
        Assert.Equal(KoineLexer.DOT, ctx.PrecedingToken!.Type);
        Assert.Equal("", ctx.Partial);
    }

    [Fact]
    public void Cursor_inside_regex_is_flagged()
    {
        // raw matches /ab|  cursor inside the regex literal
        var src = "value V {\n  invariant raw matches /ab\n}\n";
        var ctx = TokenLocator.Locate(src, line: 1, character: 34);
        Assert.True(ctx.InsideStringOrRegex);
    }

    [Fact]
    public void Enclosing_keyword_tracks_nesting()
    {
        // Inside the service block, enclosing keyword should be "service".
        var src = "context C {\n  service S {\n    \n  }\n}\n";
        var ctx = TokenLocator.Locate(src, line: 2, character: 4);
        Assert.Equal("service", ctx.EnclosingKeyword);
    }

    [Fact]
    public void Top_level_has_no_enclosing_keyword()
    {
        var ctx = TokenLocator.Locate("\n", line: 0, character: 0);
        Assert.Null(ctx.EnclosingKeyword);
    }

    [Fact]
    public void Broken_document_does_not_throw()
    {
        var ctx = TokenLocator.Locate("context C { value {{{ : ", line: 0, character: 24);
        Assert.NotNull(ctx); // returns a context, never throws
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~TokenLocatorTests"`
Expected: FAIL to **compile** — `TokenLocator` / `TokenContext` do not exist yet.

- [ ] **Step 4: Implement TokenLocator**

Create `src/Koine.Compiler/Services/TokenLocator.cs`:

```csharp
using Antlr4.Runtime;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Services;

/// <summary>
/// Lexer-only "what is under the cursor" engine shared by every IntelliSense
/// feature. It reuses the real <see cref="KoineLexer"/> (so the <c>matches</c>
/// regex mode switch is reproduced for free) and never depends on a successful
/// parse, so completion keeps working on syntactically-broken documents.
/// </summary>
internal sealed record TokenContext(
    IToken? PrecedingToken,
    IToken? TokenBeforePreceding,
    IToken? CurrentToken,
    string Partial,
    string? EnclosingKeyword,
    bool InsideStringOrRegex);

internal static class TokenLocator
{
    // Keywords that introduce a `{ }` block, used to label the enclosing scope.
    private static readonly HashSet<string> BlockKeywords = new(StringComparer.Ordinal)
    {
        "context", "value", "quantity", "entity", "aggregate", "enum", "event",
        "spec", "service", "policy", "repository", "states",
    };

    /// <summary>
    /// Locates the token context at an LSP 0-based <paramref name="line"/>/<paramref name="character"/>.
    /// Never throws: lexer error listeners are removed and malformed input yields a
    /// context with null tokens.
    /// </summary>
    public static TokenContext Locate(string source, int line, int character)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();
        var stream = new CommonTokenStream(lexer);
        stream.Fill();
        var tokens = stream.GetTokens();

        int targetLine = line + 1;     // ANTLR Line is 1-based
        int targetCol = character;     // ANTLR Column is 0-based, == LSP character

        var def = new List<IToken>();
        bool insideStringOrRegex = false;

        foreach (var t in tokens)
        {
            if (t.Type == TokenConstants.EOF)
                continue;

            // Doc comments live on a non-default channel; treat a cursor inside one
            // (or inside a string/regex token) as "not code".
            if (t.Channel != TokenConstants.DefaultChannel)
            {
                if (Contains(t, targetLine, targetCol))
                    insideStringOrRegex = true;
                continue;
            }

            def.Add(t);

            if ((t.Type == KoineLexer.StringLiteral || t.Type == KoineLexer.Regex)
                && Contains(t, targetLine, targetCol))
                insideStringOrRegex = true;
        }

        // The "current" token is a WORD token (identifier/keyword) the cursor sits
        // within or immediately after — i.e. the token being typed. Punctuation
        // under the cursor is NOT current; it becomes the preceding trigger.
        IToken? current = null;
        foreach (var t in def)
        {
            if (IsWord(t) && Contains(t, targetLine, targetCol))
            {
                current = t;
                break;
            }
        }

        // Preceding = last default token ending at or before the current token's
        // start (or the cursor, when there is no current token).
        int boundaryLine = current?.Line ?? targetLine;
        int boundaryCol = current?.Column ?? targetCol;
        IToken? preceding = null;
        foreach (var t in def)
        {
            if (ReferenceEquals(t, current))
                continue;
            if (EndsAtOrBefore(t, boundaryLine, boundaryCol))
                preceding = t; // keep the last qualifying token
        }

        // The token just before `preceding` (e.g. the `TypeName` in `name : TypeName =`),
        // needed to resolve the governing enum at an `=` and the type name before `<`.
        IToken? beforePreceding = null;
        if (preceding is not null)
        {
            foreach (var t in def)
            {
                if (ReferenceEquals(t, preceding)) break;
                if (EndsAtOrBefore(t, preceding.Line, preceding.Column))
                    beforePreceding = t;
            }
        }

        string partial = current is null
            ? ""
            : current.Text.Substring(0, Math.Clamp(targetCol - current.Column, 0, current.Text.Length));

        return new TokenContext(preceding, beforePreceding, current, partial,
            EnclosingKeyword(def, targetLine, targetCol), insideStringOrRegex);
    }

    private static bool IsWord(IToken t)
    {
        if (t.Type == KoineLexer.Identifier) return true;
        var s = t.Text;
        return s.Length > 0 && (char.IsLetter(s[0]) || s[0] == '_');
    }

    /// <summary>True when the cursor sits within <c>(start, end]</c> of the token on its line.</summary>
    private static bool Contains(IToken t, int line, int col)
    {
        if (t.Line != line) return false;
        int start = t.Column;
        int end = start + (t.Text?.Length ?? 0);
        return col > start && col <= end;
    }

    private static bool EndsAtOrBefore(IToken t, int line, int col)
    {
        if (t.Line < line) return true;
        if (t.Line > line) return false;
        return t.Column + (t.Text?.Length ?? 0) <= col;
    }

    private static bool Before(IToken t, int line, int col) =>
        t.Line < line || (t.Line == line && t.Column < col);

    /// <summary>
    /// The keyword of the innermost <c>{ }</c> block enclosing the cursor (e.g.
    /// <c>service</c>, <c>entity</c>), or <c>null</c> at file scope. A forward scan
    /// pushes the most recent block keyword on each <c>{</c> and pops on <c>}</c>.
    /// </summary>
    private static string? EnclosingKeyword(List<IToken> def, int line, int col)
    {
        var stack = new Stack<string>();
        string? pending = null;
        foreach (var t in def)
        {
            if (!Before(t, line, col))
                break;
            if (t.Type == KoineLexer.LBRACE)
            {
                stack.Push(pending ?? "");
                pending = null;
            }
            else if (t.Type == KoineLexer.RBRACE)
            {
                if (stack.Count > 0) stack.Pop();
                pending = null;
            }
            else if (BlockKeywords.Contains(t.Text))
            {
                pending = t.Text;
            }
        }
        if (stack.Count == 0) return null;
        var top = stack.Peek();
        return top.Length == 0 ? null : top;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~TokenLocatorTests"`
Expected: PASS (7 tests). If a character-offset assertion is off by one, adjust the test's `character` value to match the actual source column — do not loosen the locator.

- [ ] **Step 6: Commit**

```bash
git add src/Koine.Compiler/Koine.Compiler.csproj src/Koine.Compiler/Services/TokenLocator.cs tests/Koine.Compiler.Tests/TokenLocatorTests.cs
git commit -m "feat(lsp): add lexer-only TokenLocator for IntelliSense"
```

---

## Task 2: KoineLanguageService + completion (type / declaration / suppression)

**Files:**
- Create: `src/Koine.Compiler/Services/KoineLanguageService.cs`
- Test: `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs`

- [ ] **Step 1: Write the failing test file**

Create `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs`:

```csharp
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class KoineLanguageServiceTests
{
    private static readonly KoineLanguageService Svc = new();

    private static IReadOnlyList<CompletionItem> Complete(string src, int line, int ch) =>
        Svc.CompleteAt(src, line, ch);

    [Fact]
    public void Type_position_offers_declared_and_primitive_types()
    {
        // value V { x:  }  — cursor after "x: " on line 1
        var src = "context C {\n  value V { x:  }\n}\n";
        var items = Complete(src, line: 1, ch: 14);
        Assert.Contains(items, i => i.Label == "Decimal");
        Assert.Contains(items, i => i.Label == "List");
        Assert.Contains(items, i => i.Label == "V"); // the declared value type
    }

    [Fact]
    public void Type_position_filters_by_partial_prefix()
    {
        // value V { x: Stri }
        var src = "context C {\n  value V { x: Stri }\n}\n";
        var items = Complete(src, line: 1, ch: 18);
        Assert.Contains(items, i => i.Label == "String");
        Assert.DoesNotContain(items, i => i.Label == "Decimal");
    }

    [Fact]
    public void Type_position_on_broken_doc_still_offers_primitives()
    {
        // Missing closing braces: parse fails, model is null. Keyword-less fallback
        // must still surface primitives + collection keywords.
        var src = "context C {\n  value V { x: ";
        var items = Complete(src, line: 1, ch: 15);
        Assert.Contains(items, i => i.Label == "String");
        Assert.Contains(items, i => i.Label == "List");
    }

    [Fact]
    public void Top_level_declaration_start_offers_context_keyword()
    {
        var items = Complete("\n", line: 0, ch: 0);
        Assert.Contains(items, i => i.Label == "context" && i.Kind == CompletionItemKind.Keyword);
    }

    [Fact]
    public void Inside_service_offers_operation_keyword()
    {
        var src = "context C {\n  service S {\n    \n  }\n}\n";
        var items = Complete(src, line: 2, ch: 4);
        Assert.Contains(items, i => i.Label == "operation");
        Assert.DoesNotContain(items, i => i.Label == "usecase");
    }

    [Fact]
    public void No_completion_inside_a_regex_literal()
    {
        var src = "context C {\n  value V { invariant raw matches /ab\n}\n";
        var items = Complete(src, line: 1, ch: 36);
        Assert.Empty(items);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests"`
Expected: FAIL to compile — `KoineLanguageService`, `CompletionItem`, `CompletionItemKind` do not exist.

- [ ] **Step 3: Implement the service with completion**

Create `src/Koine.Compiler/Services/KoineLanguageService.cs`:

```csharp
using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Services;

/// <summary>The kind of a completion item; the LSP shell maps these to LSP numbers.</summary>
public enum CompletionItemKind { Keyword, Class, Enum, EnumMember, Field, Property, Method }

/// <summary>A single completion candidate, free of any LSP/JSON concepts.</summary>
public sealed record CompletionItem(string Label, CompletionItemKind Kind, string? Detail, string? Documentation);

/// <summary>A hover card: rendered markdown plus the located token's 1-based start.</summary>
public sealed record HoverResult(string Markdown, SourceSpan Span);

/// <summary>A go-to-definition target: a single 1-based point (SourceSpan has no end).</summary>
public sealed record DefinitionResult(SourceSpan Target);

/// <summary>
/// Editor-agnostic language services for <c>.koi</c>: completion, hover, and
/// go-to-definition over (source, line, character). Completion is lexer-only and
/// works on broken documents; hover/definition build a model and return null when
/// parsing fails.
/// </summary>
public sealed class KoineLanguageService
{
    private readonly KoineCompiler _compiler;

    public KoineLanguageService() : this(new KoineCompiler()) { }
    public KoineLanguageService(KoineCompiler compiler) => _compiler = compiler;

    // Declaration keywords offered at a statement start, keyed by enclosing scope.
    private static readonly string[] FileStarters = { "context" };
    private static readonly string[] ContextStarters =
        { "value", "quantity", "entity", "aggregate", "enum", "event", "spec", "service", "policy" };
    private static readonly string[] AggregateStarters =
        { "value", "quantity", "entity", "enum", "event", "spec", "repository" };
    private static readonly string[] ServiceStarters = { "operation" };
    private static readonly string[] RepositoryStarters = { "operations", "find" };
    private static readonly string[] EntityStarters = { "states", "command", "create", "invariant" };

    private static readonly string[] CollectionKeywords =
        { ModelIndex.ListTypeName, ModelIndex.SetTypeName, ModelIndex.MapTypeName, ModelIndex.RangeTypeName };

    public IReadOnlyList<CompletionItem> CompleteAt(string source, int line, int character)
    {
        var ctx = TokenLocator.Locate(source, line, character);
        if (ctx.InsideStringOrRegex)
            return Array.Empty<CompletionItem>();

        var (model, _) = _compiler.Parse(source);
        var index = model is null ? null : new ModelIndex(model);

        var items = CandidatesFor(ctx, index);
        return Filter(items, ctx.Partial);
    }

    private IReadOnlyList<CompletionItem> CandidatesFor(TokenContext ctx, ModelIndex? index)
    {
        var trigger = ctx.PrecedingToken?.Type;

        // Type position: after ':' (member/param/return type), or '<'/',' inside a
        // generic argument list following a type name.
        if (trigger == KoineLexer.COLON
            || trigger == KoineLexer.ON
            // THEN: precise for policy reactions (then Type.command(...)); may over-offer
            // types after a conditional 'then' — acceptable, expression-aware completion is out of scope.
            || trigger == KoineLexer.THEN
            || IsGenericArgPosition(ctx, index))
            return TypeCandidates(index);

        // Member access: intentionally minimal this iteration. Resolving members
        // after '.' needs a parsed receiver expression + scope (TypeResolver), which
        // is unavailable on broken docs; we return nothing rather than guess (no noise).
        if (trigger == KoineLexer.DOT)
            return Array.Empty<CompletionItem>();

        // Enum value position handled in Task 3.

        // Declaration start: cursor at the start of a statement (after '{' or '}'),
        // or at file scope.
        if (ctx.PrecedingToken is null
            || trigger == KoineLexer.LBRACE
            || trigger == KoineLexer.RBRACE)
            return Keywords(StartersFor(ctx.EnclosingKeyword));

        return Array.Empty<CompletionItem>();
    }

    private static bool IsGenericArgPosition(TokenContext ctx, ModelIndex? index)
    {
        // Conservative: only treat '<' as a type-arg opener when the token before it
        // is a known type name. This avoids confusing the relational '<' operator in
        // an expression with a generic argument list. Without a model we cannot tell,
        // so we suppress.
        if (ctx.PrecedingToken?.Type != KoineLexer.LT || index is null)
            return false;
        var before = ctx.TokenBeforePreceding?.Text;
        return before is not null && index.IsKnownType(before);
    }

    private IReadOnlyList<CompletionItem> TypeCandidates(ModelIndex? index)
    {
        if (index is null)
        {
            // Broken document: offer primitives + collection keywords only.
            var fallback = ModelIndex.Primitives
                .Select(p => new CompletionItem(p, CompletionItemKind.Class, "primitive", null))
                .Concat(CollectionKeywords.Select(c => new CompletionItem(c, CompletionItemKind.Class, "collection", null)));
            return fallback.ToList();
        }

        return index.CandidateTypeNames
            .Select(name =>
            {
                var kind = index.Classify(name);
                return new CompletionItem(name, KindOf(kind), kind.ToString(), null);
            })
            .ToList();
    }

    private static CompletionItemKind KindOf(TypeKind kind) => kind switch
    {
        TypeKind.Enum => CompletionItemKind.Enum,
        _ => CompletionItemKind.Class, // Value/Entity/Aggregate/Event/IdValueObject/primitives all render as Class
    };

    private static string[] StartersFor(string? enclosing) => enclosing switch
    {
        null => FileStarters,
        "context" => ContextStarters,
        "aggregate" => AggregateStarters,
        "service" => ServiceStarters,
        "repository" => RepositoryStarters,
        "entity" => EntityStarters,
        _ => Array.Empty<string>(),
    };

    private static IReadOnlyList<CompletionItem> Keywords(string[] names) =>
        names.Select(n => new CompletionItem(n, CompletionItemKind.Keyword, "keyword", null)).ToList();

    private static IReadOnlyList<CompletionItem> Filter(IReadOnlyList<CompletionItem> items, string partial)
    {
        if (partial.Length == 0)
            return items;
        var matched = items.Where(i => i.Label.StartsWith(partial, StringComparison.Ordinal)).ToList();
        return matched; // empty list when nothing matches, by design
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests"`
Expected: PASS (6 tests). If a `ch:` column is off, correct the test's column to the real source position.

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Services/KoineLanguageService.cs tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs
git commit -m "feat(lsp): add KoineLanguageService with type and keyword completion"
```

---

## Task 3: Enum-member and member-access completion

**Files:**
- Modify: `src/Koine.Compiler/Services/KoineLanguageService.cs`
- Test: `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs`

- [ ] **Step 1: Add failing tests**

Append these methods to `KoineLanguageServiceTests`:

```csharp
    [Fact]
    public void Enum_value_position_offers_members_filtered_by_partial()
    {
        // status: OrderStatus = Dr   -> members of OrderStatus starting with "Dr"
        var src =
            "context C {\n" +
            "  enum OrderStatus { Draft, Placed, Shipped }\n" +
            "  entity E identified by EId { status: OrderStatus = Dr }\n" +
            "}\n";
        var items = Complete(src, 2, 55); // partial == "Dr"
        Assert.Contains(items, i => i.Label == "Draft" && i.Kind == CompletionItemKind.EnumMember);
        Assert.DoesNotContain(items, i => i.Label == "Placed");
    }

    [Fact]
    public void Member_access_emits_no_property_noise()
    {
        // Cursor immediately after '.', before a member name. The DOT trigger
        // must return nothing rather than guess members (the no-noise contract).
        var src =
            "context C {\n" +
            "  value V { a: Int }\n" +
            "  spec S on V = v.\n" +
            "}\n";
        var items = Complete(src, 2, 18); // one past the '.' on line 2
        Assert.Empty(items);
    }
```

- [ ] **Step 2: Run to verify the enum test fails**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests.Enum_value_position_offers_members_filtered_by_partial"`
Expected: FAIL — enum members not yet offered.

- [ ] **Step 3: Implement enum-member completion**

In `KoineLanguageService.CandidatesFor`, replace the comment line `// Enum value position handled in Task 3.` with:

```csharp
        // Enum value position: after '=' (a field/param default). Resolve the
        // governing enum from the preceding `name : EnumType =` triple when possible;
        // otherwise fall back to every known enum member (still useful mid-edit).
        if (trigger == KoineLexer.ASSIGN)
            return EnumMemberCandidates(ctx, index);
```

Then add these methods to the class (`TokenContext.TokenBeforePreceding`, defined in Task 1, gives the `TypeName` token in `name : TypeName = <cursor>`):

```csharp
    private IReadOnlyList<CompletionItem> EnumMemberCandidates(TokenContext ctx, ModelIndex? index)
    {
        if (index is null)
            return Array.Empty<CompletionItem>();

        // Resolve the governing enum from the type name just before '=' .
        var typeName = ctx.TokenBeforePreceding?.Text;
        if (typeName is not null && index.IsEnumType(typeName)
            && index.TryGetDecl(typeName, out var decl) && decl is EnumDecl e)
            return e.Members
                .Select(m => new CompletionItem(m.Name, CompletionItemKind.EnumMember, typeName, m.Doc))
                .ToList();

        // Fallback (e.g. the type name is not directly to the left): every enum member
        // declared anywhere — ambiguous, still useful mid-edit.
        return index.EnumMemberToType
            .Select(kvp => new CompletionItem(kvp.Key, CompletionItemKind.EnumMember, kvp.Value, null))
            .ToList();
    }
```

- [ ] **Step 4: Run the enum + member tests to verify they pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests"`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Services/KoineLanguageService.cs tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs
git commit -m "feat(lsp): add enum-member completion"
```

---

## Task 4: Hover

**Files:**
- Modify: `src/Koine.Compiler/Services/KoineLanguageService.cs`
- Test: `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs`

- [ ] **Step 1: Add failing tests**

Append to `KoineLanguageServiceTests`:

```csharp
    [Fact]
    public void Hover_over_a_value_type_shows_kind_and_members()
    {
        // hovering "Money" in the field type position
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var hover = Svc.HoverAt(src, line: 2, ch: 21); // over "Money"
        Assert.NotNull(hover);
        Assert.Contains("Money", hover!.Markdown);
        Assert.Contains("Value", hover.Markdown);     // the kind label
        Assert.Contains("amount", hover.Markdown);     // a member
    }

    [Fact]
    public void Hover_returns_null_on_a_broken_document()
    {
        var src = "context C {\n  value Money { amount: ";
        Assert.Null(Svc.HoverAt(src, line: 1, ch: 9)); // over "Money", parse fails
    }

    [Fact]
    public void Hover_over_whitespace_returns_null()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        Assert.Null(Svc.HoverAt(src, line: 0, ch: 0));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests.Hover"`
Expected: FAIL — `HoverAt` not implemented (returns nothing / compile error if not declared).

- [ ] **Step 3: Implement HoverAt**

Add to `KoineLanguageService`:

```csharp
    public HoverResult? HoverAt(string source, int line, int character)
    {
        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var (model, _) = _compiler.Parse(source);
        if (model is null)
            return null;
        var index = new ModelIndex(model);

        var markdown = RenderHover(name, index);
        if (markdown is null)
            return null;

        var span = new SourceSpan(ctx.CurrentToken!.Line, ctx.CurrentToken.Column + 1);
        return new HoverResult(markdown, span);
    }

    private static string? RenderHover(string name, ModelIndex index)
    {
        // 1. A declared type.
        if (index.TryGetDecl(name, out var decl))
        {
            var kind = index.Classify(name);
            var sb = new System.Text.StringBuilder();
            sb.Append("**").Append(name).Append("** *(").Append(KindLabel(kind)).Append(")*");
            AppendBody(sb, decl);
            if (decl.Doc is { Length: > 0 } doc)
                sb.Append("\n\n").Append(doc);
            return sb.ToString();
        }

        // 2. A bare enum member.
        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1)
            return $"**{name}** *(enum member of {owners[0]})*";
        if (owners.Count >= 2)
            return $"**{name}** *(ambiguous enum member — declared in {string.Join(", ", owners)})*";

        // 3. A spec.
        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null)
            return $"**{name}** *(spec on {spec.TargetType})*";

        // 4. Primitives / collection keywords / ID value objects: minimal card.
        var classified = index.Classify(name);
        return classified == TypeKind.Unknown ? null : $"**{name}** *({KindLabel(classified)})*";
    }

    private static string KindLabel(TypeKind kind) => kind switch
    {
        TypeKind.IdValueObject => "ID value object",
        _ => kind.ToString(),
    };

    /// <summary>Renders a type reference with its generic arguments and optionality (e.g. List&lt;OrderLine&gt;, String?).</summary>
    private static string TypeLabel(TypeRef t)
    {
        var name = t.Element is null ? t.Name
            : t.Value is null ? $"{t.Name}<{TypeLabel(t.Element)}>"
            : $"{t.Name}<{TypeLabel(t.Element)}, {TypeLabel(t.Value)}>";
        return t.IsOptional ? name + "?" : name;
    }

    private static void AppendBody(System.Text.StringBuilder sb, TypeDecl decl)
    {
        switch (decl)
        {
            case ValueObjectDecl v:
                foreach (var m in v.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EntityDecl e:
                sb.Append("\n\nidentified by `").Append(e.IdentityName).Append("` (")
                  .Append(e.IdStrategy).Append(')');
                foreach (var m in e.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EnumDecl en:
                sb.Append("\n\n").Append(string.Join(", ", en.MemberNames));
                break;
            case EventDecl ev:
                foreach (var m in ev.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case AggregateDecl agg:
                sb.Append("\n\nroot `").Append(agg.RootName).Append('`');
                if (agg.IsVersioned) sb.Append(" *(versioned)*");
                break;
        }
    }
```

> Note: `readmodel`/`query` are not yet grammar keywords (the AST types `ReadModelDecl`/`QueryDecl` exist but the parser cannot produce them at this base), so they are intentionally omitted from completion starters and hover rendering. Add them when the grammar gains those keywords.

- [ ] **Step 4: Run to verify the hover tests pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests"`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Services/KoineLanguageService.cs tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs
git commit -m "feat(lsp): add hover with per-kind markdown cards"
```

---

## Task 5: Go-to-definition

**Files:**
- Modify: `src/Koine.Compiler/Services/KoineLanguageService.cs`
- Test: `tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs`

- [ ] **Step 1: Add failing tests**

Append to `KoineLanguageServiceTests`:

```csharp
    [Fact]
    public void Definition_of_a_type_reference_points_at_its_declaration()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var def = Svc.DefinitionAt(src, line: 2, ch: 21); // over "Money"
        Assert.NotNull(def);
        Assert.Equal(2, def!.Target.Line);  // 1-based line of "value Money"
    }

    [Fact]
    public void Definition_of_an_enum_member_points_at_the_member()
    {
        var src =
            "context C {\n" +
            "  enum OrderStatus { Draft, Placed }\n" +
            "  entity E identified by EId { status: OrderStatus = Draft }\n" +
            "}\n";
        var def = Svc.DefinitionAt(src, line: 2, ch: 54); // over "Draft" value
        Assert.NotNull(def);
        Assert.Equal(2, def!.Target.Line);
    }

    [Fact]
    public void Definition_of_a_primitive_is_null()
    {
        var src = "context C {\n  value V { x: Decimal }\n}\n";
        Assert.Null(Svc.DefinitionAt(src, line: 1, ch: 18)); // over "Decimal"
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests.Definition"`
Expected: FAIL — `DefinitionAt` not implemented.

- [ ] **Step 3: Implement DefinitionAt**

Add to `KoineLanguageService`:

```csharp
    public DefinitionResult? DefinitionAt(string source, int line, int character)
    {
        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var (model, _) = _compiler.Parse(source);
        if (model is null)
            return null;
        var index = new ModelIndex(model);

        // 1. A declared type -> its declaration span.
        if (index.TryGetDecl(name, out var decl) && decl.Span != SourceSpan.None)
            return new DefinitionResult(decl.Span);

        // 2. An enum member -> the member's own span. Navigate only when the member
        // name is unambiguous; if two enums declare it, fall through (return null)
        // rather than jump to an arbitrary one — matches hover's ambiguity handling.
        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1
            && index.TryGetDecl(owners[0], out var enumDecl) && enumDecl is EnumDecl e)
        {
            var member = e.Members.FirstOrDefault(m => m.Name == name);
            if (member is not null && member.Span != SourceSpan.None)
                return new DefinitionResult(member.Span);
        }

        // 3. A spec -> its declaration span.
        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null && spec.Span != SourceSpan.None)
            return new DefinitionResult(spec.Span);

        // Primitives, collection keywords, and ID value objects have no node: not navigable.
        return null;
    }
```

- [ ] **Step 4: Run to verify the definition tests pass**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~KoineLanguageServiceTests"`
Expected: PASS (all tests). If a `Target.Line` assertion fails, confirm against the fixture which line the declaration keyword sits on (`SpanOf` points at the keyword).

- [ ] **Step 5: Commit**

```bash
git add src/Koine.Compiler/Services/KoineLanguageService.cs tests/Koine.Compiler.Tests/KoineLanguageServiceTests.cs
git commit -m "feat(lsp): add go-to-definition over types, enum members, and specs"
```

---

## Task 6: Wire features into the LSP server

**Files:**
- Modify: `src/Koine.Cli/LspServer.cs`
- Test: `tests/Koine.Compiler.Tests/LspServerTests.cs`

- [ ] **Step 1: Add failing protocol tests**

In `tests/Koine.Compiler.Tests/LspServerTests.cs`, add these helpers and tests inside the class:

```csharp
    private static byte[] Completion(string uri, int line, int character) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 10,
            method = "textDocument/completion",
            @params = new { textDocument = new { uri }, position = new { line, character } },
        }));

    private static byte[] Hover(string uri, int line, int character) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 11,
            method = "textDocument/hover",
            @params = new { textDocument = new { uri }, position = new { line, character } },
        }));

    private static byte[] Definition(string uri, int line, int character) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 12,
            method = "textDocument/definition",
            @params = new { textDocument = new { uri }, position = new { line, character } },
        }));

    [Fact]
    public void Initialize_advertises_intellisense_capabilities()
    {
        var output = RunSession(Initialize());
        Assert.Contains("\"completionProvider\"", output);
        Assert.Contains("\"hoverProvider\":true", output);
        Assert.Contains("\"definitionProvider\":true", output);
    }

    [Fact]
    public void Completion_request_returns_items()
    {
        var doc = "context C {\n  value V { x:  }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Completion("file:///t.koi", 1, 14));
        Assert.Contains("\"items\"", output);
        Assert.Contains("Decimal", output);
    }

    [Fact]
    public void Hover_request_returns_markdown()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Hover("file:///t.koi", 2, 23));
        Assert.Contains("\"kind\":\"markdown\"", output);
        Assert.Contains("Money", output);
    }

    [Fact]
    public void Definition_request_returns_a_range()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Definition("file:///t.koi", 2, 23));
        Assert.Contains("\"range\"", output);
        Assert.Contains("file:///t.koi", output);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj --filter "FullyQualifiedName~LspServerTests"`
Expected: FAIL — capabilities absent; completion/hover/definition currently return `-32601`.

- [ ] **Step 3: Add the language service field and document cache**

In `src/Koine.Cli/LspServer.cs`, just below `private readonly KoineCompiler _compiler = new();` add:

```csharp
    private readonly KoineLanguageService _ls = new();
    private readonly Dictionary<string, string> _docs = new(StringComparer.Ordinal);
```

- [ ] **Step 4: Populate the document cache in the sync handlers**

In the `Loop()` switch, update the existing cases to store text. Replace the `textDocument/didOpen` case body with:

```csharp
                    case "textDocument/didOpen":
                        if (TryGetTextDocument(root, out var openUri, out var openText))
                        {
                            _docs[openUri] = openText;
                            PublishDiagnostics(openUri, openText);
                        }
                        break;
```

Replace the `textDocument/didChange` case body with:

```csharp
                    case "textDocument/didChange":
                        if (TryGetChange(root, out var changeUri, out var changeText))
                        {
                            _docs[changeUri] = changeText;
                            PublishDiagnostics(changeUri, changeText);
                        }
                        break;
```

Replace the `textDocument/didSave` case body with:

```csharp
                    case "textDocument/didSave":
                        if (TryGetSave(root, out var saveUri, out var saveText) && saveText is not null)
                        {
                            _docs[saveUri] = saveText;
                            PublishDiagnostics(saveUri, saveText);
                        }
                        break;
```

Replace the `textDocument/didClose` case body with:

```csharp
                    case "textDocument/didClose":
                        if (TryGetUri(root, out var closeUri))
                        {
                            _docs.Remove(closeUri);
                            PublishDiagnostics(closeUri, diagnostics: Array.Empty<object>()); // clear
                        }
                        break;
```

- [ ] **Step 5: Advertise the new capabilities**

In the `initialize` case, replace the `["capabilities"]` dictionary with:

```csharp
                            ["capabilities"] = new Dictionary<string, object?>
                            {
                                ["textDocumentSync"] = 1, // Full
                                ["completionProvider"] = new Dictionary<string, object?>
                                {
                                    ["resolveProvider"] = false,
                                    ["triggerCharacters"] = new[] { ":", "." },
                                },
                                ["hoverProvider"] = true,
                                ["definitionProvider"] = true,
                            },
```

- [ ] **Step 6: Add the three request cases**

In the `Loop()` switch, add these cases before the `case "shutdown":` label:

```csharp
                    case "textDocument/completion":
                        if (root.TryGetProperty("id", out _))
                            Respond(root, CompletionResult(root));
                        break;

                    case "textDocument/hover":
                        if (root.TryGetProperty("id", out _))
                            Respond(root, HoverResultJson(root));
                        break;

                    case "textDocument/definition":
                        if (root.TryGetProperty("id", out _))
                            Respond(root, DefinitionResultJson(root));
                        break;
```

- [ ] **Step 7: Add the translation helpers**

Add these methods to `LspServer` (next to `PublishDiagnostics`):

```csharp
    private object? CompletionResult(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch)
            || !_docs.TryGetValue(uri, out var text))
            return null;

        var items = _ls.CompleteAt(text, line, ch)
            .Select(i => (object)new Dictionary<string, object?>
            {
                ["label"] = i.Label,
                ["kind"] = LspKind(i.Kind),
                ["detail"] = i.Detail,
                ["documentation"] = i.Documentation,
            })
            .ToArray();

        return new Dictionary<string, object?> { ["isIncomplete"] = false, ["items"] = items };
    }

    private object? HoverResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch)
            || !_docs.TryGetValue(uri, out var text))
            return null;

        var hover = _ls.HoverAt(text, line, ch);
        if (hover is null)
            return null;

        return new Dictionary<string, object?>
        {
            ["contents"] = new Dictionary<string, object?>
            {
                ["kind"] = "markdown",
                ["value"] = hover.Markdown,
            },
        };
    }

    private object? DefinitionResultJson(JsonElement root)
    {
        if (!TryGetUri(root, out var uri) || !TryGetPosition(root, out var line, out var ch)
            || !_docs.TryGetValue(uri, out var text))
            return null;

        var def = _ls.DefinitionAt(text, line, ch);
        if (def is null)
            return null;

        // SpanOf points at the declaration keyword and Column is 1-based; the LSP
        // range is 0-based and zero-width (editor recomputes the identifier extent).
        var startLine = Math.Max(0, def.Target.Line - 1);
        var startChar = Math.Max(0, def.Target.Column - 1);
        return new Dictionary<string, object?>
        {
            // Single-file model: the definition always lives in the requesting document.
            ["uri"] = uri,
            ["range"] = new Dictionary<string, object?>
            {
                ["start"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
                ["end"] = new Dictionary<string, object?> { ["line"] = startLine, ["character"] = startChar },
            },
        };
    }

    /// <summary>Maps a service completion kind to its LSP CompletionItemKind number.</summary>
    private static int LspKind(CompletionItemKind kind) => kind switch
    {
        CompletionItemKind.Keyword => 14,
        CompletionItemKind.Class => 7,
        CompletionItemKind.Enum => 13,
        CompletionItemKind.EnumMember => 20,
        CompletionItemKind.Field => 5,
        CompletionItemKind.Property => 10,
        CompletionItemKind.Method => 2,
        _ => 1,
    };

    private static bool TryGetPosition(JsonElement root, out int line, out int character)
    {
        line = 0; character = 0;
        if (root.TryGetProperty("params", out var p)
            && p.TryGetProperty("position", out var pos)
            && pos.TryGetProperty("line", out var l)
            && pos.TryGetProperty("character", out var c)
            && l.TryGetInt32(out line)
            && c.TryGetInt32(out character))
            return true;
        return false;
    }
```

- [ ] **Step 8: Add the using for the service types**

At the top of `src/Koine.Cli/LspServer.cs`, confirm `using Koine.Compiler.Services;` is present (it is — `KoineCompiler` already lives there, so `KoineLanguageService`, `CompletionItem`, `CompletionItemKind` resolve from the same namespace).

- [ ] **Step 9: Run all tests**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: PASS — all existing tests plus the new protocol tests. The pre-existing `Unknown_request_gets_method_not_found` still passes (it uses an unmapped method).

- [ ] **Step 10: Commit**

```bash
git add src/Koine.Cli/LspServer.cs tests/Koine.Compiler.Tests/LspServerTests.cs
git commit -m "feat(lsp): serve completion, hover, and definition over JSON-RPC"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `tooling/README.md`

- [ ] **Step 1: Update README.md**

Find the existing LSP paragraph (around `README.md:237`, mentioning "live error squiggles"). Replace the sentence that describes only diagnostics so it reads:

```markdown
For **live error squiggles, code completion, hover docs, and go-to-definition** in the editor, run the bundled language server (`koine lsp`) and point Rider at it via the LSP4IJ plugin — setup in [`tooling/README.md`](tooling/README.md#live-diagnostics-language-server).
```

- [ ] **Step 2: Update tooling/README.md**

Open `tooling/README.md`, find the "Live diagnostics (language server)" section, and add a subsection after the setup steps:

```markdown
### Editor features

`koine lsp` provides, over stdio (LSP):

- **Diagnostics** — syntax and semantic errors as you type.
- **Completion** (`Ctrl Space`) — type names after `:`, enum members after `=`, and declaration keywords at statement starts. Works even while the document is mid-edit / not yet valid.
- **Hover** — a card showing a type's kind, members, and doc comment.
- **Go-to-definition** — jump from a type/enum-member/spec reference to its declaration. (Note: navigation currently lands on the declaration keyword, not the name token.)
```

- [ ] **Step 3: Verify docs build / links**

Run: `git diff --stat README.md tooling/README.md`
Expected: both files show as modified. Visually confirm the anchor `#live-diagnostics-language-server` still matches the heading in `tooling/README.md`.

- [ ] **Step 4: Commit**

```bash
git add README.md tooling/README.md
git commit -m "docs(lsp): document completion, hover, and go-to-definition"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj`
Expected: all tests pass (existing + the new locator, service, and protocol tests).

- [ ] **Smoke-test the server manually (optional)**

Run: `dotnet run --project src/Koine.Cli -- lsp` and pipe a framed `initialize` request; confirm the response JSON contains `completionProvider`, `hoverProvider`, and `definitionProvider`. (The automated protocol tests already cover this.)

---

## Notes & limitations (carried from the spec)

- **Go-to-definition lands on the declaration keyword**, not the name token (`SpanOf` uses `ctx.Start`); the LSP range is zero-width. A precise name-token span is out of scope.
- **`<`/`,` generic-argument detection is conservative** — mid-expression `<` offers no type completion rather than risking wrong candidates.
- **Member-access completion needs a successful parse** and a resolvable receiver; it returns nothing on broken documents (no noise) and is intentionally minimal in this iteration.
- **Ambiguous enum members** (declared in ≥2 enums): completion lists all; hover shows an ambiguous card; definition returns null (no misleading jump) rather than navigating to an arbitrary owner.
- Out of scope: signature help, find-references, rename, cross-file/workspace symbols, incremental sync, completion `resolve`.
