using System.Globalization;
using System.Text.RegularExpressions;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Semantics.Scenarios;

/// <summary>
/// The model-level scenario interpreter (#149, Approach B). Given a compiled
/// <see cref="SemanticModel"/> and a <see cref="Scenario"/>, it evaluates an
/// aggregate command (or factory) directly against a runtime state map — checking
/// <c>requires</c> preconditions, applying <c>-&gt;</c>/<c>&lt;-</c> field writes,
/// collecting <c>emit</c>ted events, computing a <c>result</c>, then re-checking
/// every invariant against the resulting state.
///
/// <para>It reuses the existing AST (<see cref="Expr"/>), operator semantics
/// (mirroring <see cref="ConstantFolder"/>) and name-resolution index
/// (<see cref="ModelIndex"/>); it adds the one missing piece — a value-level
/// evaluator over a variable environment — and emits NO code and NO C# concept,
/// keeping <c>Ast/</c> target-agnostic. Any expression it cannot evaluate yields a
/// <see cref="CheckOutcome.Indeterminate"/> outcome with a note, never a crash.</para>
/// </summary>
internal sealed class ScenarioInterpreter
{
    private readonly SemanticModel _sema;
    private readonly ModelIndex _index;
    private readonly List<string> _notes = new();

    private EntityDecl _entity = null!;
    private HashSet<string> _memberNames = new(StringComparer.Ordinal);

    // Derived members are evaluated lazily from their initializer; this tracks the ones currently being
    // computed so a self- or mutually-referential initializer degrades to Unknown instead of recursing
    // forever (a StackOverflowException would break the never-throw contract).
    private readonly HashSet<string> _evaluatingDerived = new(StringComparer.Ordinal);

    private ScenarioInterpreter(SemanticModel sema)
    {
        _sema = sema;
        _index = sema.Index;
    }

    /// <summary>Runs <paramref name="scenario"/> against <paramref name="sema"/> and returns its timeline.</summary>
    public static ScenarioResult Run(SemanticModel sema, Scenario scenario) =>
        new ScenarioInterpreter(sema).RunCore(scenario);

    private ScenarioResult RunCore(Scenario s)
    {
        EntityDecl? entity = ResolveEntity(s.Target);
        if (entity is null)
        {
            _notes.Add($"Unknown target '{s.Target}': no aggregate or entity by that name.");
            return Failed(s);
        }

        _entity = entity;
        _memberNames = entity.Members.Select(m => m.Name).ToHashSet(StringComparer.Ordinal);

        CommandDecl? command = entity.Commands.FirstOrDefault(c => c.Name == s.Operation);
        FactoryDecl? factory = command is null
            ? entity.Factories.FirstOrDefault(f => f.Name == s.Operation)
            : null;
        if (command is null && factory is null)
        {
            _notes.Add($"Unknown operation '{s.Operation}' on '{entity.Name}': no command or factory by that name.");
            return Failed(s);
        }

        IReadOnlyList<CommandStmt> body = command?.Body ?? factory!.Body;
        IReadOnlyList<Param> parameters = command?.Parameters ?? factory!.Parameters;

        Dictionary<string, ScenarioValue> env = BuildEnvironment(entity, parameters, s);

        var steps = new List<ScenarioStep>();
        string? result = null;
        bool ok = ExecuteBody(body, env, steps, ref result);

        IReadOnlyDictionary<string, string> resultingState = SnapshotState(entity, env);
        IReadOnlyList<InvariantCheck> invariants = CheckInvariants(entity, env);

        return new ScenarioResult(ok, entity.Name, s.Operation, steps, resultingState, invariants, result, _notes);
    }

    private ScenarioResult Failed(Scenario s) => new(
        Ok: false,
        Target: s.Target,
        Operation: s.Operation,
        Steps: Array.Empty<ScenarioStep>(),
        ResultingState: new Dictionary<string, string>(),
        Invariants: Array.Empty<InvariantCheck>(),
        Result: null,
        Notes: _notes);

    // ------------------------------------------------------------------------
    // Resolution
    // ------------------------------------------------------------------------

