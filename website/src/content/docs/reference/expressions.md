---
title: "Expressions"
description: "The pure expression sublanguage used in derived fields, invariants and bodies."
---

## 9.1 General

Koine has one small, pure expression language. It is the same language everywhere a value or
condition is expected: in [derived fields](/Koine/reference/value-objects/) (§5), [invariants](/Koine/reference/invariants/) (§10),
command and factory bodies, [specs and service operations](/Koine/reference/specs-services-policies/) (§13),
and [read-model projections](/Koine/reference/application-cqrs/) (§15).

"Pure" is the whole point: no statements, no assignments, no loops, no I/O, no `null` literal. An expression
is a value computed from a field, a parameter, a literal, and a fixed set of operators and built-in operations.
Everything below translates to idiomatic C# — a derived field becomes a get-only computed property, an
invariant becomes a constructor guard.

### Where expressions are allowed

| Position | Form | Example |
|----------|------|---------|
| Derived field | `name: Type = expr` | `total: Money = lines.sum(l => l.payable)` |
| Invariant | `invariant expr "message"` | `invariant amount >= 0 "a price cannot be negative"` |
| Guarded invariant | `invariant body when cond` | `invariant status == Draft when lines.isEmpty` |
| Command precondition | `requires expr "message"` | `requires !lines.isEmpty "cannot submit an empty order"` |
| Spec body | `spec S on T = expr` | `spec IsVip on Customer = tier == Gold` |
| Operation body | `operation o(...): T = expr` | `operation discountRate(tier: LoyaltyTier): Decimal = ...` |
| Read-model field | `name: Type = expr` | `lineCount: Int = lines.count` |
| Factory init / command transition | `field -> expr` | `total -> lines.sum(l => l.price)` |

## 9.2 Syntax

```ebnf
expression   : let_expr ;

let_expr     : 'let' let_binding ( ',' let_binding )* 'in' let_expr   // let x = e, y = e in body
             | guard_expr ;
let_binding  : Identifier '=' expression ;

guard_expr   : cond_expr ( 'when' cond_expr )? ;                      // expr when cond

cond_expr    : 'if' cond_expr 'then' cond_expr 'else' cond_expr       // if c then a else b
             | coalesce_expr ;

coalesce_expr      : or_expr ( '??' or_expr )* ;
or_expr            : and_expr ( '||' and_expr )* ;
and_expr           : equality_expr ( '&&' equality_expr )* ;
equality_expr      : relational_expr ( ( '==' | '!=' ) relational_expr )* ;
relational_expr    : match_expr ( ( '<' | '<=' | '>' | '>=' ) match_expr )* ;
match_expr         : additive_expr ( 'matches' Regex )? ;             // raw matches /.../
additive_expr      : multiplicative_expr ( ( '+' | '-' ) multiplicative_expr )* ;
multiplicative_expr: unary_expr ( ( '*' | '/' ) unary_expr )* ;
unary_expr         : ( '!' | '-' ) unary_expr | postfix_expr ;
postfix_expr       : primary ( '.' Identifier ( '(' arg_list? ')' )? )* ;

arg_list   : argument ( ',' argument )* ;
argument   : lambda | expression ;
lambda     : Identifier '=>' expression ;                            // l => l.quantity > 0

primary    : literal | Identifier | '(' expression ')' ;
literal    : DecimalLiteral | IntLiteral | StringLiteral | BoolLiteral ;
```

The `let … in` form binds intermediate names within an expression and nests anywhere a value is
expected:

```koine
total: Money = let net = lines.sum(l => l.payable) in net * taxRate
```

Operators bind from **lowest** precedence (top) to **highest** (bottom):

| Precedence | Form | Operators | Associativity |
| --- | --- | --- | --- |
| 1 (lowest) | binding | `let … in …` | — |
| 2 | guard | `expr when cond` | non-associative |
| 3 | conditional | `if … then … else …` | right (nests in `else`) |
| 4 | coalesce | `??` | left |
| 5 | logical or | `\|\|` | left |
| 6 | logical and | `&&` | left |
| 7 | equality | `==` `!=` | left |
| 8 | relational | `<` `<=` `>` `>=` | left |
| 9 | match | `matches /…/` | non-associative (postfix) |
| 10 | additive | `+` `-` | left |
| 11 | multiplicative | `*` `/` | left |
| 12 | unary | prefix `!` `-` | right |
| 13 | postfix | `.member`, `.op(args)` | left |
| 14 (highest) | primary | literal, name, `( … )` | — |

