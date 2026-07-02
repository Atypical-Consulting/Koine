using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// The value-object slice of <see cref="PythonEmitter"/>. A Koine <c>value</c> emits as a
/// <c>@dataclass(frozen=True)</c>: stored members are typed fields, constant defaults are dataclass
/// defaults, computed (derived) members are <c>@property</c> getters, and invariants run in
/// <c>__post_init__</c> raising <see cref="PyRuntime"/>'s <c>DomainInvariantViolationError</c>.
/// Frozen-dataclass equality and hashing come free from <c>frozen=True</c> (structural by field) —
/// except when the value object's type reaches a <c>Map</c>: a <c>Map&lt;K,V&gt;</c> maps to a
/// dict-backed <c>Mapping</c> (unhashable), so the dataclass's free structural hash would throw at
/// runtime. Such a value object instead emits <c>eq=False</c> plus explicit structural
/// <c>__eq__</c>/<c>__hash__</c> that fold every reachable Map into a hashable
/// <c>frozenset(items())</c> — recursing through nested <c>List&lt;Map&gt;</c> / <c>Map&lt;K, Map&gt;</c>
/// shapes, not just top-level Map fields.
/// A <c>quantity</c> additionally gets unit-checked <c>__add__</c>/<c>__sub__</c> and scalar
/// <c>__mul__</c>/<c>__truediv__</c> dunder operators (mirroring the C#/TS quantity semantics).
/// </summary>
public sealed partial class PythonEmitter
{
    private EmittedFile EmitValueObject(PyEmitContext emit, ValueObjectDecl vo, string ns, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(vo.Name);
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);

        // Stored/default members become dataclass fields; derived members become @property getters.
        var fields = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        // Dataclass requires non-defaulted fields before defaulted ones. A constant-default member
        // (Initializer present, not derived) carries a default; an optional field defaults to None.
        var ordered = fields.OrderBy(m => HasDefault(m) ? 1 : 0).ToList();

        // A `Map<K,V>` maps to a dict-backed `Mapping`, which is unhashable — so the dataclass's free
        // structural `__hash__` (from `frozen=True`/`eq=True`) would throw `TypeError: unhashable type:
        // 'dict'` the moment the value object is hashed (set member, dict key, nested Set/Map key). The
        // hazard is a `Mapping` reachable ANYWHERE inside a field's type, not just at the top level:
        // `List<Map>` (a tuple of dicts) and `Map<K, Map>` (a dict-valued dict) are unhashable too. When
        // any field's type contains a Map (`ContainsMap`, recursing through `Element`/`Value`) we drop
        // `eq` and emit explicit structural `__eq__`/`__hash__` instead (see
        // WriteValueObjectHashableDunders). Value objects with no reachable Map are unchanged.
        var hasMapField = ordered.Any(m => ContainsMap(m.Type));

        var translator = new PythonExpressionTranslator(emit.Index, vo.Members, emit.EnumMemberToType, typeMapper, ContextOf(ns), regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        var sb = new StringBuilder();
        sb.Append(hasMapField ? "@dataclass(frozen=True, eq=False)\n" : "@dataclass(frozen=True)\n");
        sb.Append("class ").Append(name).Append(":\n");

        var classDoc = vo.Doc;
        if (!string.IsNullOrEmpty(classDoc))
        {
            WriteDoc(sb, classDoc, Indent);
        }

        // Fields.
        if (ordered.Count == 0 && string.IsNullOrEmpty(classDoc) && vo.Invariants.Count == 0 && derived.Count == 0 && !vo.IsQuantity)
        {
            sb.Append(Indent).Append("pass\n");
        }

        foreach (Member m in ordered)
        {
            WriteDoc(sb, m.Doc, Indent);
            var field = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            sb.Append(Indent).Append(field).Append(": ").Append(typeMapper.Map(m.Type));
            if (DefaultExpr(m, translator, emit.Index) is { } def)
            {
                sb.Append(" = ").Append(def);
            }
            sb.Append('\n');
        }

        // Invariants run in __post_init__ once all fields are bound (self.<field> reads).
        if (vo.Invariants.Count > 0)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("def __post_init__(self) -> None:\n");
            foreach (Invariant inv in vo.Invariants)
            {
                WriteInvariantGuard(sb, name, inv, translator);
            }
        }