    /// <summary>Find the entity for a target name: an entity directly, an aggregate's root, or the
    /// last segment of a qualified <c>Context.Type</c> name. Returns <c>null</c> when none matches.</summary>
    private EntityDecl? ResolveEntity(string target)
    {
        string name = target.Contains('.') ? target[(target.LastIndexOf('.') + 1)..] : target;

        List<EntityDecl> entities = NodeWalker.Descendants(_sema.Model).OfType<EntityDecl>().ToList();

        EntityDecl? direct = entities.FirstOrDefault(e => e.Name == name);
        if (direct is not null)
        {
            return direct;
        }

        AggregateDecl? agg = NodeWalker.Descendants(_sema.Model).OfType<AggregateDecl>()
            .FirstOrDefault(a => a.Name == name);
        if (agg is not null)
        {
            return entities.FirstOrDefault(e => e.Name == agg.RootName);
        }

        return null;
    }

    // ------------------------------------------------------------------------
    // Environment
    // ------------------------------------------------------------------------

    private Dictionary<string, ScenarioValue> BuildEnvironment(
        EntityDecl entity, IReadOnlyList<Param> parameters, Scenario s)
    {
        var env = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal);

        // Stored (non-derived) members: given value, else a constant default, else absent/unknown.
        foreach (Member m in entity.Members)
        {
            if (MemberAnalysis.IsDerived(m, _memberNames))
            {
                continue; // derived members are computed lazily from their initializer
            }

            if (s.Given.TryGetValue(m.Name, out ScenarioValue? given))
            {
                env[m.Name] = Coerce(given, m.Type);
            }
            else if (m.Initializer is not null)
            {
                env[m.Name] = Eval(m.Initializer, env); // a constant default such as `status = Draft`
            }
            else if (m.Type.IsOptional)
            {
                env[m.Name] = ScenarioValue.Missing;
            }
            else
            {
                env[m.Name] = new ScenarioValue.Unknown($"no given value for '{m.Name}'");
                _notes.Add($"No 'given' value for required field '{m.Name}'; treated as indeterminate.");
            }
        }

        // The entity identity, referenced in bodies as `id` — unless the entity declares a real member
        // named `id`, in which case that member's bound value (above) wins and is not overwritten.
        if (!_memberNames.Contains("id"))
        {
            env["id"] = s.Given.TryGetValue("id", out ScenarioValue? id)
                ? id
                : new ScenarioValue.Text($"<{entity.IdentityName}>");
        }

        // Operation arguments.
        foreach (Param p in parameters)
        {
            if (s.Args.TryGetValue(p.Name, out ScenarioValue? arg))
            {
                env[p.Name] = Coerce(arg, p.Type);
            }
            else
            {
                env[p.Name] = new ScenarioValue.Unknown($"no argument for '{p.Name}'");
                _notes.Add($"No argument supplied for parameter '{p.Name}'; treated as indeterminate.");
            }
        }

