using System.Text;
using Koine.Compiler.Emit.Grammar;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #257 — the GBNF exporter. <see cref="GbnfExporter.Export"/> derives a llama.cpp GBNF
/// grammar from Koine's ANTLR grammar so a constrained decoder can be made to emit only
/// syntactically valid <c>.koi</c>.
///
/// <para><b>Task 1</b> pinned the foundation: the output is non-empty, has a <c>root</c> rule,
/// covers the core constructs, and is self-contained.</para>
///
/// <para><b>Task 2</b> is the round-trip <i>acceptance floor</i>: the exported grammar must accept
/// <em>every committed template under <c>templates/**</c></em> and reject deliberately malformed
/// input. "Accept" here is a genuine full-parse: a small, test-only recursive recogniser
/// (<see cref="GbnfMatcher"/>) interprets the exported GBNF and decides whether an input is in its
/// language. The recogniser runs over the token stream produced by a faithful mini-lexer
/// (<see cref="KoineTokenizer"/>) — exactly the lexer/parser split the real compiler uses, where
/// whitespace and comments ride hidden channels and the parser reads only the token stream. So a
/// green run means "a decoder constrained to this grammar could have produced this template", not
/// merely that the grammar mentions the right keywords.</para>
/// </summary>
public class R17GbnfExportTests
{
    [Fact]
    public void Export_returns_non_empty_grammar()
    {
        string gbnf = GbnfExporter.Export();

        gbnf.ShouldNotBeNullOrWhiteSpace();
    }

    [Fact]
    public void Export_defines_a_root_rule()
    {
        string gbnf = GbnfExporter.Export();

        gbnf.ShouldContain("root ::=");
    }

    /// <summary>
    /// Task 3 (issue #257) — the browser/desktop interop surface. Koine Studio fetches the grammar over
    /// the WASM export <c>CompilerInterop.GbnfGrammar()</c>
    /// (<c>src/Koine.Wasm/CompilerInterop.LanguageService.cs</c>), which is a verified one-line delegation
    /// to <see cref="GbnfExporter.Export"/>. That <c>browser-wasm</c> <c>Exe</c> cannot be referenced from
    /// this <c>net10.0</c> test project, so we cannot call the interop method directly; instead we pin the
    /// exact contract it forwards: the grammar is non-empty and <b>deterministic</b> (repeated calls return
    /// the identical string), which is precisely what a Studio fetch receives across calls.
    /// </summary>
    [Fact]
    public void Export_is_non_empty_and_deterministic()
    {
        string first = GbnfExporter.Export();
        string second = GbnfExporter.Export();

        first.ShouldNotBeNullOrWhiteSpace();
        second.ShouldBe(first);
    }

    [Theory]
    [InlineData("context")]
    [InlineData("value")]
    [InlineData("entity")]
    [InlineData("aggregate")]
    [InlineData("enum")]
    [InlineData("command")]
    [InlineData("event")]
    public void Export_covers_each_core_construct(string keyword)
    {
        string gbnf = GbnfExporter.Export();

        // The keyword appears as a quoted GBNF terminal (e.g. `"context"`).
        gbnf.ShouldContain($"\"{keyword}\"");
    }

    [Fact]
    public void Export_models_the_matches_regex_literal_as_a_single_token()
    {
        string gbnf = GbnfExporter.Export();

        // `matches /regex/` must be one regex literal, not two `/` division operators.
        gbnf.ShouldContain("\"matches\"");
        gbnf.ShouldContain("regex");
    }

    [Fact]
    public void Export_defines_every_rule_it_references()
    {
        string gbnf = GbnfExporter.Export();

        // Collect the defined rule names (left-hand sides of `name ::=`) and every
        // referenced rule name, then prove the grammar is self-contained.
        var defined = new HashSet<string>();
        var referenced = new List<string>();

        foreach (string rawLine in gbnf.Split('\n'))
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            int arrow = line.IndexOf("::=", StringComparison.Ordinal);
            string body = line;
            if (arrow >= 0)
            {
                string name = line[..arrow].Trim();
                if (name.Length > 0)
                {
                    defined.Add(name);
                }

                body = line[(arrow + 3)..];
            }

            // A rule reference is a bare identifier token, not inside a "..." string
            // terminal and not a [..] char class. Strip those out, then scan words.
            referenced.AddRange(RuleReferences(body));
        }

