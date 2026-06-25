using Koine.Compiler.Emit.Grammar;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #257 / Task 1 — the GBNF exporter. <see cref="GbnfExporter.Export"/> derives a
/// llama.cpp GBNF grammar from Koine's ANTLR grammar so a constrained decoder can be made
/// to emit only syntactically valid <c>.koi</c>. These tests pin the foundation: the output
/// is non-empty, has a <c>root</c> rule, and covers the core constructs.
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

    private static IEnumerable<string> RuleReferences(string body)
    {
        var stripped = new System.Text.StringBuilder();
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