        // Computed (derived) members as read-only @property getters.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("@property\n");
            sb.Append(Indent).Append("def ").Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name)))
              .Append("(self) -> ").Append(typeMapper.Map(m.Type)).Append(":\n");
            WriteDoc(sb, m.Doc, Indent + Indent);
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append('\n');
        }

        // A quantity gets unit-checked add/sub and scalar mul/truediv dunder operators. A plain value
        // object gets a scalar `__mul__` and/or an additive `__add__` ONLY where the model actually
        // uses them (R9, demand-driven — mirrors the C#/TS emitters), so we never emit an unused (or
        // non-typechecking) operator.
        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, name, ordered);
        }
        else
        {
            if (emit.ScalarNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? scalars)
                && ordered.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarOp(sb, name, ordered, scalars);
            }
            // `__truediv__` is the division dual of `__mul__` (#879, follow-up to the C# emitter's
            // #832): demand-generated only where the model actually divides this value object by a
            // scalar (base / 2), never emitted unconditionally.
            if (emit.ScalarDivNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? divScalars)
                && ordered.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarDivOp(sb, name, ordered, divScalars);
            }
            // `__add__` is demand-generated when the VO is folded with `sum` (AdditiveNeeds) OR appears
            // in a plain binary `base + base` (#834); `__sub__` is demand-generated for a plain
            // `base - base` (#834 — never generated for plain VOs before). Python lowers both call sites
            // to the native `+`/`-`, i.e. `__add__`/`__sub__`; this emits the dunder definitions.
            emit.BinaryArithmeticNeeds.TryGetValue(vo.Name, out IReadOnlySet<BinaryOp>? arithmeticOps);
            bool needsAdd = emit.AdditiveNeeds.Contains(vo.Name) || (arithmeticOps?.Contains(BinaryOp.Add) ?? false);
            bool needsSub = arithmeticOps?.Contains(BinaryOp.Sub) ?? false;
            if (needsAdd)
            {
                WriteValueObjectAdditiveOp(sb, name, ordered, "__add__", "+");
            }
            if (needsSub)
            {
                WriteValueObjectAdditiveOp(sb, name, ordered, "__sub__", "-");
            }
        }

        // A frozen value object whose free structural hash would include a Map field (a dict-backed
        // `Mapping`, unhashable) gets explicit structural dunders instead — see the `eq=False` header.
        if (hasMapField)
        {
            WriteValueObjectHashableDunders(sb, name, ordered);
        }

        return new EmittedFile(
            PathFor(ns, KindFolder.ValueObjects, vo.Name),
            Assemble(emit, ns, sb.ToString(), name));
    }

    /// <summary>
    /// Explicit structural <c>__eq__</c>/<c>__hash__</c> for a frozen value object whose type reaches a
    /// <c>Map</c>. A frozen dataclass's free structural hash assumes every field is hashable, but a
    /// <c>Map&lt;K,V&gt;</c> maps to a <c>Mapping</c> built from a plain <c>dict</c> (unhashable), so the
    /// generated hash throws <c>TypeError: unhashable type: 'dict'</c> the moment the value object is
    /// hashed. Equality stays structural and needs no special-casing — Python's <c>==</c> already recurses
    /// through nested <c>dict</c>/<c>tuple</c> structures. The hash, though, must fold every reachable Map
    /// into a hashable form: <see cref="HashableExpr"/> recurses through the field's type, turning each
    /// <c>Map</c> into <c>frozenset(items())</c> (re-mapping the value side when it too contains a Map) and
    /// each <c>List&lt;…Map…&gt;</c> into a tuple of folded elements — guarded against <c>None</c> for
    /// optional containers. This mirrors the entity emitter's explicit-dunder workaround
    /// (<c>eq=False</c> + hand-written dunders) while staying structural rather than id-based.
    /// </summary>
    private void WriteValueObjectHashableDunders(StringBuilder sb, string name, IReadOnlyList<Member> fields)
    {
        static string Field(Member m) => PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));

        // __eq__: same runtime type AND every stored field structurally equal. A Map field compares via
        // `dict.__eq__` (order-insensitive), which is correct for value-object equality.
        sb.Append('\n');
        sb.Append(Indent).Append("def __eq__(self, other: object) -> bool:\n");
        sb.Append(Indent).Append(Indent).Append("return isinstance(other, ").Append(name).Append(')');
        foreach (Member m in fields)
        {
            var f = Field(m);
            sb.Append(" and self.").Append(f).Append(" == other.").Append(f);
        }
        sb.Append('\n');

        // __hash__: hash a tuple of the fields, with every reachable Map folded to a hashable form.
        // A field whose type contains no Map renders as-is (`self.<field>`); a Map-bearing field is
        // rewritten by HashableExpr (which also guards optionals against `None`).
        var parts = fields.Select(m => HashableExpr(m.Type, "self." + Field(m), 0)).ToList();

        // A one-element tuple needs the trailing comma (`(x,)`); multi-element joins normally.
        var tuple = parts.Count == 1 ? "(" + parts[0] + ",)" : "(" + string.Join(", ", parts) + ")";
        sb.Append('\n');
        sb.Append(Indent).Append("def __hash__(self) -> int:\n");
        sb.Append(Indent).Append(Indent).Append("return hash(").Append(tuple).Append(")\n");
    }

    /// <summary>
    /// True when a <c>Map</c> is reachable anywhere inside <paramref name="type"/> — at the top level
    /// (<c>Map&lt;K,V&gt;</c>) or nested under a container (<c>List&lt;Map&gt;</c>, <c>Map&lt;K, Map&gt;</c>,
    /// <c>Map&lt;K, List&lt;Map&gt;&gt;</c>, …). A <c>Map</c> is the only Python type Koine emits that is
    /// unhashable (a dict-backed <c>Mapping</c>), so this is exactly the predicate for "the free structural
    /// hash would throw". Recurses through <see cref="TypeRef.Element"/> (a List/Set/Range element or a
    /// Map key) and <see cref="TypeRef.Value"/> (a Map value).
    /// </summary>
    private static bool ContainsMap(TypeRef type) =>
        PythonTypeMapper.IsMap(type)
        || (type.Element is not null && ContainsMap(type.Element))
        || (type.Value is not null && ContainsMap(type.Value));

    /// <summary>
    /// A hashable Python expression for <paramref name="access"/> (an attribute access or a comprehension
    /// variable) of type <paramref name="type"/>, folding every reachable <c>Map</c> into a
    /// <c>frozenset</c>. The general structural-equality philosophy of <see cref="WriteValueObjectHashableDunders"/>,
    /// generalized to any nesting depth:
    /// <list type="bullet">
    ///   <item>a <c>Map</c> whose value contains a Map →
    ///     <c>frozenset((k, &lt;fold(value)&gt;) for k, v in &lt;access&gt;.items())</c>;</item>
    ///   <item>any other <c>Map</c> → <c>frozenset(&lt;access&gt;.items())</c> (the existing single-level fold);</item>
    ///   <item>a <c>List</c> whose element contains a Map →
    ///     <c>tuple(&lt;fold(element)&gt; for x in &lt;access&gt;)</c> (a Koine <c>List</c> is already a tuple,
    ///     so it only needs re-mapping when an element is/contains a Map);</item>
    ///   <item>anything else (scalars, enums, value objects, a <c>Set</c>/<c>List</c>/<c>Range</c> with no
    ///     reachable Map) → <paramref name="access"/> unchanged — already hashable.</item>
    /// </list>
    /// Optional containers are guarded with <c>… if &lt;access&gt; is not None else None</c>. Comprehension
    /// variables are suffixed with <paramref name="depth"/> so a generator nested inside another never
    /// shadows its enclosing loop variable. (A <c>Map</c> key, a <c>Set</c> element, and a <c>Range</c>
    /// bound must already be hashable/comparable to exist at runtime, so a Map can only ever be reached via
    /// a List element or a Map value — the two cases folded here.)
    /// </summary>
    private static string HashableExpr(TypeRef type, string access, int depth)
    {
        string core;
        if (PythonTypeMapper.IsMap(type) && type.Value is not null && ContainsMap(type.Value))
        {
            // The value side is itself unhashable; re-map it so each (key, value) pair is hashable.
            var k = "k" + depth;
            var v = "v" + depth;
            core = $"frozenset(({k}, {HashableExpr(type.Value, v, depth + 1)}) for {k}, {v} in {access}.items())";
        }
        else if (PythonTypeMapper.IsMap(type))
        {
            // Hashable-valued Map: the single-level fold (matches the pre-#657 output exactly).
            core = $"frozenset({access}.items())";
        }
        else if (PythonTypeMapper.IsList(type) && type.Element is not null && ContainsMap(type.Element))
        {
            // A List is already a tuple; re-map its elements only because an element reaches a Map.
            var x = "x" + depth;
            core = $"tuple({HashableExpr(type.Element, x, depth + 1)} for {x} in {access})";
        }
        else
        {
            // Already hashable (scalar/enum/value-object, or a container with no reachable Map). `None`
            // is itself hashable, so an optional such field needs no guard.
            return access;
        }

        return type.IsOptional ? $"{core} if {access} is not None else None" : core;
    }

    /// <summary>Emits one invariant guard inside <c>__post_init__</c> (self.<i>field</i> reads).</summary>
    private void WriteInvariantGuard(StringBuilder sb, string typeName, Invariant inv, PythonExpressionTranslator translator)
    {
        const PythonExpressionTranslator.NameMode mode = PythonExpressionTranslator.NameMode.Property;

        // A `when`-guarded invariant (GuardExpr) only checks the body when the guard holds:
        //   if <guard> and not (<body>): raise …
        string test;
        if (inv.Condition is GuardExpr guard)
        {
            test = translator.Translate(guard.Condition, mode) + " and " + Negate(translator.Translate(guard.Body, mode));
        }
        else
        {
            test = Negate(translator.Translate(inv.Condition, mode));
        }

        sb.Append(Indent).Append(Indent).Append("if ").Append(test).Append(":\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("raise DomainInvariantViolationError(\"").Append(typeName).Append("\", ")
          .Append(RuleLiteral(inv.Message ?? "invariant failed")).Append(")\n");
    }

    /// <summary>
    /// Logically negates a translated condition for a guard test. When the condition is already a
    /// single fully-parenthesized group (the translator parenthesizes binary expressions), reuse
    /// those parens (<c>not (a &gt;= 0)</c>) instead of doubling them (<c>not ((a &gt;= 0))</c>).
    /// </summary>
    private static string Negate(string condition) =>
        IsFullyParenthesized(condition) ? "not " + condition : "not (" + condition + ")";

    /// <summary>True when <paramref name="s"/> is wrapped in one matched outer parenthesis pair.</summary>
    private static bool IsFullyParenthesized(string s)
    {
        if (s.Length < 2 || s[0] != '(' || s[^1] != ')')
        {
            return false;
        }

        var depth = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '(')
            {
                depth++;
            }
            else if (s[i] == ')')
            {
                depth--;
                // The opening paren is closed before the end → not a single enclosing group.
                if (depth == 0 && i != s.Length - 1)
                {
                    return false;
                }
            }
        }
        return depth == 0;
    }

    /// <summary>
    /// A quantity's unit-checked binary ops and scalar scaling. <c>__add__</c>/<c>__sub__</c> require
    /// matching units (raising a domain error otherwise); <c>__mul__</c>/<c>__truediv__</c> scale the
    /// amount by a <c>Decimal</c>/<c>int</c> scalar, carrying the unit. The amount is the (required)
    /// <c>Decimal</c> field; the unit is the other (required) field.
    /// </summary>
    private void WriteQuantityOps(StringBuilder sb, string name, IReadOnlyList<Member> fields)
    {
        Member? amount = fields.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = fields.FirstOrDefault(m => !ReferenceEquals(m, amount) && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return;
        }

        var amt = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(amount.Name));
        var u = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(unit.Name));

        // Build a constructor call placing amount/unit by their declared (field) order.
        string Construct(string amtExpr, string unitExpr) =>
            name + "(" + string.Join(", ", fields.Select(m =>
                ReferenceEquals(m, amount) ? amtExpr
                : ReferenceEquals(m, unit) ? unitExpr
                : "self." + PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name)))) + ")";

        foreach (var (dunder, verb, op) in new[] { ("__add__", "add", "+"), ("__sub__", "subtract", "-") })
        {
            sb.Append('\n');
            sb.Append(Indent).Append("def ").Append(dunder).Append("(self, other: ").Append(name).Append(") -> ").Append(name).Append(":\n");
            sb.Append(Indent).Append(Indent).Append("if self.").Append(u).Append(" != other.").Append(u).Append(":\n");
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("raise DomainInvariantViolationError(\"").Append(name)
              .Append("\", \"cannot ").Append(verb).Append(" quantities of different units\")\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct($"self.{amt} {op} other.{amt}", $"self.{u}")).Append('\n');
        }

        foreach (var (dunder, op) in new[] { ("__mul__", "*"), ("__truediv__", "/") })
        {
            sb.Append('\n');
            sb.Append(Indent).Append("def ").Append(dunder).Append("(self, factor: Decimal | int) -> ").Append(name).Append(":\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct($"self.{amt} {op} factor", $"self.{u}")).Append('\n');
        }

        // Reversed scalar multiply: `scalar * quantity` (#788). Like the value-object scalar op, the
        // reflected `__rmul__` delegates to `__mul__` so `0.9 * weight` scales identically to
        // `weight * 0.9` instead of raising `TypeError`. No `__rtruediv__`: `scalar / quantity` is not
        // a defined operation.
        sb.Append('\n');
        sb.Append(Indent).Append("def __rmul__(self, factor: Decimal | int) -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("return self.__mul__(factor)\n");
    }

    /// <summary>
    /// A value object's scalar <c>__mul__(factor)</c> (e.g. <c>Money * quantity</c>): scales each
    /// numeric field by the factor and carries the rest unchanged. The factor type is the union of
    /// the scalar Python types the model actually multiplies this value object by (<c>int</c> and/or
    /// <c>Decimal</c>). <c>Decimal * int</c> and <c>Decimal * Decimal</c> stay <c>Decimal</c>, so the
    /// constructed value object's fields keep their declared types.
    /// </summary>
    private void WriteScalarOp(StringBuilder sb, string name, IReadOnlyList<Member> fields, IReadOnlySet<string> scalars)
    {
        var numeric = new HashSet<string>(fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name), StringComparer.Ordinal);
        var factorType = ScalarUnion(scalars);

        string Arg(Member m)
        {
            var field = "self." + PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            return numeric.Contains(m.Name) ? $"{field} * factor" : field;
        }

        sb.Append('\n');
        sb.Append(Indent).Append("def __mul__(self, factor: ").Append(factorType).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(name).Append('(')
          .Append(string.Join(", ", fields.Select(Arg))).Append(")\n");

        // Reversed operand order: `scalar * value-object` (#788). Python evaluates
        // `Decimal.__mul__(<vo>)` → NotImplemented → falls back to the reflected `<vo>.__rmul__(scalar)`;
        // without this method that raises `TypeError`. Delegate to `__mul__` so both operand orders
        // scale identically — the Pythonic mirror of the merged PHP Bug-2 fix (#778). An explicit typed
        // method (not an `__rmul__ = __mul__` alias) keeps `mypy --strict` clean.
        sb.Append('\n');
        sb.Append(Indent).Append("def __rmul__(self, factor: ").Append(factorType).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("return self.__mul__(factor)\n");
    }

    /// <summary>
    /// A value object's scalar <c>__truediv__(divisor)</c> (e.g. <c>fee / 2</c>): the division dual of
    /// <see cref="WriteScalarOp"/>, dividing each numeric field by the divisor and carrying the rest.
    /// Python's <c>/</c> is always true division (never <c>int</c>-valued, even <c>int / int</c>), so an
    /// <c>Int</c> field's quotient is cast back with <c>int(...)</c> (truncating, like the C# emitter's
    /// <c>(int)(...)</c> cast) to keep the constructed value object's field types exact — a bare
    /// <c>field / divisor</c> would type as <c>float | Decimal</c> under <c>mypy --strict</c>, never
    /// <c>int</c>. No reflected <c>__rtruediv__</c>: division is non-commutative and the validator
    /// rejects <c>scalar / value-object</c> (#878), so the reversed order never reaches codegen.
    /// </summary>
    private void WriteScalarDivOp(StringBuilder sb, string name, IReadOnlyList<Member> fields, IReadOnlySet<string> scalars)
    {
        var numeric = new HashSet<string>(fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name), StringComparer.Ordinal);
        var factorType = ScalarUnion(scalars);

        string Arg(Member m)
        {
            var field = "self." + PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            if (!numeric.Contains(m.Name))
            {
                return field;
            }
            return m.Type.Name == "Int" ? $"int({field} / divisor)" : $"{field} / divisor";
        }

        sb.Append('\n');
        sb.Append(Indent).Append("def __truediv__(self, divisor: ").Append(factorType).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(name).Append('(')
          .Append(string.Join(", ", fields.Select(Arg))).Append(")\n");
    }

    /// <summary>
    /// A value object's additive <c>__add__(other)</c> / subtractive <c>__sub__(other)</c> dunder:
    /// combines each numeric field pairwise with <paramref name="op"/> (<c>+</c>/<c>-</c>), carrying the
    /// rest from <c>self</c>. Shared by the <c>sum</c>-fold path (<c>__add__</c>, e.g.
    /// <c>lines.sum(l =&gt; l.subtotal)</c>) and the plain binary <c>base + base</c> / <c>base - base</c>
    /// path (#834).
    /// </summary>
    private void WriteValueObjectAdditiveOp(StringBuilder sb, string name, IReadOnlyList<Member> fields, string dunder, string op)
    {
        var numeric = new HashSet<string>(fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name), StringComparer.Ordinal);

        string Arg(Member m)
        {
            var snake = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            return numeric.Contains(m.Name) ? $"self.{snake} {op} other.{snake}" : "self." + snake;
        }

        sb.Append('\n');
        sb.Append(Indent).Append("def ").Append(dunder).Append("(self, other: ").Append(name).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(name).Append('(')
          .Append(string.Join(", ", fields.Select(Arg))).Append(")\n");
    }

    /// <summary>The Python factor-type annotation for a set of scalar needs (<c>int</c>/<c>decimal</c>).</summary>
    private static string ScalarUnion(IReadOnlySet<string> scalars)
    {
        var parts = new List<string>();
        if (scalars.Contains("int"))
        {
            parts.Add("int");
        }
        if (scalars.Contains("decimal"))
        {
            parts.Add("Decimal");
        }
        return parts.Count == 0 ? "Decimal | int" : string.Join(" | ", parts);
    }

    // ----------------------------------------------------------------------
    // Field default classification
    // ----------------------------------------------------------------------

    /// <summary>True when a stored field carries a dataclass default (a constant initializer or an optional → None).</summary>
    private static bool HasDefault(Member m) => m.Initializer is not null || m.Type.IsOptional;

    /// <summary>
    /// The dataclass default expression for a field, or <c>null</c> when the field is required. A
    /// constant-default member renders its (literal/enum) initializer; an optional field with no
    /// initializer defaults to <c>None</c>. Mutable collection defaults are never produced — Koine
    /// collection types already map to immutable <c>tuple</c>/<c>frozenset</c> values, and a constant
    /// initializer for one would be an immutable literal.
    /// </summary>
    /// <param name="m">The stored field whose dataclass default is being computed.</param>
    /// <param name="translator">Renders the constant initializer expression to Python source.</param>
    /// <param name="index">
    /// The model index used to resolve the field's declared type so that an enum-member default is
    /// always qualified with the <em>correct</em> enum class — not the first owner found in a global
    /// scan (which is ambiguous when two contexts both declare a member with the same name).
    /// </param>
    private static string? DefaultExpr(Member m, PythonExpressionTranslator translator, ModelIndex index)
    {
        if (m.Initializer is not null)
        {
            // A constant default (not derived) — render the literal/enum-member expression directly.
            // Pass the field's own declared enum type as the hint so an ambiguous member name (one
            // that exists in multiple enums) resolves to the correct owner rather than the first
            // match the translator finds in the global enum-member → type map.
            return translator.Translate(m.Initializer, NameModeForDefault(), EnumExpected(m, index));
        }
        if (m.Type.IsOptional)
        {
            return "None";
        }
        return null;
    }

    /// <summary>A default initializer is a constant; it never reads <c>self</c>, so it renders in Parameter mode.</summary>
    private static PythonExpressionTranslator.NameMode NameModeForDefault() =>
        PythonExpressionTranslator.NameMode.Parameter;

    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
}