        foreach (string name in referenced)
        {
            defined.ShouldContain(name, $"rule '{name}' is referenced but never defined");
        }
    }

    // -------------------------------------------------------------------------
    // Task 2 — the acceptance floor: accept every template, reject malformed input.
    // -------------------------------------------------------------------------

    /// <summary>
    /// Every committed <c>.koi</c> under the repository's <c>templates/</c> directory, discovered at
    /// runtime (never hardcoded) by walking up to the repo root — returned as xUnit theory data so a
    /// failure names the exact template that the grammar cannot yet accept.
    /// </summary>
    public static IEnumerable<object[]> TemplateKoiFiles()
    {
        string templates = TestSupport.RepoPath("templates");
        foreach (string path in Directory
            .EnumerateFiles(templates, "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal))
        {
            // A repo-relative label keeps the theory case name stable/readable across machines.
            yield return [Path.GetRelativePath(templates, path).Replace('\\', '/')];
        }
    }

    [Theory]
    [MemberData(nameof(TemplateKoiFiles))]
    public void Exported_grammar_accepts_every_template(string relativePath)
    {
        string gbnf = GbnfExporter.Export();
        string source = File.ReadAllText(Path.Combine(TestSupport.RepoPath("templates"), relativePath));

        GbnfMatcher.Accepts(gbnf, source)
            .ShouldBeTrue($"the exported GBNF must accept template templates/{relativePath}");
    }

    [Fact]
    public void Exported_grammar_rejects_a_foreign_token()
    {
        string gbnf = GbnfExporter.Export();
        string good = File.ReadAllText(TestSupport.RepoPath("templates/starters/billing/billing.koi"));

        // Control: the unmutated template is accepted (so the rejection below is meaningful,
        // not a matcher that rejects everything).
        GbnfMatcher.Accepts(gbnf, good)
            .ShouldBeTrue("sanity: the unmutated billing template must be accepted");

        // Mutation: inject a stray `;` — a token the Koine lexer never produces and the GBNF
        // never defines. Structural coverage of keywords alone would miss this; a real parse
        // cannot consume it, so the whole input falls out of the language.
        string garbage = good.Replace("amount: Decimal", "amount: Decimal;");
        garbage.ShouldNotBe(good, "the mutation must actually change the source");

        GbnfMatcher.Accepts(gbnf, garbage)
            .ShouldBeFalse("a foreign ';' token must make the input unparseable by the exported GBNF");
    }

    [Fact]
    public void Exported_grammar_rejects_structurally_broken_koine()
    {
        string gbnf = GbnfExporter.Export();

        // Control: a minimal, well-formed context is accepted.
        const string wellFormed = "context Billing { value Money { amount: Decimal } }";
        GbnfMatcher.Accepts(gbnf, wellFormed)
            .ShouldBeTrue("sanity: a minimal well-formed context must be accepted");

        // Mutation: a typo'd construct keyword (`context` -> `kontext`) lexes to a bare identifier
        // where the grammar's `root` demands a `context`/`contextmap` keyword, so the program no
        // longer derives from `root`.
        const string typoKeyword = "kontext Billing { value Money { amount: Decimal } }";
        GbnfMatcher.Accepts(gbnf, typoKeyword)
            .ShouldBeFalse("a program that does not start with a construct keyword must be rejected");

        // Mutation: an unbalanced brace cannot consume the whole token stream from `root`.
        const string unbalanced = "context Billing { value Money { amount: Decimal }";
        GbnfMatcher.Accepts(gbnf, unbalanced)
            .ShouldBeFalse("an unbalanced/truncated program must be rejected");
    }

    private static IEnumerable<string> RuleReferences(string body)
    {
        var stripped = new StringBuilder();
        bool inString = false;
        bool inClass = false;
        for (int i = 0; i < body.Length; i++)
        {
            char c = body[i];
            if (inString)
            {
                if (c == '"')
                {
                    inString = false;
                }

                continue;
            }

            if (inClass)
            {
                if (c == ']')
                {
                    inClass = false;
                }

                continue;
            }

            switch (c)
            {
                case '"':
                    inString = true;
                    break;
                case '[':
                    inClass = true;
                    break;
                default:
                    stripped.Append(c);
                    break;
            }
        }

        foreach (string token in stripped.ToString()
                     .Split(new[] { ' ', '\t', '(', ')', '|', '*', '+', '?' }, StringSplitOptions.RemoveEmptyEntries))
        {
            // A rule name is a lowercase identifier (GBNF rule names use [a-z-]).
            if (token.Length > 0 && char.IsLetter(token[0]) && token.All(ch => char.IsLetterOrDigit(ch) || ch == '-'))
            {
                yield return token;
            }
        }
    }
}
