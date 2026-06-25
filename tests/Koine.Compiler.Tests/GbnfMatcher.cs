using System.Text;

namespace Koine.Compiler.Tests;

/// <summary>
/// A small, test-only recogniser for the GBNF that <c>GbnfExporter.Export()</c> produces, used by
/// <see cref="R17GbnfExportTests"/> to prove the grammar genuinely accepts the committed templates
/// (and rejects malformed input) — not merely that it mentions the right keywords.
///
/// <para><b>How it works.</b> The exported GBNF is char-level (string literals, char classes,
/// whitespace threaded through <c>ws</c>). Rather than re-derive the lexer's maximal-munch and
/// comment/whitespace handling inside the recogniser, the input is first run through
/// <see cref="KoineTokenizer"/> — the same lexer/parser split the real compiler uses (whitespace and
/// comments ride hidden channels; the parser sees only a token stream). The GBNF is then matched
/// over that token stream where:
/// <list type="bullet">
/// <item><description>a quoted GBNF literal <c>"x"</c> matches one keyword/operator/punctuation token
/// whose text is exactly <c>x</c>;</description></item>
/// <item><description>the terminal rules <c>ident</c>/<c>int</c>/<c>decimal</c>/<c>string</c>/<c>regex</c>
/// match one token of the corresponding lexer kind;</description></item>
/// <item><description><c>ws</c> matches the empty token sequence (inter-token whitespace is already
/// gone), so the GBNF's explicit whitespace threading is a no-op here.</description></item>
/// </list>
/// Acceptance = some derivation of <c>root</c> consumes the <em>entire</em> token stream.</para>
///
/// <para>The recogniser is a memoised, set-of-end-positions matcher (it tracks every position a rule
/// can end at, so grammar ambiguity is handled correctly without backtracking pitfalls). The exported
/// grammar has no left recursion, so memoisation terminates; an in-progress guard defends against any
/// accidental cycle.</para>
/// </summary>
internal static class GbnfMatcher
{
    /// <summary>True when some derivation of <c>root</c> consumes the whole tokenised input.</summary>
    public static bool Accepts(string gbnf, string source)
    {
        var grammar = GbnfGrammar.Parse(gbnf);
        var tokens = KoineTokenizer.Tokenize(source);
        if (tokens is null)
        {
            // The tokenizer hit a character no Koine token can start with — definitively not in
            // the language (e.g. a foreign symbol injected into a garbage variant).
            return false;
        }

        var run = new Run(grammar, tokens);
        return run.Match(new Ref("root"), 0).Contains(tokens.Count);
    }

    /// <summary>One recognition pass over a fixed token list, carrying the per-pass memo table.</summary>
    private sealed class Run
    {
        private readonly GbnfGrammar _grammar;
        private readonly IReadOnlyList<KoineToken> _tokens;
        private readonly Dictionary<(string, int), HashSet<int>> _memo = new();
        private readonly HashSet<(string, int)> _inProgress = new();

        public Run(GbnfGrammar grammar, IReadOnlyList<KoineToken> tokens)
        {
            _grammar = grammar;
            _tokens = tokens;
        }

        /// <summary>The set of token indices at which <paramref name="node"/> can finish from <paramref name="pos"/>.</summary>
        public HashSet<int> Match(Node node, int pos)
        {
            switch (node)
            {
                case Lit lit:
                    return pos < _tokens.Count && _tokens[pos].Kind == TokenKind.Exact && _tokens[pos].Text == lit.Text
                        ? new HashSet<int> { pos + 1 }
                        : new HashSet<int>();

                case Ref r:
                    return MatchRef(r.Name, pos);

                case Seq seq:
                    {
                        var cur = new HashSet<int> { pos };
                        foreach (Node item in seq.Items)
                        {
                            var next = new HashSet<int>();
                            foreach (int p in cur)
                            {
                                next.UnionWith(Match(item, p));
                            }

                            cur = next;
                            if (cur.Count == 0)
                            {
                                break;
                            }
                        }

                        return cur;
                    }

                case Alt alt:
                    {
                        var res = new HashSet<int>();
                        foreach (Node item in alt.Items)
                        {
                            res.UnionWith(Match(item, pos));
                        }

                        return res;
                    }

                case Opt opt:
                    {
                        var res = new HashSet<int> { pos };
                        res.UnionWith(Match(opt.Item, pos));
                        return res;
                    }

                case Star star:
                    return Closure(star.Item, new HashSet<int> { pos });

                case Plus plus:
                    return Closure(plus.Item, Match(plus.Item, pos));

                default:
                    throw new InvalidOperationException($"unknown node {node.GetType().Name}");
            }
        }

