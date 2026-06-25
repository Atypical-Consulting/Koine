using System.Text;

namespace Koine.Compiler.Emit.Grammar;

/// <summary>
/// Derives a <a href="https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md">GBNF</a>
/// grammar (llama.cpp's BNF-style format for constrained decoding) from Koine's ANTLR grammar
/// (<c>Grammar/KoineParser.g4</c> + <c>Grammar/KoineLexer.g4</c>). A constrained decoder fed this
/// grammar can only emit syntactically valid <c>.koi</c>, which is the foundation for
/// grammar-constrained <c>.koi</c> generation (issue #257).
///
/// <para>It covers the full surface the committed templates exercise — strategic declarations
/// (<c>contextmap</c> with every relation role, <c>acl</c> blocks, <c>import</c>/<c>module</c>,
/// <c>publishes</c>/<c>subscribes</c>), the tactical type declarations (<c>value</c>,
/// <c>quantity</c>, <c>entity</c> with state machines/commands/factories, <c>aggregate</c> with
/// repositories, <c>enum</c> with associated data, domain and integration <c>event</c>s),
/// behavioural declarations (<c>spec</c>, <c>service</c> operations/use cases, <c>policy</c>,
/// <c>readmodel</c>, <c>query</c>), annotations, and the precedence-climbing expression
/// sublanguage. It is still a recogniser-grade projection, not a semantic checker: it cannot
/// enforce name resolution or type rules, only syntactic shape. The Task-2 round-trip guard
/// (<c>R17GbnfExportTests</c>) proves it accepts every committed template and rejects malformed
/// input.</para>
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
        // A program is one or more bounded contexts and/or a strategic context map (R14.1).
        ("root", "ws program-member (ws program-member)* ws"),
        ("program-member", "context | contextmap"),
        ("context", "\"context\" ws ident ws (\"version\" ws int ws)? \"{\" ws (context-member ws)* \"}\""),
        ("context-member", "import-decl | module-decl | type-decl | spec-decl | service-decl | policy-decl | readmodel-decl | query-decl | publish-decl | subscribe-decl"),

        // ---- Context map & integration wiring (R14) -----------------------
        ("contextmap", "\"contextmap\" ws \"{\" ws (relation ws)* \"}\""),
        ("relation", "type-name ws relation-arrow ws type-name ws \":\" ws relation-role (ws shared-kernel-block | ws acl-block)?"),
        ("relation-arrow", "\"<->\" | \"->\""),
        ("relation-role", "\"partnership\" | \"shared-kernel\" | \"customer-supplier\" | \"conformist\" | \"anti-corruption-layer\" | \"open-host\" | \"published-language\""),
        ("shared-kernel-block", "\"{\" ws type-name (ws \",\" ws type-name)* (ws \",\")? ws \"}\""),
        ("acl-block", "\"acl\" ws \"{\" ws (acl-mapping ws)+ \"}\""),
        ("acl-mapping", "qualified-type ws \"->\" ws qualified-type"),
        ("qualified-type", "type-name \".\" type-name"),

        // ---- Imports, modules, publish/subscribe (R13/R14.3) --------------
        ("import-decl", "\"import\" ws type-name \".\" ws (\"{\" ws type-name (ws \",\" ws type-name)* ws \"}\" | \"*\")"),
        ("module-decl", "\"module\" ws ident ws \"{\" ws (module-member ws)* \"}\""),
        ("module-member", "type-decl | module-decl"),
        ("publish-decl", "\"publishes\" ws type-name"),
        ("subscribe-decl", "\"subscribes\" ws type-name \".\" type-name"),

        // ---- Type declarations --------------------------------------------
        ("type-decl", "value-decl | quantity-decl | entity-decl | aggregate-decl | enum-decl | event-decl | integration-event-decl"),
        ("value-decl", "(annotation ws)* \"value\" ws ident ws \"{\" ws (member ws)* (invariant ws)* \"}\""),
        ("quantity-decl", "(annotation ws)* \"quantity\" ws ident ws \"{\" ws (member ws)* (invariant ws)* \"}\""),
        ("event-decl", "(annotation ws)* \"event\" ws ident ws \"{\" ws (member ws)* \"}\""),
        ("integration-event-decl", "(annotation ws)* \"integration\" ws \"event\" ws ident ws \"{\" ws (member ws)* \"}\""),
        ("enum-decl", "(annotation ws)* \"enum\" ws ident ws (\"(\" ws param-list? ws \")\" ws)? \"{\" ws enum-member (ws \",\"? ws enum-member)* (ws \",\")? ws \"}\""),
        ("enum-member", "ident (ws \"(\" ws (expression (ws \",\" ws expression)*)? ws \")\")?"),
        ("entity-decl", "(annotation ws)* \"entity\" ws ident ws \"identified\" ws \"by\" ws ident (ws identity-strategy)? ws \"{\" ws (member ws)* (invariant ws)* (states-decl ws)* (command-decl ws)* (factory-decl ws)* \"}\""),
        ("identity-strategy", "\"as\" ws (\"guid\" | \"sequence\" | \"natural\" ws \"(\" ws type-name ws \")\")"),
        ("aggregate-decl", "(annotation ws)* \"aggregate\" ws ident ws \"root\" ws ident (ws \"versioned\")? ws \"{\" ws (aggregate-member ws)* \"}\""),
        ("aggregate-member", "type-decl | spec-decl | repository-decl"),

        // ---- Repositories (R11.3) -----------------------------------------
        ("repository-decl", "\"repository\" ws \"{\" ws (operations-clause ws)? (finder-decl ws)* \"}\""),
        ("operations-clause", "\"operations\" ws \":\" ws ident (ws \",\" ws ident)*"),
        ("finder-decl", "\"find\" ws ident ws \"(\" ws param-list? ws \")\" ws \":\" ws type-ref"),

        // ---- State machine, commands, factories ---------------------------
        ("states-decl", "\"states\" ws soft-name ws \"{\" ws (state-rule ws)* \"}\""),
        ("state-rule", "ident (ws \"->\" ws ident (ws \",\" ws ident)*)? (ws \"when\" ws expression)?"),
        ("command-decl", "\"command\" ws ident (ws \"(\" ws param-list? ws \")\")? (ws \":\" ws type-ref)? ws \"{\" ws (command-stmt ws)* \"}\""),
        ("command-stmt", "requires-clause | result-clause | transition | emit-clause"),
        ("requires-clause", "\"requires\" ws expression (ws string)?"),
        ("result-clause", "\"result\" ws expression"),
        ("transition", "soft-name ws \"->\" ws expression"),
        ("emit-clause", "\"emit\" ws ident (ws \"(\" ws emit-arg-list? ws \")\")?"),
        ("emit-arg-list", "emit-arg (ws \",\" ws emit-arg)*"),
        ("emit-arg", "soft-name ws \":\" ws expression"),
        ("factory-decl", "\"create\" ws ident (ws \"(\" ws param-list? ws \")\")? ws \"{\" ws (factory-stmt ws)* \"}\""),
        ("factory-stmt", "requires-clause | initialization | emit-clause"),
        ("initialization", "soft-name ws \"->\" ws expression"),

        // ---- Specs, services, policies, read models, queries --------------
        ("spec-decl", "\"spec\" ws ident ws \"on\" ws type-name ws \"=\" ws expression"),
        ("service-decl", "\"service\" ws ident ws \"{\" ws (service-member ws)* \"}\""),
        ("service-member", "operation-decl | usecase-decl"),
        ("operation-decl", "\"operation\" ws ident ws \"(\" ws param-list? ws \")\" ws \":\" ws type-ref (ws \"=\" ws expression)?"),
        ("usecase-decl", "\"usecase\" ws ident ws \"(\" ws param-list? ws \")\" (ws \":\" ws type-ref)?"),
        ("policy-decl", "\"policy\" ws ident ws \"when\" ws ident ws \"then\" ws policy-reaction"),
        ("policy-reaction", "type-name \".\" soft-name (ws \"(\" ws policy-arg-list? ws \")\")?"),
        ("policy-arg-list", "policy-arg (ws \",\" ws policy-arg)*"),
        ("policy-arg", "soft-name ws \":\" ws expression"),
        ("readmodel-decl", "\"readmodel\" ws ident ws \"from\" ws type-name ws \"{\" ws (readmodel-field ws)* \"}\""),
        ("readmodel-field", "soft-name (ws \":\" ws type-ref ws \"=\" ws expression)?"),
        ("query-decl", "\"query\" ws ident ws \"(\" ws param-list? ws \")\" ws \":\" ws type-ref"),

        // ---- Members, params, types, invariants, annotations --------------
        ("member", "(annotation ws)* soft-name ws \":\" ws type-ref (ws \"=\" ws expression)?"),
        ("param-list", "param (ws \",\" ws param)*"),
        ("param", "soft-name ws \":\" ws type-ref"),
        ("type-ref", "(type-name \".\")? type-name (ws \"<\" ws type-ref (ws \",\" ws type-ref)? ws \">\")? \"?\"?"),
        ("invariant", "\"invariant\" ws expression (ws string)?"),
        ("annotation", "\"@\" ident (ws \"(\" ws (int | string) ws \")\")?"),

        // ---- Names & soft keywords (mirrors KoineParser.g4 softName) -------
        ("soft-name", "ident | decl-keyword | \"when\" | \"if\" | \"then\" | \"else\""),
        ("type-name", "ident | decl-keyword"),
        ("expr-name", "ident | decl-keyword | \"when\""),
        ("decl-keyword", "\"context\" | \"value\" | \"quantity\" | \"entity\" | \"aggregate\" | \"enum\" | \"identified\" | \"by\" | \"root\" | \"command\" | \"requires\" | \"result\" | \"event\" | \"emit\" | \"states\" | \"create\" | \"spec\" | \"on\" | \"service\" | \"operation\" | \"policy\" | \"as\" | \"natural\" | \"sequence\" | \"guid\" | \"versioned\" | \"repository\" | \"operations\" | \"find\" | \"usecase\" | \"readmodel\" | \"from\" | \"query\" | \"import\" | \"module\" | \"acl\" | \"integration\" | \"publishes\" | \"subscribes\" | \"version\" | \"let\" | \"in\""),

        // ---- Expression sublanguage (precedence-climbing) -----------------
        // Mirrors KoineParser.g4: lowest precedence (let / when-guard) climbs to the
        // highest (postfix/primary). `matches /regex/` is one regex token (lexer mode).
        ("expression", "let-expr"),
        ("let-expr", "\"let\" ws let-binding (ws \",\" ws let-binding)* ws \"in\" ws let-expr | guard-expr"),
        ("let-binding", "soft-name ws \"=\" ws expression"),
        ("guard-expr", "cond-expr (ws \"when\" ws cond-expr)?"),
        ("cond-expr", "\"if\" ws cond-expr ws \"then\" ws cond-expr ws \"else\" ws cond-expr | coalesce-expr"),
        ("coalesce-expr", "or-expr (ws \"??\" ws or-expr)*"),
        ("or-expr", "and-expr (ws \"||\" ws and-expr)*"),
        ("and-expr", "equality-expr (ws \"&&\" ws equality-expr)*"),
        ("equality-expr", "relational-expr (ws (\"==\" | \"!=\") ws relational-expr)*"),
        ("relational-expr", "match-expr (ws (\"<=\" | \">=\" | \"<\" | \">\") ws match-expr)*"),
        ("match-expr", "additive-expr (ws \"matches\" ws regex)?"),
        ("additive-expr", "multiplicative-expr (ws (\"+\" | \"-\") ws multiplicative-expr)*"),
        ("multiplicative-expr", "unary-expr (ws (\"*\" | \"/\") ws unary-expr)*"),
        ("unary-expr", "(\"!\" | \"-\") ws unary-expr | postfix-expr"),
        ("postfix-expr", "primary (ws \".\" ws soft-name (ws \"(\" ws arg-list? ws \")\")?)*"),
        ("arg-list", "argument (ws \",\" ws argument)*"),
        ("argument", "lambda | expression"),
        ("lambda", "soft-name ws \"=>\" ws expression"),
        ("primary", "literal | expr-name | \"(\" ws expression ws \")\""),
        ("literal", "decimal | int | string | bool"),

        // ---- Terminals (mirroring KoineLexer.g4) --------------------------
        ("ident", "[a-zA-Z_] [a-zA-Z0-9_]*"),
        ("int", "[0-9]+"),
        ("decimal", "[0-9]+ \".\" [0-9]+"),
        ("bool", "\"true\" | \"false\""),
        ("string", "[\"] ([^\"\\\\] | [\\\\] .)* [\"]"),
        // The regex literal: opened and closed by `/`, one token (lexer REGEX_MODE). The body excludes
        // `\r`/`\n` to mirror the lexer's `Regex : '/' ( ~[/\r\n\\] | '\\' . )* '/'` — a regex literal
        // is single-line, so the GBNF must not over-generate multi-line ones.
        ("regex", "[/] ([^/\\r\\n\\\\] | [\\\\] .)* [/]"),
        ("ws", "[ \\t\\r\\n]*"),
    };

    /// <summary>The projected GBNF, built once: <see cref="Rules"/> is a compile-time-constant table,
    /// so the output never differs between calls — cache it rather than re-concatenating per call.</summary>
    private static readonly string Cached = Build();

    /// <summary>
    /// Projects the pragmatic Koine grammar subset to a self-contained GBNF string.
    /// </summary>
    /// <returns>A syntactically valid, deterministic GBNF grammar with a <c>root</c> rule.</returns>
    public static string Export() => Cached;

    private static string Build()
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
