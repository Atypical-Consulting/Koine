using System.Text;

namespace Koine.Compiler.Tests;

/// <summary>
/// A <em>character-level</em> recogniser for the exported GBNF, used by
/// <see cref="R17GbnfExportTests"/> to prove that the grammar cannot over-generate
/// token-merged output.
///
/// <para>Unlike <see cref="GbnfMatcher"/>, which operates over a pre-tokenised stream (whitespace
/// already stripped), this engine matches directly against the raw source characters.  Whitespace
/// rules like <c>ws ::= [ \t\r\n]*</c> and (after the fix) <c>req_ws ::= [ \t\r\n]+</c> therefore
/// actually consume characters from the input, making word-to-word token merges observable and
/// rejectable.  A rule body like <c>"context" req_ws ident</c> requires at least one whitespace
/// character between the keyword and the identifier, so <c>contextFoo</c> is rejected — exactly
/// the property the token-based <see cref="GbnfMatcher"/> cannot see.</para>
///
/// <para>The engine is a memoised position-set matcher (same architecture as <see cref="GbnfMatcher"/>)
/// that works over character positions rather than token indices.  The GBNF body parser has been
/// extended to handle character-class rules (<c>[a-z]</c>, <c>[^"\\]</c>, <c>.</c>) that the
/// token-based matcher handled implicitly via token-kind dispatch.</para>
/// </summary>
internal static class GbnfCharMatcher
{
    private const int MaxDepth = 800;

    /// <summary>
    /// <c>true</c> when some derivation of <c>root</c> from the exported <paramref name="gbnf"/>
    /// covers the entire raw <paramref name="source"/> string.
    /// </summary>
    public static bool Accepts(string gbnf, string source)
    {
        CharGrammar grammar;
        try { grammar = CharGrammar.Parse(gbnf); }
        catch { return false; }

        var run = new CharRun(grammar, source);
        try
        {
            return run.Match(new CRef("root"), 0, 0).Contains(source.Length);
        }
        catch (DepthExceededException)
        {
            return false;
        }
    }

    // ---- Exception to unwind a depth-exceeded match -----------------------

    /// <summary>Raised when the recursion depth exceeds <see cref="MaxDepth"/>; unwound by
    /// <see cref="Accepts"/> so the caller gets a clean <c>false</c> rather than a crash.</summary>
    private sealed class DepthExceededException : Exception { }

    // ---- Recognition run ---------------------------------------------------

    private sealed class CharRun
    {
        private readonly CharGrammar _grammar;
        private readonly string _src;
        private readonly Dictionary<(string, int), HashSet<int>> _memo = new();
        private readonly HashSet<(string, int)> _inProgress = new();

        public CharRun(CharGrammar grammar, string src) { _grammar = grammar; _src = src; }

        /// <summary>The set of character positions at which <paramref name="node"/> can end starting from
        /// <paramref name="pos"/>.</summary>
        public HashSet<int> Match(CNode node, int pos, int depth)
        {
            if (depth > MaxDepth)
            {
                throw new DepthExceededException();
            }

            switch (node)
            {
                case CLit lit:
                    {
                        string v = lit.Value;
                        if (v.Length == 0)
                        {
                            return [pos]; // epsilon
                        }

                        if (pos + v.Length <= _src.Length &&
                            _src.AsSpan(pos, v.Length).Equals(v.AsSpan(), StringComparison.Ordinal))
                        {
                            return [pos + v.Length];
                        }

                        return [];
                    }

                case CCharClass cc:
                    return pos < _src.Length && cc.Matches(_src[pos]) ? [pos + 1] : [];

                case CAny:
                    return pos < _src.Length ? [pos + 1] : [];

                case CRef r:
                    return MatchRef(r.Name, pos, depth);

                case CSeq seq:
                    {
                        HashSet<int> cur = [pos];
                        foreach (CNode item in seq.Items)
                        {
                            HashSet<int> next = [];
                            foreach (int p in cur)
                            {
                                next.UnionWith(Match(item, p, depth + 1));
                            }

                            cur = next;
                            if (cur.Count == 0)
                            {
                                break;
                            }
                        }
                        return cur;
                    }

                case CAlt alt:
                    {
                        HashSet<int> res = [];
                        foreach (CNode item in alt.Items)
                        {
                            res.UnionWith(Match(item, pos, depth + 1));
                        }

                        return res;
                    }

                case COpt opt:
                    {
                        HashSet<int> res = [pos];
                        res.UnionWith(Match(opt.Item, pos, depth + 1));
                        return res;
                    }

                case CStar star:
                    return Closure(star.Item, [pos], depth);

                case CPlus plus:
                    return Closure(plus.Item, Match(plus.Item, pos, depth + 1), depth);

                default:
                    throw new InvalidOperationException($"Unknown CNode type: {node.GetType().Name}");
            }
        }

