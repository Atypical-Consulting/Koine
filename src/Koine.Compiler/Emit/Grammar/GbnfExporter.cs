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
    /// Whitespace is threaded explicitly because GBNF has no implicit inter-token whitespace:
    /// <list type="bullet">
    /// <item><c>ws</c> — zero-or-more whitespace characters; used where a punctuation token
    /// already forces a token boundary (e.g. after <c>{</c> or before <c>}</c>).</item>
    /// <item><c>req_ws</c> — one-or-more whitespace characters; used at every word-to-word
    /// boundary (keyword→identifier, identifier→keyword, keyword→keyword), so the
    /// grammar-constrained decoder cannot produce token-merged output such as
    /// <c>contextFoo</c> that the real ANTLR lexer would tokenise as a single identifier.</item>
    /// </list>
    /// The <c>matches /regex/</c> form mirrors the lexer's REGEX_MODE: the regex literal
    /// is ONE <c>regex</c> token, not two <c>/</c> division operators.
    /// </summary>
    private static readonly (string Name, string Body)[] Rules =
    {
        // ---- Top level -----------------------------------------------------
        // A program is one or more bounded contexts and/or a strategic context map (R14.1).
        ("root", "ws program-member (ws program-member)* ws"),
        ("program-member", "context | contextmap"),
        // req_ws between keyword "context" and the identifier name (word→word boundary).
        // The optional "version" block uses req_ws before "version" (ident→keyword word→word boundary),
        // and req_ws before int (keyword→int word→word boundary). ws before "{" covers both the
        // no-version case (ident→"{") and the with-version case (int→"{"), both of which are
        // word→punct and do not require a mandatory space.
        ("context", "\"context\" req_ws ident (req_ws \"version\" req_ws int)? ws \"{\" ws (context-member ws)* \"}\""),
        ("context-member", "import-decl | module-decl | type-decl | spec-decl | service-decl | policy-decl | readmodel-decl | query-decl | publish-decl | subscribe-decl"),

        // ---- Context map & integration wiring (R14) -----------------------
        ("contextmap", "\"contextmap\" ws \"{\" ws (relation ws)* \"}\""),
        // relation-role ends with a keyword; acl-block starts with keyword "acl" (word→word → req_ws);
        // shared-kernel-block starts with "{" (punct, word→punct → ws is sufficient).
        ("relation", "type-name ws relation-arrow ws type-name ws \":\" ws relation-role (ws shared-kernel-block | req_ws acl-block)?"),
        ("relation-arrow", "\"<->\" | \"->\""),
        ("relation-role", "\"partnership\" | \"shared-kernel\" | \"customer-supplier\" | \"conformist\" | \"anti-corruption-layer\" | \"open-host\" | \"published-language\""),
        ("shared-kernel-block", "\"{\" ws type-name (ws \",\" ws type-name)* (ws \",\")? ws \"}\""),
        ("acl-block", "\"acl\" ws \"{\" ws (acl-mapping ws)+ \"}\""),
        ("acl-mapping", "qualified-type ws \"->\" ws qualified-type"),
        ("qualified-type", "type-name \".\" type-name"),

        // ---- Imports, modules, publish/subscribe (R13/R14.3) --------------
        ("import-decl", "\"import\" req_ws type-name \".\" ws (\"{\" ws type-name (ws \",\" ws type-name)* ws \"}\" | \"*\")"),
        ("module-decl", "\"module\" req_ws ident ws \"{\" ws (module-member ws)* \"}\""),
        ("module-member", "type-decl | module-decl"),
        ("publish-decl", "\"publishes\" req_ws type-name"),
        ("subscribe-decl", "\"subscribes\" req_ws type-name \".\" type-name"),

        // ---- Type declarations --------------------------------------------
        ("type-decl", "value-decl | quantity-decl | entity-decl | aggregate-decl | enum-decl | event-decl | integration-event-decl"),
        // (annotation req_ws)* means each annotation must be followed by at least one whitespace
        // before the next token (annotation or keyword) — always true in valid Koine source.
        ("value-decl", "(annotation req_ws)* \"value\" req_ws ident ws \"{\" ws (member ws)* (invariant ws)* \"}\""),
        ("quantity-decl", "(annotation req_ws)* \"quantity\" req_ws ident ws \"{\" ws (member ws)* (invariant ws)* \"}\""),
        ("event-decl", "(annotation req_ws)* \"event\" req_ws ident ws \"{\" ws (member ws)* \"}\""),
        // "integration" req_ws "event": keyword→keyword boundary.
        ("integration-event-decl", "(annotation req_ws)* \"integration\" req_ws \"event\" req_ws ident ws \"{\" ws (member ws)* \"}\""),
        ("enum-decl", "(annotation req_ws)* \"enum\" req_ws ident ws (\"(\" ws param-list? ws \")\" ws)? \"{\" ws enum-member (ws \",\"? ws enum-member)* (ws \",\")? ws \"}\""),
        ("enum-member", "ident (ws \"(\" ws (expression (ws \",\" ws expression)*)? ws \")\")?"),
        // Multiple word→word boundaries: entity→ident, ident→identified, identified→by, by→ident.
        // (req_ws identity-strategy)?: when the optional block appears, ident→"as" is word→word.
        ("entity-decl", "(annotation req_ws)* \"entity\" req_ws ident req_ws \"identified\" req_ws \"by\" req_ws ident (req_ws identity-strategy)? ws \"{\" ws (member ws)* (invariant ws)* (states-decl ws)* (command-decl ws)* (factory-decl ws)* \"}\""),
        ("identity-strategy", "\"as\" req_ws (\"guid\" | \"sequence\" | \"natural\" ws \"(\" ws type-name ws \")\")"),
        // aggregate→ident→root→ident; (req_ws "versioned")?: ident→"versioned" is word→word.
        ("aggregate-decl", "(annotation req_ws)* \"aggregate\" req_ws ident req_ws \"root\" req_ws ident (req_ws \"versioned\")? ws \"{\" ws (aggregate-member ws)* \"}\""),
        ("aggregate-member", "type-decl | spec-decl | repository-decl"),

        // ---- Repositories (R11.3) -----------------------------------------
        ("repository-decl", "\"repository\" ws \"{\" ws (operations-clause ws)? (finder-decl ws)* \"}\""),
        ("operations-clause", "\"operations\" ws \":\" ws ident (ws \",\" ws ident)*"),
        ("finder-decl", "\"find\" req_ws ident ws \"(\" ws param-list? ws \")\" ws \":\" ws type-ref"),

        // ---- State machine, commands, factories ---------------------------
        ("states-decl", "\"states\" req_ws soft-name ws \"{\" ws (state-rule ws)* \"}\""),
        // (req_ws "when" req_ws expression)?: when present, ident→"when"→expression is word→word.
        ("state-rule", "ident (ws \"->\" ws ident (ws \",\" ws ident)*)? (req_ws \"when\" req_ws expression)?"),
        ("command-decl", "\"command\" req_ws ident (ws \"(\" ws param-list? ws \")\")? (ws \":\" ws type-ref)? ws \"{\" ws (command-stmt ws)* \"}\""),
        ("command-stmt", "requires-clause | result-clause | transition | emit-clause"),
        ("requires-clause", "\"requires\" req_ws expression (ws string)?"),
        ("result-clause", "\"result\" req_ws expression"),
        ("transition", "soft-name ws \"->\" ws expression"),
        ("emit-clause", "\"emit\" req_ws ident (ws \"(\" ws emit-arg-list? ws \")\")?"),
        ("emit-arg-list", "emit-arg (ws \",\" ws emit-arg)*"),
        ("emit-arg", "soft-name ws \":\" ws expression"),
        ("factory-decl", "\"create\" req_ws ident (ws \"(\" ws param-list? ws \")\")? ws \"{\" ws (factory-stmt ws)* \"}\""),
        ("factory-stmt", "requires-clause | initialization | emit-clause"),
        ("initialization", "soft-name ws \"->\" ws expression"),

        // ---- Specs, services, policies, read models, queries --------------
        // spec→ident→on→type-name: all word→word boundaries.
        ("spec-decl", "\"spec\" req_ws ident req_ws \"on\" req_ws type-name ws \"=\" ws expression"),
        ("service-decl", "\"service\" req_ws ident ws \"{\" ws (service-member ws)* \"}\""),
        ("service-member", "operation-decl | usecase-decl"),
        ("operation-decl", "\"operation\" req_ws ident ws \"(\" ws param-list? ws \")\" ws \":\" ws type-ref (ws \"=\" ws expression)?"),
        ("usecase-decl", "\"usecase\" req_ws ident ws \"(\" ws param-list? ws \")\" (ws \":\" ws type-ref)?"),
        // policy→ident→when→ident→then→policy-reaction: every position is word→word.
        ("policy-decl", "\"policy\" req_ws ident req_ws \"when\" req_ws ident req_ws \"then\" req_ws policy-reaction"),
        ("policy-reaction", "type-name \".\" soft-name (ws \"(\" ws policy-arg-list? ws \")\")?"),
        ("policy-arg-list", "policy-arg (ws \",\" ws policy-arg)*"),
        ("policy-arg", "soft-name ws \":\" ws expression"),
        // readmodel→ident→from→type-name: word→word boundaries.
        ("readmodel-decl", "\"readmodel\" req_ws ident req_ws \"from\" req_ws type-name ws \"{\" ws (readmodel-field ws)* \"}\""),
        ("readmodel-field", "soft-name (ws \":\" ws type-ref ws \"=\" ws expression)?"),
        ("query-decl", "\"query\" req_ws ident ws \"(\" ws param-list? ws \")\" ws \":\" ws type-ref"),

        // ---- Members, params, types, invariants, annotations --------------
        ("member", "(annotation req_ws)* soft-name ws \":\" ws type-ref (ws \"=\" ws expression)?"),
        ("param-list", "param (ws \",\" ws param)*"),
        ("param", "soft-name ws \":\" ws type-ref"),
        ("type-ref", "(type-name \".\")? type-name (ws \"<\" ws type-ref (ws \",\" ws type-ref)? ws \">\")? \"?\"?"),
        ("invariant", "\"invariant\" req_ws expression (ws string)?"),
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
        // "let"→let-binding (starts with soft-name, word→word); "in"→let-expr (word→word).
        // req_ws before "in": the last let-binding ends with an expression (can end with word).
        ("let-expr", "\"let\" req_ws let-binding (ws \",\" ws let-binding)* req_ws \"in\" req_ws let-expr | guard-expr"),
        ("let-binding", "soft-name ws \"=\" ws expression"),
        // (req_ws "when" req_ws cond-expr)?: cond-expr can end with word; "when"→cond-expr is word→word.
        ("guard-expr", "cond-expr (req_ws \"when\" req_ws cond-expr)?"),
        // "if"→cond-expr→"then"→cond-expr→"else"→cond-expr: all word→word.
        ("cond-expr", "\"if\" req_ws cond-expr req_ws \"then\" req_ws cond-expr req_ws \"else\" req_ws cond-expr | coalesce-expr"),
        ("coalesce-expr", "or-expr (ws \"??\" ws or-expr)*"),
        ("or-expr", "and-expr (ws \"||\" ws and-expr)*"),
        ("and-expr", "equality-expr (ws \"&&\" ws equality-expr)*"),
        ("equality-expr", "relational-expr (ws (\"==\" | \"!=\") ws relational-expr)*"),
        ("relational-expr", "match-expr (ws (\"<=\" | \">=\" | \"<\" | \">\") ws match-expr)*"),
        // (req_ws "matches" ws regex)?: additive-expr can end with word; "matches" is a keyword.
        ("match-expr", "additive-expr (req_ws \"matches\" ws regex)?"),
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
        // Required whitespace: one or more characters. Used at word-to-word boundaries so the
        // grammar-constrained decoder cannot merge adjacent word tokens into one identifier.
        ("req_ws", "[ \\t\\r\\n]+"),
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
        sb.Append("# `ws` = optional whitespace; `req_ws` = required whitespace at word-to-word boundaries.\n");
        sb.Append("# `matches /regex/` is one regex token (lexer REGEX_MODE).\n");
        sb.Append('\n');

        foreach ((string name, string body) in Rules)
        {
            sb.Append(name).Append(" ::= ").Append(body).Append('\n');
        }

        return sb.ToString();
    }
}