        /// <summary>Reflexive-transitive reachable end positions from <paramref name="seed"/> by repeating <paramref name="item"/>.</summary>
        private HashSet<int> Closure(Node item, HashSet<int> seed)
        {
            var reach = new HashSet<int>(seed);
            var work = new Stack<int>(seed);
            while (work.Count > 0)
            {
                int p = work.Pop();
                foreach (int q in Match(item, p))
                {
                    if (reach.Add(q))
                    {
                        work.Push(q);
                    }
                }
            }

            return reach;
        }

        private HashSet<int> MatchRef(string name, int pos)
        {
            // The six lexer-terminal rules are matched by token kind, not by expanding their
            // char-class bodies; `ws` matches the empty sequence at any position.
            switch (name)
            {
                case "ws":
                    return new HashSet<int> { pos };
                case "ident":
                    return Terminal(pos, TokenKind.Identifier);
                case "int":
                    return Terminal(pos, TokenKind.Int);
                case "decimal":
                    return Terminal(pos, TokenKind.Decimal);
                case "string":
                    return Terminal(pos, TokenKind.String);
                case "regex":
                    return Terminal(pos, TokenKind.Regex);
            }

            var key = (name, pos);
            if (_memo.TryGetValue(key, out HashSet<int>? cached))
            {
                return cached;
            }

            if (!_inProgress.Add(key))
            {
                // Re-entered the same (rule, position): treat as no-match to break any cycle.
                return new HashSet<int>();
            }

            HashSet<int> result = Match(_grammar.Rule(name), pos);
            _inProgress.Remove(key);
            _memo[key] = result;
            return result;
        }

        private HashSet<int> Terminal(int pos, TokenKind kind) =>
            pos < _tokens.Count && _tokens[pos].Kind == kind
                ? new HashSet<int> { pos + 1 }
                : new HashSet<int>();
    }

    // ---- GBNF grammar model + parser ----------------------------------------

    /// <summary>The parsed rule table of an exported GBNF string.</summary>
    private sealed class GbnfGrammar
    {
        /// <summary>Rule bodies parsed to an AST. The six char-class terminal rules are not stored
        /// (the recogniser handles them by token kind), so they never need char-class parsing.</summary>
        private readonly Dictionary<string, Node> _rules;

        private GbnfGrammar(Dictionary<string, Node> rules) => _rules = rules;

        public Node Rule(string name) =>
            _rules.TryGetValue(name, out Node? n)
                ? n
                : throw new InvalidOperationException($"GBNF references undefined rule '{name}'");

        private static readonly HashSet<string> CharClassTerminals =
            new() { "ident", "int", "decimal", "string", "regex", "ws" };

        public static GbnfGrammar Parse(string gbnf)
        {
            var rules = new Dictionary<string, Node>();
            foreach (string rawLine in gbnf.Split('\n'))
            {
                string line = rawLine.Trim();
                if (line.Length == 0 || line.StartsWith('#'))
                {
                    continue;
                }

                int arrow = line.IndexOf("::=", StringComparison.Ordinal);
                if (arrow < 0)
                {
                    continue;
                }

                string name = line[..arrow].Trim();
                string body = line[(arrow + 3)..].Trim();
                if (CharClassTerminals.Contains(name))
                {
                    continue; // handled as a kind-matched terminal by the recogniser
                }

                rules[name] = new BodyParser(body).ParseAlternation();
            }

            return new GbnfGrammar(rules);
        }
    }

    /// <summary>
    /// Recursive-descent parser for a single (non-terminal) GBNF rule body. Only ever sees quoted
    /// literals, rule references, grouping <c>( )</c>, alternation <c>|</c>, and the postfix
    /// quantifiers <c>* + ?</c> — char classes live solely in the six terminal rules, which the
    /// grammar parser skips.
    /// </summary>
    private sealed class BodyParser
    {
        private readonly List<Atom> _atoms;
        private int _i;

        public BodyParser(string body) => _atoms = Lex(body);

        public Node ParseAlternation()
        {
            var branches = new List<Node> { ParseSequence() };
            while (Peek() is { Kind: AtomKind.Pipe })
            {
                _i++;
                branches.Add(ParseSequence());
            }

            return branches.Count == 1 ? branches[0] : new Alt(branches.ToArray());
        }

