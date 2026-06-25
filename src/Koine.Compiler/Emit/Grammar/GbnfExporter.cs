using System.Text;

namespace Koine.Compiler.Emit.Grammar;

/// <summary>
/// Derives a <a href="https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md">GBNF</a>
/// grammar (llama.cpp's BNF-style format for constrained decoding) from Koine's ANTLR grammar
/// (<c>Grammar/KoineParser.g4</c> + <c>Grammar/KoineLexer.g4</c>). A constrained decoder fed this
/// grammar can only emit syntactically valid <c>.koi</c>, which is the foundation for
/// grammar-constrained <c>.koi</c> generation (issue #257).
///
/// <para>This is a <b>pragmatic subset</b>, not a faithful translation of every parser rule: it
/// covers the core constructs (<c>context</c>, <c>value</c>, <c>entity</c>, <c>aggregate</c>,
/// <c>enum</c>, <c>command</c>, <c>event</c>) plus enough of the member/expression sublanguage to
/// keep the output self-contained and well-formed. Task 2 of #257 widens it to accept every
/// template.</para>
///
/// <para>It is a pure, target-agnostic projection of the grammar files — it never touches the
/// <c>Ast/</c> semantic model nor any emitter target — so it lives under <c>Emit/Grammar/</c> and
/// produces byte-identical output on every run (no timestamps, fixed rule order).</para>
/// </summary>
public static class GbnfExporter
{
    /// <summary>
    /// The pragmatic Koine subset, as an ordered list of <c>(name, body)</c> GBNF rules.
    /// Whitespace is threaded explicitly through <c>ws</c> because GBNF has no implicit
    /// inter-token whitespace. The <c>matches /regex/</c> form mirrors the lexer's REGEX_MODE:
    /// the regex literal is ONE <c>regex</c> token, not two <c>/</c> division operators.
    /// </summary>
    private static readonly (string Name, string Body)[] Rules =
    {
        // ---- Top level -----------------------------------------------------
        ("root", "ws (context)+ ws"),
        ("context", "\"context\" ws ident ws (\"version\" ws int ws)? \"{\" ws (context-member ws)* \"}\""),
        ("context-member", "type-decl | spec-decl"),

        // ---- Type declarations --------------------------------------------
        ("type-decl", "value | entity | aggregate | enum | event | command"),
        ("value", "\"value\" ws ident ws \"{\" ws (member ws)* (invariant ws)* \"}\""),
        ("entity", "\"entity\" ws ident ws \"identified\" ws \"by\" ws ident ws \"{\" ws (member ws)* (invariant ws)* (command ws)* \"}\""),
        ("aggregate", "\"aggregate\" ws ident ws \"root\" ws ident ws \"{\" ws (type-decl ws)* \"}\""),
        ("enum", "\"enum\" ws ident ws \"{\" ws enum-member (ws \",\"? ws enum-member)* ws \"}\""),
        ("enum-member", "ident"),
        ("event", "\"event\" ws ident ws \"{\" ws (member ws)* \"}\""),

        // ---- Commands ------------------------------------------------------
        ("command", "\"command\" ws ident ws (\"(\" ws param-list? ws \")\" ws)? \"{\" ws (command-stmt ws)* \"}\""),
        ("command-stmt", "requires-clause | transition | emit-clause"),
        ("requires-clause", "\"requires\" ws expression (ws string)?"),
        ("transition", "ident ws \"->\" ws expression"),
        ("emit-clause", "\"emit\" ws ident ws (\"(\" ws \")\")?"),

        // ---- Specifications, params, members ------------------------------
        ("spec-decl", "\"spec\" ws ident ws \"on\" ws ident ws \"=\" ws expression"),
        ("param-list", "param (ws \",\" ws param)*"),
        ("param", "ident ws \":\" ws type-ref"),
        ("member", "ident ws \":\" ws type-ref (ws \"=\" ws expression)?"),
        ("type-ref", "ident (ws \"<\" ws type-ref (ws \",\" ws type-ref)? ws \">\")? \"?\"?"),
        ("invariant", "\"invariant\" ws expression (ws string)?"),

        // ---- Expression sublanguage (pragmatic) ---------------------------
        // `match-expr` carries the `matches /regex/` form as a single regex token.
        ("expression", "match-expr"),
        ("match-expr", "primary (ws \"matches\" ws regex)?"),
        ("primary", "literal | ident | \"(\" ws expression ws \")\""),
        ("literal", "bool | decimal | int | string"),

        // ---- Terminals (mirroring KoineLexer.g4) --------------------------
        ("ident", "[a-zA-Z_] [a-zA-Z0-9_]*"),
        ("int", "[0-9]+"),
        ("decimal", "[0-9]+ \".\" [0-9]+"),
        ("bool", "\"true\" | \"false\""),
        ("string", "[\"] ([^\"\\\\] | [\\\\] .)* [\"]"),
        // The regex literal: opened and closed by `/`, one token (lexer REGEX_MODE).
        ("regex", "[/] ([^/\\\\] | [\\\\] .)* [/]"),
        ("ws", "[ \\t\\r\\n]*"),
    };

    /// <summary>
    /// Projects the pragmatic Koine grammar subset to a self-contained GBNF string.
    /// </summary>
    /// <returns>A syntactically valid, deterministic GBNF grammar with a <c>root</c> rule.</returns>
    public static string Export()
    {
        var sb = new StringBuilder();

        sb.Append("# GBNF grammar for Koine (.koi) — pragmatic subset.\n");
        sb.Append("# Derived from Grammar/KoineParser.g4 + KoineLexer.g4 by\n");
        sb.Append("# Koine.Compiler.Emit.Grammar.GbnfExporter for grammar-constrained .koi decoding.\n");
        sb.Append("# Whitespace is threaded explicitly via `ws`; `matches /regex/` is one regex token.\n");
        sb.Append('\n');

        foreach ((string name, string body) in Rules)
        {
            sb.Append(name).Append(" ::= ").Append(body).Append('\n');
        }

        return sb.ToString();
    }
}