        return env;
    }

    /// <summary>Best-effort shaping of an input value to its declared type: a string for an enum field
    /// becomes an <see cref="ScenarioValue.EnumMember"/>; list/record elements recurse. Leaves the value
    /// untouched when the type is unknown.</summary>
    private ScenarioValue Coerce(ScenarioValue value, TypeRef type)
    {
        if (value is ScenarioValue.Absent)
        {
            return value;
        }

        if (value is ScenarioValue.Text text && _index.IsEnumType(type.Name))
        {
            return new ScenarioValue.EnumMember(text.Value);
        }

        if (value is ScenarioValue.List list && type.Element is not null)
        {
            return new ScenarioValue.List(list.Items.Select(i => Coerce(i, type.Element)).ToList());
        }

        if (value is ScenarioValue.Record record)
        {
            IReadOnlyList<Member>? members = MembersOf(type.Name);
            if (members is not null)
            {
                var coerced = new Dictionary<string, ScenarioValue>(StringComparer.Ordinal);
                foreach (var (key, v) in record.Fields)
                {
                    Member? member = members.FirstOrDefault(m => m.Name == key);
                    coerced[key] = member is not null ? Coerce(v, member.Type) : v;
                }

                return new ScenarioValue.Record(coerced);
            }
        }

        return value;
    }

    private IReadOnlyList<Member>? MembersOf(string typeName) =>
        _index.TryGetDecl(typeName, out TypeDecl decl)
            ? decl switch
            {
                ValueObjectDecl vo => vo.Members,
                EntityDecl e => e.Members,
                EventDecl ev => ev.Members,
                _ => null
            }
            : null;

    // ------------------------------------------------------------------------
    // Statement execution
    // ------------------------------------------------------------------------

    /// <summary>Runs the command body, appending timeline steps. Returns false if a precondition
    /// fails (which halts execution, mirroring the guard throwing in emitted code).</summary>
    private bool ExecuteBody(
        IReadOnlyList<CommandStmt> body,
        Dictionary<string, ScenarioValue> env,
        List<ScenarioStep> steps,
        ref string? result)
    {
        foreach (CommandStmt stmt in body)
        {
            switch (stmt)
            {
                case RequiresClause req:
                    CheckOutcome outcome = Outcome(Eval(req.Condition, env));
                    steps.Add(new ScenarioStep.Precondition(req.Message, req.Condition.ToFullString(), outcome));
                    if (outcome != CheckOutcome.Passed)
                    {
                        // Fail closed: anything short of a proven Passed rejects the guard, including
                        // Indeterminate (an unmodelled expression must not silently gate the scenario
                        // open, #1071).
                        return false; // guard rejects: no further mutations / emits happen
                    }

                    break;

                case Transition t:
                    {
                        string from = env.TryGetValue(t.Field, out ScenarioValue? prior) ? prior.Display() : "∅";
                        ScenarioValue next = Eval(t.Value, env);
                        env[t.Field] = next;
                        steps.Add(new ScenarioStep.Transition(t.Field, from, next.Display(), IsInitialization: false));
                        break;
                    }

                case Initialization init:
                    {
                        ScenarioValue next = Eval(init.Value, env);
                        env[init.Field] = next;
                        steps.Add(new ScenarioStep.Transition(init.Field, From: null, next.Display(), IsInitialization: true));
                        break;
                    }

                case EmitClause emit:
                    {
                        var args = new Dictionary<string, string>(StringComparer.Ordinal);
                        foreach (EmitArg arg in emit.Args)
                        {
                            args[arg.Field] = Eval(arg.Value, env).Display();
                        }

                        steps.Add(new ScenarioStep.Emit(emit.EventName, args));
                        break;
                    }

                case ResultClause res:
                    result = Eval(res.Value, env).Display();
                    steps.Add(new ScenarioStep.Result(result));
                    break;
            }
        }

        return true;
    }

    private IReadOnlyDictionary<string, string> SnapshotState(EntityDecl entity, Dictionary<string, ScenarioValue> env)
    {
        var state = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Member m in entity.Members)
        {
            ScenarioValue value = MemberAnalysis.IsDerived(m, _memberNames) && m.Initializer is not null
                ? Eval(m.Initializer, env)
                : env.GetValueOrDefault(m.Name, new ScenarioValue.Unknown("unset"));
            state[m.Name] = value.Display();
        }

        return state;
    }

    private IReadOnlyList<InvariantCheck> CheckInvariants(EntityDecl entity, Dictionary<string, ScenarioValue> env)
    {
        var checks = new List<InvariantCheck>();
        foreach (Invariant inv in entity.Invariants)
        {
            CheckOutcome outcome = Outcome(Eval(inv.Condition, env));
            checks.Add(new InvariantCheck(inv.Message, inv.Condition.ToFullString(), outcome));
        }

        return checks;
    }

    private static CheckOutcome Outcome(ScenarioValue value) => value switch
    {
        ScenarioValue.Bool b => b.Value ? CheckOutcome.Passed : CheckOutcome.Failed,
        _ => CheckOutcome.Indeterminate
    };

    // ------------------------------------------------------------------------
    // Expression evaluation: an exhaustive traversal over every Expr shape (#1071),
    // built on the shared ExprVisitor<T> (Ast/ExprVisitor.cs) instead of a hand-rolled
    // switch with a silent default arm — a future Expr subtype is a compile error here,
    // not a silently-Unknown runtime gap.
    // ------------------------------------------------------------------------

    private ScenarioValue Eval(Expr expr, Dictionary<string, ScenarioValue> env) =>
        new ScenarioEvalVisitor(this, env).Visit(expr);

    /// <summary>
    /// The exhaustive expression evaluator (mirrors <see cref="ConstantFolder"/>'s operator
    /// semantics and the emitter's built-in op vocabulary, extended with a variable environment).
    /// Carries the current <see cref="_env"/> as a mutable field, pushed/restored around the
    /// lambda- and <c>let</c>-bound sub-scopes — the same shape as <see cref="TypeResolver"/>'s
    /// <c>InferVisitor</c>. A fresh instance is created per <see cref="Eval"/> call, so the
    /// mutable scope never leaks across the interpreter's re-entrant call sites.
    /// </summary>
    private sealed class ScenarioEvalVisitor : ExprVisitor<ScenarioValue>
    {
        private readonly ScenarioInterpreter _owner;
        private Dictionary<string, ScenarioValue> _env;

        public ScenarioEvalVisitor(ScenarioInterpreter owner, Dictionary<string, ScenarioValue> env)
        {
            _owner = owner;
            _env = env;
        }

        protected override ScenarioValue VisitLiteral(LiteralExpr n) => n.Kind switch
        {
            LiteralKind.Int => decimal.TryParse(n.Text, NumberStyles.Integer | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out decimal i)
                ? new ScenarioValue.Num(i, IsInteger: true)
                : new ScenarioValue.Unknown($"bad int literal '{n.Text}'"),
            LiteralKind.Decimal => decimal.TryParse(n.Text, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal d)
                ? new ScenarioValue.Num(d, IsInteger: false)
                : new ScenarioValue.Unknown($"bad decimal literal '{n.Text}'"),
            LiteralKind.Bool => bool.TryParse(n.Text, out bool b)
                ? new ScenarioValue.Bool(b)
                : new ScenarioValue.Unknown($"bad bool literal '{n.Text}'"),
            LiteralKind.String => new ScenarioValue.Text(n.Text),
            _ => new ScenarioValue.Unknown("bad literal")
        };

        protected override ScenarioValue VisitIdentifier(IdentifierExpr n)
        {
            if (n.Name == "now")
            {
                return new ScenarioValue.Instant();
            }

            if (_env.TryGetValue(n.Name, out ScenarioValue? bound))
            {
                return bound;
            }

            // A derived member referenced before it is in the environment: compute its initializer, guarding
            // against a self-/mutually-referential initializer that would otherwise recurse forever.
            Member? derived = _owner._entity.Members.FirstOrDefault(m => m.Name == n.Name && m.Initializer is not null);
            if (derived is not null)
            {
                if (!_owner._evaluatingDerived.Add(n.Name))
                {
                    return new ScenarioValue.Unknown($"cyclic derived member '{n.Name}'");
                }

                try
                {
                    return Visit(derived.Initializer!);
                }
                finally
                {
                    _owner._evaluatingDerived.Remove(n.Name);
                }
            }

            if (_owner._index.EnumsDeclaring(n.Name).Count > 0)
            {
                return new ScenarioValue.EnumMember(n.Name);
            }

            return new ScenarioValue.Unknown($"unbound identifier '{n.Name}'");
        }

        protected override ScenarioValue VisitUnary(UnaryExpr n)
        {
            ScenarioValue operand = Visit(n.Operand);
            return (n.Op, operand) switch
            {
                (UnaryOp.Not, ScenarioValue.Bool b) => new ScenarioValue.Bool(!b.Value),
                (UnaryOp.Negate, ScenarioValue.Num num) => new ScenarioValue.Num(-num.Value, num.IsInteger),
                _ => new ScenarioValue.Unknown("unary operand not evaluable")
            };
        }

        protected override ScenarioValue VisitBinary(BinaryExpr n)
        {
            // Logical connectives use three-valued (Kleene) logic so an indeterminate side
            // does not poison a determinable result (e.g. `false && ?` is still false).
            if (n.Op is BinaryOp.And or BinaryOp.Or)
            {
                ScenarioValue l = Visit(n.Left);
                ScenarioValue r = Visit(n.Right);
                bool? lb = AsBool(l);
                bool? rb = AsBool(r);
                return n.Op == BinaryOp.And
                    ? (lb == false || rb == false ? new ScenarioValue.Bool(false)
                        : lb == true && rb == true ? new ScenarioValue.Bool(true)
                        : new ScenarioValue.Unknown("indeterminate &&"))
                    : (lb == true || rb == true ? new ScenarioValue.Bool(true)
                        : lb == false && rb == false ? new ScenarioValue.Bool(false)
                        : new ScenarioValue.Unknown("indeterminate ||"));
            }

            ScenarioValue left = Visit(n.Left);
            ScenarioValue right = Visit(n.Right);
            if (left is ScenarioValue.Unknown or ScenarioValue.Absent || right is ScenarioValue.Unknown or ScenarioValue.Absent)
            {
                return new ScenarioValue.Unknown("operand not evaluable");
            }

            return n.Op switch
            {
                BinaryOp.Eq => new ScenarioValue.Bool(ValuesEqual(left, right)),
                BinaryOp.Neq => new ScenarioValue.Bool(!ValuesEqual(left, right)),
                BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge => Compare(n.Op, left, right),
                BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div => Arithmetic(n.Op, left, right),
                _ => new ScenarioValue.Unknown($"unmodelled operator {n.Op}")
            };
        }

        private static ScenarioValue Compare(BinaryOp op, ScenarioValue left, ScenarioValue right)
        {
            if (left is ScenarioValue.Num l && right is ScenarioValue.Num r)
            {
                return new ScenarioValue.Bool(op switch
                {
                    BinaryOp.Lt => l.Value < r.Value,
                    BinaryOp.Le => l.Value <= r.Value,
                    BinaryOp.Gt => l.Value > r.Value,
                    _ => l.Value >= r.Value
                });
            }

            return new ScenarioValue.Unknown("comparison needs two numbers");
        }

        private static ScenarioValue Arithmetic(BinaryOp op, ScenarioValue left, ScenarioValue right)
        {
            if (left is not ScenarioValue.Num l || right is not ScenarioValue.Num r)
            {
                return new ScenarioValue.Unknown("arithmetic needs two numbers");
            }

            bool integral = l.IsInteger && r.IsInteger;
            try
            {
                switch (op)
                {
                    case BinaryOp.Add:
                        return new ScenarioValue.Num(l.Value + r.Value, integral);
                    case BinaryOp.Sub:
                        return new ScenarioValue.Num(l.Value - r.Value, integral);
                    case BinaryOp.Mul:
                        return new ScenarioValue.Num(l.Value * r.Value, integral);
                    default: // Div
                        if (r.Value == 0m)
                        {
                            return new ScenarioValue.Unknown("division by zero");
                        }

                        decimal q = l.Value / r.Value;
                        return new ScenarioValue.Num(q, integral && q == decimal.Truncate(q));
                }
            }
            catch (OverflowException)
            {
                return new ScenarioValue.Unknown("arithmetic overflow");
            }
        }

        protected override ScenarioValue VisitMemberAccess(MemberAccessExpr n)
        {
            ScenarioValue target = Visit(n.Target);
            switch (n.MemberName)
            {
                case "isEmpty":
                    return target is ScenarioValue.List el ? new ScenarioValue.Bool(el.Items.Count == 0)
                        : new ScenarioValue.Unknown("isEmpty needs a collection");
                case "isNotEmpty":
                    return target is ScenarioValue.List nl ? new ScenarioValue.Bool(nl.Items.Count != 0)
                        : new ScenarioValue.Unknown("isNotEmpty needs a collection");
                case "count":
                    return target is ScenarioValue.List cl ? new ScenarioValue.Num(cl.Items.Count, IsInteger: true)
                        : new ScenarioValue.Unknown("count needs a collection");
                case "length":
                    return target is ScenarioValue.Text lt ? new ScenarioValue.Num(lt.Value.Length, IsInteger: true)
                        : new ScenarioValue.Unknown("length needs a string");
                case "trim":
                    return target is ScenarioValue.Text tt ? new ScenarioValue.Text(tt.Value.Trim())
                        : new ScenarioValue.Unknown("trim needs a string");
                case "lower":
                    return target is ScenarioValue.Text lwt ? new ScenarioValue.Text(lwt.Value.ToLowerInvariant())
                        : new ScenarioValue.Unknown("lower needs a string");
                case "upper":
                    return target is ScenarioValue.Text upt ? new ScenarioValue.Text(upt.Value.ToUpperInvariant())
                        : new ScenarioValue.Unknown("upper needs a string");
                case "isBlank":
                    return target is ScenarioValue.Text bt ? new ScenarioValue.Bool(string.IsNullOrWhiteSpace(bt.Value))
                        : new ScenarioValue.Unknown("isBlank needs a string");
                case "isPresent":
                    return new ScenarioValue.Bool(target is not ScenarioValue.Absent and not ScenarioValue.Unknown);
                case "isNone":
                    return new ScenarioValue.Bool(target is ScenarioValue.Absent);
                default:
                    return target is ScenarioValue.Record rec && rec.Fields.TryGetValue(n.MemberName, out ScenarioValue? field)
                        ? field
                        : new ScenarioValue.Unknown($"member '{n.MemberName}' not evaluable on this value");
            }
        }

        protected override ScenarioValue VisitCall(CallExpr n)
        {
            ScenarioValue target = Visit(n.Target);

            switch (n.Method)
            {
                case "startsWith":
                case "endsWith":
                case "contains":
                    return EvalStringOrMembership(n.Method, target, n.Args);

                case "all":
                case "any":
                case "none":
                    return EvalQuantifier(n.Method, target, n.Args);

                case "min":
                case "max":
                    return EvalMinMax(n.Method, target, n.Args);

                case "sum":
                    return EvalSum(target, n.Args);

                case "distinctBy":
                    return EvalDistinctBy(target, n.Args);

                default:
                    return new ScenarioValue.Unknown($"unsupported call '{n.Method}'");
            }
        }

        private ScenarioValue EvalStringOrMembership(string method, ScenarioValue target, IReadOnlyList<Expr> args)
        {
            if (args.Count != 1)
            {
                return new ScenarioValue.Unknown($"{method} expects one argument");
            }

            ScenarioValue arg = Visit(args[0]);
            if (target is ScenarioValue.Text t && arg is ScenarioValue.Text a)
            {
                return new ScenarioValue.Bool(method switch
                {
                    "startsWith" => t.Value.StartsWith(a.Value, StringComparison.Ordinal),
                    "endsWith" => t.Value.EndsWith(a.Value, StringComparison.Ordinal),
                    _ => t.Value.Contains(a.Value, StringComparison.Ordinal)
                });
            }

            if (method == "contains" && target is ScenarioValue.List list)
            {
                return new ScenarioValue.Bool(list.Items.Any(i => ValuesEqual(i, arg)));
            }

            return new ScenarioValue.Unknown($"{method} not evaluable on these operands");
        }

        private ScenarioValue EvalQuantifier(string method, ScenarioValue target, IReadOnlyList<Expr> args)
        {
            if (target is not ScenarioValue.List list || args is not [LambdaExpr lambda])
            {
                return new ScenarioValue.Unknown($"{method} needs a collection and a lambda");
            }

            bool sawIndeterminate = false;
            bool anyTrue = false;
            bool allTrue = true;
            foreach (ScenarioValue item in list.Items)
            {
                bool? predicate = AsBool(EvalLambda(lambda, item));
                if (predicate is null)
                {
                    sawIndeterminate = true;
                }
                else if (predicate.Value)
                {
                    anyTrue = true;
                }
                else
                {
                    allTrue = false;
                }
            }

            return method switch
            {
                // `all`: a single false wins; otherwise indeterminate if any element was unknown.
                "all" => !allTrue ? new ScenarioValue.Bool(false)
                    : sawIndeterminate ? new ScenarioValue.Unknown("indeterminate all")
                    : new ScenarioValue.Bool(true),
                // `any`: a single true wins; otherwise indeterminate if any element was unknown.
                "any" => anyTrue ? new ScenarioValue.Bool(true)
                    : sawIndeterminate ? new ScenarioValue.Unknown("indeterminate any")
                    : new ScenarioValue.Bool(false),
                // `none` is the negation of `any`.
                _ => anyTrue ? new ScenarioValue.Bool(false)
                    : sawIndeterminate ? new ScenarioValue.Unknown("indeterminate none")
                    : new ScenarioValue.Bool(true)
            };
        }

        private ScenarioValue EvalMinMax(string method, ScenarioValue target, IReadOnlyList<Expr> args)
        {
            if (target is not ScenarioValue.List list || args is not [LambdaExpr lambda] || list.Items.Count == 0)
            {
                return new ScenarioValue.Unknown($"{method} needs a non-empty collection and a lambda");
            }

            decimal? acc = null;
            bool integral = true;
            foreach (ScenarioValue item in list.Items)
            {
                if (EvalLambda(lambda, item) is not ScenarioValue.Num n)
                {
                    return new ScenarioValue.Unknown($"{method} needs a numeric selector");
                }

                integral &= n.IsInteger;
                acc = acc is null ? n.Value : (method == "min" ? Math.Min(acc.Value, n.Value) : Math.Max(acc.Value, n.Value));
            }

            return new ScenarioValue.Num(acc!.Value, integral);
        }

        private ScenarioValue EvalSum(ScenarioValue target, IReadOnlyList<Expr> args)
        {
            if (target is not ScenarioValue.List list || args is not [LambdaExpr lambda])
            {
                return new ScenarioValue.Unknown("sum needs a collection and a lambda");
            }

            decimal total = 0m;
            bool integral = true;
            foreach (ScenarioValue item in list.Items)
            {
                if (EvalLambda(lambda, item) is not ScenarioValue.Num n)
                {
                    return new ScenarioValue.Unknown("sum needs a numeric selector (value-object sums are not modelled in v1)");
                }

                total += n.Value;
                integral &= n.IsInteger;
            }

            return new ScenarioValue.Num(total, integral);
        }

        private ScenarioValue EvalDistinctBy(ScenarioValue target, IReadOnlyList<Expr> args)
        {
            if (target is not ScenarioValue.List list || args is not [LambdaExpr lambda])
            {
                return new ScenarioValue.Unknown("distinctBy needs a collection and a lambda");
            }

            var keys = new List<ScenarioValue>();
            foreach (ScenarioValue item in list.Items)
            {
                ScenarioValue key = EvalLambda(lambda, item);
                if (key is ScenarioValue.Unknown)
                {
                    return new ScenarioValue.Unknown("distinctBy selector not evaluable");
                }

                keys.Add(key);
            }

            int distinct = keys.Select(k => k.Display()).Distinct(StringComparer.Ordinal).Count();
            return new ScenarioValue.Bool(distinct == keys.Count);
        }

        /// <summary>Binds <paramref name="lambda"/>'s parameter to <paramref name="argument"/> in a
        /// scoped copy of the environment, evaluates its body, then restores the outer scope.</summary>
        private ScenarioValue EvalLambda(LambdaExpr lambda, ScenarioValue argument)
        {
            Dictionary<string, ScenarioValue> saved = _env;
            _env = new Dictionary<string, ScenarioValue>(_env, StringComparer.Ordinal)
            {
                [lambda.Parameter] = argument
            };
            try
            {
                return Visit(lambda.Body);
            }
            finally
            {
                _env = saved;
            }
        }

        // A lambda only has meaning as an argument to a collection-operation CallExpr
        // (all/any/none/sum/min/max/distinctBy); VisitCall's helpers extract and evaluate it
        // directly via EvalLambda without ever dispatching a bare LambdaExpr through here.
        protected override ScenarioValue VisitLambda(LambdaExpr n) =>
            new ScenarioValue.Unknown("a lambda is only valid as a collection-operation argument");

        protected override ScenarioValue VisitConditional(ConditionalExpr n) =>
            AsBool(Visit(n.Condition)) switch
            {
                true => Visit(n.Then),
                false => Visit(n.Else),
                _ => new ScenarioValue.Unknown("indeterminate condition")
            };

        protected override ScenarioValue VisitCoalesce(CoalesceExpr n)
        {
            ScenarioValue left = Visit(n.Left);
            return left is ScenarioValue.Absent ? Visit(n.Right) : left;
        }

        protected override ScenarioValue VisitMatch(MatchExpr n)
        {
            if (Visit(n.Target) is not ScenarioValue.Text text)
            {
                return new ScenarioValue.Unknown("matches needs a string");
            }

            try
            {
                // The pattern is authored verbatim in the model, so a pathological one (e.g. `(x+)+y`)
                // can backtrack effectively forever. Bound it with a match timeout — the interpreter runs
                // synchronously inside the LSP / single-threaded WASM host, where an unbounded match wedges
                // the editor — and degrade a runaway pattern to the existing "indeterminate" result (#626).
                return new ScenarioValue.Bool(Regex.IsMatch(text.Value, n.Pattern, RegexOptions.None, TimeSpan.FromSeconds(1)));
            }
            catch (RegexMatchTimeoutException)
            {
                return new ScenarioValue.Unknown($"regex /{n.Pattern}/ timed out");
            }
            catch (ArgumentException)
            {
                return new ScenarioValue.Unknown($"invalid regex /{n.Pattern}/");
            }
        }

        protected override ScenarioValue VisitGuard(GuardExpr n) =>
            // `Body when Condition` means: when the condition holds, the body must hold —
            // i.e. `!Condition || Body`. Vacuously satisfied when the condition is false.
            AsBool(Visit(n.Condition)) switch
            {
                false => new ScenarioValue.Bool(true),
                true => Visit(n.Body),
                _ => new ScenarioValue.Unknown("indeterminate guard condition")
            };

        protected override ScenarioValue VisitLet(LetExpr n)
        {
            Dictionary<string, ScenarioValue> saved = _env;
            _env = new Dictionary<string, ScenarioValue>(_env, StringComparer.Ordinal);
            try
            {
                foreach (LetBinding binding in n.Bindings)
                {
                    _env[binding.Name] = Visit(binding.Value);
                }

                return Visit(n.Body);
            }
            finally
            {
                _env = saved;
            }
        }

        // ------------------------------------------------------------------------
        // Value helpers
        // ------------------------------------------------------------------------

        private static bool? AsBool(ScenarioValue v) => v is ScenarioValue.Bool b ? b.Value : null;

        private static bool ValuesEqual(ScenarioValue a, ScenarioValue b) => (a, b) switch
        {
            (ScenarioValue.Num x, ScenarioValue.Num y) => x.Value == y.Value,
            (ScenarioValue.Bool x, ScenarioValue.Bool y) => x.Value == y.Value,
            (ScenarioValue.Text x, ScenarioValue.Text y) => string.Equals(x.Value, y.Value, StringComparison.Ordinal),
            (ScenarioValue.EnumMember x, ScenarioValue.EnumMember y) => string.Equals(x.Member, y.Member, StringComparison.Ordinal),
            // An enum value supplied as a plain string (one that escaped enum-coercion) still compares by name,
            // so `status == Active` holds whether `status` resolved to an EnumMember or stayed Text.
            (ScenarioValue.EnumMember x, ScenarioValue.Text y) => string.Equals(x.Member, y.Value, StringComparison.Ordinal),
            (ScenarioValue.Text x, ScenarioValue.EnumMember y) => string.Equals(x.Value, y.Member, StringComparison.Ordinal),
            (ScenarioValue.Absent, ScenarioValue.Absent) => true,
            (ScenarioValue.Instant, ScenarioValue.Instant) => true,
            _ => false
        };
    }
}