        private HashSet<int> Closure(CNode item, HashSet<int> seed, int depth)
        {
            HashSet<int> reach = [.. seed];
            Stack<int> work = new(seed);
            while (work.Count > 0)
            {
                int p = work.Pop();
                foreach (int q in Match(item, p, depth + 1))
                {
                    if (reach.Add(q))
                    {
                        work.Push(q);
                    }
                }
            }
            return reach;
        }

        private HashSet<int> MatchRef(string name, int pos, int depth)
        {
            var key = (name, pos);
            if (_memo.TryGetValue(key, out HashSet<int>? cached))
            {
                return cached;
            }

            if (!_inProgress.Add(key))
            {
                return []; // cycle guard → no-match
            }

            HashSet<int> result = Match(_grammar.Rule(name), pos, depth + 1);
            _inProgress.Remove(key);
            _memo[key] = result;
            return result;
        }
    }

    // ---- Grammar model + parser --------------------------------------------

    /// <summary>The parsed rule table of an exported GBNF string.</summary>
    private sealed class CharGrammar
    {
        private readonly Dictionary<string, CNode> _rules;

        private CharGrammar(Dictionary<string, CNode> rules) => _rules = rules;

        public CNode Rule(string name) =>
            _rules.TryGetValue(name, out CNode? n) ? n :
            throw new InvalidOperationException($"GBNF references undefined rule '{name}'");