        private Node ParseSequence()
        {
            var items = new List<Node>();
            while (Peek() is { } a && a.Kind is AtomKind.Literal or AtomKind.RuleRef or AtomKind.LParen)
            {
                items.Add(ParseTerm());
            }

            if (items.Count == 0)
            {
                throw new InvalidOperationException("empty GBNF sequence");
            }

            return items.Count == 1 ? items[0] : new Seq(items.ToArray());
        }

        private Node ParseTerm()
        {
            Node atom = ParseAtom();
            return Peek() switch
            {
                { Kind: AtomKind.Star } => Advance(new Star(atom)),
                { Kind: AtomKind.Plus } => Advance(new Plus(atom)),
                { Kind: AtomKind.Question } => Advance(new Opt(atom)),
                _ => atom,
            };
        }

        private Node Advance(Node n)
        {
            _i++;
            return n;
        }

        private Node ParseAtom()
        {
            Atom a = Peek() ?? throw new InvalidOperationException("unexpected end of GBNF body");
            switch (a.Kind)
            {
                case AtomKind.Literal:
                    _i++;
                    return new Lit(a.Text);
                case AtomKind.RuleRef:
                    _i++;
                    return new Ref(a.Text);
                case AtomKind.LParen:
                    _i++;
                    Node inner = ParseAlternation();
                    if (Peek() is not { Kind: AtomKind.RParen })
                    {
                        throw new InvalidOperationException("unbalanced '(' in GBNF body");
                    }

                    _i++;
                    return inner;
                default:
                    throw new InvalidOperationException($"unexpected atom '{a.Text}' in GBNF body");
            }
        }

        private Atom? Peek() => _i < _atoms.Count ? _atoms[_i] : null;

        private static List<Atom> Lex(string body)
        {
            var atoms = new List<Atom>();
            int i = 0;
            while (i < body.Length)
            {
                char c = body[i];
                if (char.IsWhiteSpace(c))
                {
                    i++;
                    continue;
                }

                switch (c)
                {
                    case '"':
                        {
                            int j = i + 1;
                            while (j < body.Length && body[j] != '"')
                            {
                                j++;
                            }

                            // Exported quoted literals never contain an escaped quote.
                            atoms.Add(new Atom(AtomKind.Literal, body.Substring(i + 1, j - i - 1)));
                            i = j + 1;
                            break;
                        }

                    case '(':
                        atoms.Add(new Atom(AtomKind.LParen, "("));
                        i++;
                        break;
                    case ')':
                        atoms.Add(new Atom(AtomKind.RParen, ")"));
                        i++;
                        break;
                    case '|':
                        atoms.Add(new Atom(AtomKind.Pipe, "|"));
                        i++;
                        break;
                    case '*':
                        atoms.Add(new Atom(AtomKind.Star, "*"));
                        i++;
                        break;
                    case '+':
                        atoms.Add(new Atom(AtomKind.Plus, "+"));
                        i++;
                        break;
                    case '?':
                        atoms.Add(new Atom(AtomKind.Question, "?"));
                        i++;
                        break;
                    default:
                        {
                            if (char.IsLetter(c) || c == '_')
                            {
                                int j = i;
                                while (j < body.Length && (char.IsLetterOrDigit(body[j]) || body[j] == '_' || body[j] == '-'))
                                {
                                    j++;
                                }

                                atoms.Add(new Atom(AtomKind.RuleRef, body.Substring(i, j - i)));
                                i = j;
                                break;
                            }

                            throw new InvalidOperationException($"unexpected character '{c}' in GBNF body: {body}");
                        }
                }
            }

            return atoms;
        }

        private enum AtomKind { Literal, RuleRef, LParen, RParen, Pipe, Star, Plus, Question }

        private readonly record struct Atom(AtomKind Kind, string Text);
    }

    // ---- Body AST ------------------------------------------------------------

    private abstract record Node;

    private sealed record Lit(string Text) : Node;

    private sealed record Ref(string Name) : Node;

    private sealed record Seq(Node[] Items) : Node;

    private sealed record Alt(Node[] Items) : Node;

    private sealed record Star(Node Item) : Node;

    private sealed record Plus(Node Item) : Node;

    private sealed record Opt(Node Item) : Node;
}