### Literals and identifiers

The atoms of every expression:

- **Numbers** — `10`, `0.9`, `0.0` (a decimal literal carries no suffix in `.koi`; the emitter adds `m` for `Decimal`).
- **Strings** — `"X"`, `", "` (double-quoted).
- **Booleans** — `true`, `false`.
- **Identifiers** — a field name, a factory/command parameter, or a bare enum member (resolved against the
  field's enum type, so two enums may share a member name).

```koine
isAvailable: Bool = availability == InStock
```

Here `availability` is a field and `InStock` is a bare member of its enum — both are identifiers.

## 9.3 Logical operators

Boolean logic uses `&&` (and), `||` (or), and prefix `!` (not).

```koine
spec IsLargeOrder on Order = lines.count > 10 || total.amount > 1000
```

```koine
requires !lines.isEmpty   "cannot submit an empty order"
```

## 9.4 Arithmetic

Arithmetic `+ - * /` works as you expect. Arithmetic over a value object uses that object's generated
operators (so `unitPrice * quantity` multiplies `Money` by a scalar).

```koine
value OrderLine {
  product:   ProductId
  quantity:  Int
  unitPrice: Money
  lineTotal: Money = unitPrice * quantity
  invariant quantity >= 1   "an order line needs at least one unit"
}
```

:::note
`+` is overloaded: between numbers it adds, between strings it concatenates. `street + ", " + city`
produces a `String`; `amount + tax` over two `Money` value objects uses Money's `+` operator.
:::

## 9.5 Comparison

Comparison operators `== != < <= > >=` are type-checked. Relational operators (`< <= > >=`) require
**orderable** operands — exactly `Int`, `Decimal`, and `Instant`. `String` is not orderable; compare
strings with `==`/`!=` only.

`Instant` fields (emitted as `DateTimeOffset`) compare with the full relational set `< <= > >= == !=`.
Comparing an `Instant` against a non-`Instant` is a type error.

```koine
value DateRange {
  startsAt: Instant
  endsAt:   Instant
  invariant startsAt <= endsAt   "start must precede end"
}
```

The built-in `now` is recognized in command bodies (e.g. `submittedAt -> now`) but is **rejected as a stored
default** (`field: Instant = now`) so generated models stay deterministic.

## 9.6 Conditionals

`if cond then a else b` is an expression (a ternary), not a statement — it always yields a value, so both
branches are required and must have compatible types.

```koine
payable: Money = if quantity >= 10 then lineTotal * 0.9 else lineTotal
```

It emits a parenthesized C# ternary:

```csharp
public Money Payable => ((Quantity >= 10) ? (LineTotal * 0.9m) : LineTotal);
```

Conditionals nest in the `else` branch for multi-way logic:

```koine
operation discountRate(tier: LoyaltyTier): Decimal =
  if tier == Gold then 0.10 else if tier == Silver then 0.05 else 0.0
```

## 9.7 Guards

A boolean expression may be qualified with a `when` guard, written `body when condition`. The guard is
how a conditional invariant reads: the `body` is only required to hold *when* the `condition` is true.

```koine
invariant status == Draft when lines.isEmpty   "an empty order must stay in Draft"
```

`when` sits just above the conditional expression in precedence ([§9.2](#92-syntax)) and is
non-associative — a single optional guard per expression.

## 9.8 Pattern matching

For shape constraints beyond equality, use the regex form `field matches /pattern/` in an invariant.
`matches` is a non-associative postfix operator at precedence 9 ([§9.2](#92-syntax)), applied to any
`String` expression.

```koine
value Iban {
  code: String
  invariant code matches /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/   "must look like an IBAN"
}
```

See [Invariants (§10)](/Koine/reference/invariants/) for the full `matches` and `when` guard coverage.

## 9.9 Collection operations

Collection operations apply to a `List<T>` field. The element type `T` is in scope inside a lambda written
`param => expr`, with the element's members resolvable (`l => l.quantity`).

| Koine | Meaning | Emitted C# (sketch) |
|-------|---------|---------------------|
| `xs.count` | element count | `Xs.Count` |
| `xs.isEmpty` | is empty | `Xs.Count == 0` |
| `xs.isNotEmpty` | is non-empty | `Xs.Count != 0` |
| `xs.all(l => p)` | every element satisfies `p` | `Xs.All(l => p)` |
| `xs.any(l => p)` | some element satisfies `p` | `Xs.Any(l => p)` |
| `xs.sum(l => e)` | fold `e` over elements | numeric: `Xs.Sum(l => e)`; value object: `Xs.Select(l => e).Aggregate((a, b) => a + b)` |
| `xs.distinctBy(l => k)` | no two elements share key `k` | `Xs.Select(l => k).Distinct().Count() == Xs.Count` |

```koine
entity Order identified by OrderId {
  lines: List<OrderLine>
  total:     Money = lines.sum(l => l.payable)
  lineCount: Int   = lines.count
  invariant lines.all(l => l.quantity >= 1)    "every line needs a positive quantity"
  invariant lines.distinctBy(l => l.product)   "no duplicate products in an order"
}
```

`lines.sum(l => l.payable)` over a value-object selector folds with the element's `+` operator rather than
numeric `.Sum(...)`:

```csharp
public Money Total => Lines.Select(l => l.Payable).Aggregate((a, b) => a + b);
public int LineCount => Lines.Count;
```

:::note
`distinctBy` is a **uniqueness predicate**, not a transformation — used as an invariant it asserts there are
no duplicate keys, emitting a count comparison rather than returning a deduplicated list.
:::

### 9.9.1 String operations

String operations are written as member access on a `String` receiver. They chain left to right.

| Koine | Meaning | Emitted C# |
|-------|---------|------------|
| `s.length` | character count | `s.Length` |
| `s.trim` | strip surrounding whitespace | `s.Trim()` |
| `s.upper` | upper-case | `s.ToUpperInvariant()` |
| `s.lower` | lower-case | `s.ToLowerInvariant()` |

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper
  invariant code.trim.length > 0   "a SKU cannot be blank"
}
```

`code.trim.upper` chains, emitting `Code.Trim().ToUpperInvariant()`; the invariant
`code.trim.length > 0` becomes a constructor guard `if (!(code.Trim().Length > 0)) throw …`.

## 9.10 Optionality

Mark a field optional with a trailing `?` (`String?`, `Instant?`). Optional fields default to absent and are
excluded from non-null construction guards. Three expression forms work with optionals:

| Koine | Meaning | Emitted C# |
|-------|---------|------------|
| `a ?? b` | coalesce — `a` if present, else `b` | `(a ?? b)` |
| `field.isPresent` | true when set | `field is not null` |
| `field.isNone` | true when absent | `field is null` |

```koine
entity Customer identified by CustomerId {
  name:        String
  nickname:    String?
  phone:       String?
  displayName: String = nickname ?? name
  hasPhone:    Bool   = phone.isPresent
}
```

```csharp
public string DisplayName => (Nickname ?? Name);
public bool HasPhone => Phone is not null;
```

:::caution
There is no `null` literal in Koine — you never write `null`. Absence is expressed by leaving an optional
field unset; you reach for it with `??`, `.isPresent`, and `.isNone`.
:::

## 9.11 Translation to C#

Every expression form has a direct C# rendering shown inline in the sections above. In summary:

- **Derived fields** (`name: Type = expr`) → get-only computed properties (`public T Name => …;`).
- **Invariants** (`invariant expr "msg"`) → constructor guards (`if (!(…)) throw new ArgumentException("msg")`).
- **Guarded invariants** (`invariant body when cond`) → guards wrapped with the condition (`if (cond && !(body)) throw …`).
- **`let … in`** bindings → local variables or inlined expressions in the emitted property body.
- **`if … then … else …`** → parenthesized C# ternary (`(cond ? a : b)`).
- **`??`** → C# null-coalescing operator (`(a ?? b)`).
- **`.isPresent` / `.isNone`** → `field is not null` / `field is null`.
- **Collection ops** → LINQ (`All`, `Any`, `Sum`, `Select`, `Aggregate`, `Count`, `Distinct`).
- **String ops** → `Trim()`, `ToUpperInvariant()`, `ToLowerInvariant()`, `Length`.
- **Atomic token note** — `->` and `<->` are single, indivisible tokens; see [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) for the atomic-token rule.

## See also

- [Value objects (§5)](/Koine/reference/value-objects/) — derived fields use expressions.
- [Invariants (§10)](/Koine/reference/invariants/) — boolean expressions plus `matches` and `when` guards.
- [Commands, events & state machines (§11)](/Koine/reference/commands-events-state/) and [Factories (§12)](/Koine/reference/factories/) — bodies use `requires`, `->`, and `emit`.
- [Specifications, services & policies (§13)](/Koine/reference/specs-services-policies/) — named expression bodies.
- [Application layer & CQRS (§15)](/Koine/reference/application-cqrs/) — read-model projections use expressions.