        public static CharGrammar Parse(string gbnf)
        {
            var rules = new Dictionary<string, CNode>();
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
                rules[name] = new CBodyParser(body).ParseAlternation();
            }
            return new CharGrammar(rules);
        }
    }

    /// <summary>
    /// Recursive-descent parser for a single GBNF rule body.  Handles all constructs that appear
    /// in the exported GBNF: quoted literals, rule references, character classes <c>[…]</c>,
    /// the any-char dot <c>.</c>, grouping <c>(…)</c>, alternation <c>|</c>, and the postfix
    /// quantifiers <c>* + ?</c>.
    /// </summary>
    private sealed class CBodyParser
    {
        private readonly string _body;
        private int _pos;

        public CBodyParser(string body) { _body = body; _pos = 0; }

        public CNode ParseAlternation()
        {
            var branches = new List<CNode> { ParseSequence() };
            SkipSpaces();
            while (_pos < _body.Length && _body[_pos] == '|')
            {
                _pos++; // consume '|'
                SkipSpaces();
                branches.Add(ParseSequence());
                SkipSpaces();
            }
            return branches.Count == 1 ? branches[0] : new CAlt([.. branches]);
        }

        private CNode ParseSequence()
        {
            var items = new List<CNode>();
            SkipSpaces();
            while (_pos < _body.Length && _body[_pos] != ')' && _body[_pos] != '|')
            {
                items.Add(ParseTerm());
                SkipSpaces();
            }
            // Empty sequence = epsilon.
            if (items.Count == 0)
            {
                return new CLit("");
            }

            return items.Count == 1 ? items[0] : new CSeq([.. items]);
        }

        private CNode ParseTerm()
        {
            CNode atom = ParseAtom();
            SkipSpaces();
            if (_pos < _body.Length)
            {
                switch (_body[_pos])
                {
                    case '*': _pos++; return new CStar(atom);
                    case '+': _pos++; return new CPlus(atom);
                    case '?': _pos++; return new COpt(atom);
                }
            }
            return atom;
        }

        private CNode ParseAtom()
        {
            SkipSpaces();
            if (_pos >= _body.Length)
            {
                throw new InvalidOperationException("Unexpected end of GBNF body");
            }

            char c = _body[_pos];
            switch (c)
            {
                case '"':
                    return ParseLiteral();
                case '[':
                    return ParseCharClass();
                case '(':
                    return ParseGroup();
                case '.':
                    _pos++;
                    return new CAny();
                default:
                    if (char.IsLetter(c) || c == '_')
                    {
                        return ParseRuleRef();
                    }

                    throw new InvalidOperationException(
                        $"Unexpected character '{c}' (U+{(int)c:X4}) in GBNF body at pos {_pos}: {_body}");
            }
        }

        private CLit ParseLiteral()
        {
            _pos++; // opening "
            var sb = new StringBuilder();
            while (_pos < _body.Length && _body[_pos] != '"')
            {
                if (_body[_pos] == '\\' && _pos + 1 < _body.Length)
                {
                    _pos++;
                    sb.Append(Unescape(_body[_pos]));
                }
                else
                {
                    sb.Append(_body[_pos]);
                }
                _pos++;
            }
            if (_pos < _body.Length)
            {
                _pos++; // closing "
            }

            return new CLit(sb.ToString());
        }

        private CCharClass ParseCharClass()
        {
            _pos++; // '['
            bool negated = false;
            if (_pos < _body.Length && _body[_pos] == '^') { negated = true; _pos++; }

            var ranges = new List<(char First, char Last)>();
            while (_pos < _body.Length && _body[_pos] != ']')
            {
                char first = ParseClassChar();
                if (_pos < _body.Length && _body[_pos] == '-' &&
                    _pos + 1 < _body.Length && _body[_pos + 1] != ']')
                {
                    _pos++; // '-'
                    char last = ParseClassChar();
                    ranges.Add((first, last));
                }
                else
                {
                    ranges.Add((first, first));
                }
            }
            if (_pos < _body.Length)
            {
                _pos++; // ']'
            }

            return new CCharClass(negated, [.. ranges]);
        }

        private CNode ParseGroup()
        {
            _pos++; // '('
            SkipSpaces();
            CNode inner = ParseAlternation();
            SkipSpaces();
            if (_pos < _body.Length && _body[_pos] == ')')
            {
                _pos++;
            }

            return inner;
        }

        private CRef ParseRuleRef()
        {
            int start = _pos;
            while (_pos < _body.Length &&
                   (char.IsLetterOrDigit(_body[_pos]) || _body[_pos] == '-' || _body[_pos] == '_'))
            {
                _pos++;
            }

            return new CRef(_body[start.._pos]);
        }

        private char ParseClassChar()
        {
            if (_body[_pos] == '\\' && _pos + 1 < _body.Length)
            {
                _pos++;
                char escaped = _body[_pos];
                _pos++;
                return Unescape(escaped);
            }
            return _body[_pos++];
        }

        private static char Unescape(char c) => c switch
        {
            't' => '\t',
            'r' => '\r',
            'n' => '\n',
            '"' => '"',
            '\\' => '\\',
            '/' => '/',
            _ => c,
        };

        private void SkipSpaces()
        {
            while (_pos < _body.Length && _body[_pos] == ' ')
            {
                _pos++;
            }
        }
    }

    // ---- AST nodes ---------------------------------------------------------

    private abstract record CNode;
    private sealed record CLit(string Value) : CNode;
    private sealed record CCharClass(bool Negated, (char First, char Last)[] Ranges) : CNode
    {
        public bool Matches(char c)
        {
            bool inSet = Ranges.Any(r => c >= r.First && c <= r.Last);
            return Negated ? !inSet : inSet;
        }
    }
    private sealed record CAny : CNode;
    private sealed record CRef(string Name) : CNode;
    private sealed record CSeq(CNode[] Items) : CNode;
    private sealed record CAlt(CNode[] Items) : CNode;
    private sealed record CStar(CNode Item) : CNode;
    private sealed record CPlus(CNode Item) : CNode;
    private sealed record COpt(CNode Item) : CNode;
}
