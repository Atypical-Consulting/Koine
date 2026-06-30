---
title: "Invariants"
description: "Constructor guards: range, regex, conditional, and spec-backed."
---

## 10.1 General

An `invariant` is a rule that must hold for an object to exist. Koine compiles each
one into a guard at the **top of the constructor** (and re-checks them after a
command mutates state). If a guard fails, the object is never created and a
`DomainInvariantViolationException` is thrown.

That means you can never get your hands on an invalid `Sku`, `Money`, or `Order` — the
type system and the constructor enforce it. There is no separate "validate then use"
step; validity is a property of *having an instance*.

Invariants are valid inside `value`, `quantity`, `entity`, and aggregate roots. The
member order in a body is fixed: **fields first, then invariants**, then any states,
commands, and factories.

:::note
`invariant` is a **fully reserved** word — unlike `value` or `quantity`, you cannot
use it as a field name. The same applies to `matches` (see [§10.6](#106-regex-invariants-matches)).
:::

## 10.2 Syntax

An invariant is declared with the `invariant` keyword followed by a boolean expression
and an optional failure-message string. The expression may use the full Koine expression
language, including the `when` guard form and the `matches` regex form:

```ebnf
invariant
    : 'invariant' expression StringLiteral?
    ;
```

The `expression` grammar — including the `when` guard and `matches` — is specified in [Expressions §9.2](/Koine/reference/expressions/#92-syntax).

An `invariant` consists of:

- The keyword `invariant`.
- An `expression` — any well-formed boolean expression from the expression language
  ([Expressions (§9)](/Koine/reference/expressions/)). This includes comparisons, logical operators
  (`&&` / `||` / `!`), string operations, collection operations (`all`, `count`, `sum`,
  `distinctBy`), and the regex-match form `<expr> matches /pattern/`.
- An optional `StringLiteral` that becomes the failure message surfaced in
  `DomainInvariantViolationException.Rule`. When omitted (as with the `when` form and
  spec-backed invariants) Koine synthesizes the rule text from the source.

The `when` guard and the `matches` operator are both part of the full expression grammar
defined in [Expressions (§9)](/Koine/reference/expressions/). Writing
`invariant <body> when <cond>` makes the whole guard conditional on `<cond>`, while
`<field> matches /pattern/` switches the lexer into regex mode so the `/…/` is read as a
single token rather than two division operators.

```koine
value Price {
  amount:   Decimal
  currency: Currency
  invariant amount >= 0   "a price cannot be negative"
}
```

## 10.3 Semantics

### 10.3.1 Evaluation order and scope

Every `invariant` declared on a type is evaluated in declaration order at the top of the
constructor, before any field assignments. An invariant expression may reference any
field of the type (including derived fields whose expression does not itself depend on
uninitialized state) and the full expression language.

### 10.3.2 Message synthesis

When a `StringLiteral` message is present, it becomes the `rule` argument of
`DomainInvariantViolationException`. When the message is omitted — as with `when`-guarded
invariants and spec-backed invariants — Koine synthesizes the rule text from the source
representation of the invariant body.

### 10.3.3 Satisfiability analysis

The compiler statically folds the constant parts of each value object's invariants and
flags ones that can never hold — a value object whose invariants contradict each other
can never be constructed, so the generated code would always throw. These are warnings
(the code still compiles):

| Code | Meaning |
| --- | --- |
| `KOI0310` | The whole invariant condition is a constant that can never hold (always `false`). |
| `KOI0311` | A field's inclusive bounds are inverted (the lower bound exceeds the upper bound), e.g. `x >= 100 && x <= 0`. |
| `KOI0312` | A field's constant default lies outside the range its invariants require. |
| `KOI0313` | Two bounds on the same field cannot both hold; their intersection is empty, e.g. `amount > 100 && amount < 10`. |

A `when`-guarded invariant is conditional, so it is never flagged. Exhaustiveness of a
smart-enum `Match` stays a compile-time guarantee of the generated code — it is
deliberately *not* re-checked here.

### 10.3.4 Reserved words

`invariant` and `matches` are **fully reserved** — they cannot be used as field names
or identifiers anywhere in a `.koi` file. This is distinct from contextual keywords such
as `value` or `quantity`, which may appear as field names in positions where the parser
can unambiguously resolve them.

## 10.4 Translation to C#

Every failing invariant throws the same runtime type, emitted once into your output as
`Koine.Runtime.DomainInvariantViolationException`:

```csharp
public sealed class DomainInvariantViolationException : Exception
{
    public string TypeName { get; }
    public string Rule { get; }

    public DomainInvariantViolationException(string type, string rule)
        : base($"Invariant violated on {type}: {rule}") { … }
}
```

The same exception is reused for illegal [state transitions (§11)](/Koine/reference/commands-events-state/)
and unmet [command preconditions (§11)](/Koine/reference/commands-events-state/) (`requires`), so a single
`catch (DomainInvariantViolationException ex)` can surface any domain-rule failure, with
`ex.TypeName` and `ex.Rule` available for logging or mapping to an API error.

The general emit pattern is always:

```csharp
if (!(<expr>))
    throw new DomainInvariantViolationException(
        type: nameof(DeclaringType),
        rule: "the message string");
```

Here is the C# Koine emits for the `Price` example above:

```csharp
public Price(decimal amount, Currency currency)
{
    if (!(amount >= 0))
        throw new DomainInvariantViolationException(
            type: nameof(Price),
            rule: "a price cannot be negative");

    Amount = amount;
    Currency = currency;
}
```

## 10.5 Boolean invariants

The general form is `invariant <expr> "<message>"`. The expression must be boolean and
may reference any field of the type, derived fields, and the full Koine expression
language — comparisons, `&&` / `||`, string ops, and collection ops like `all`, `count`,
`sum`, and `distinctBy`.

```koine
value Sku {
  code:       String
  normalized: String = code.trim.upper
  invariant code.trim.length > 0   "a SKU cannot be blank"
}
```

```csharp
if (!(code.Trim().Length > 0))
    throw new DomainInvariantViolationException(
        type: nameof(Sku),
        rule: "a SKU cannot be blank");
```

The pattern is always the same: Koine emits `if (!(<expr>)) throw …`. The message string
becomes the `rule` argument, and `type` is the declaring type's name. On an aggregate
root with collection fields the expressions are richer, but the shape is identical:

```koine
invariant lines.all(l => l.quantity >= 1)    "every line needs a positive quantity"
invariant lines.distinctBy(l => l.product)   "no duplicate products in an order"
```

```csharp
if (!(lines.All(l => (l.Quantity >= 1))))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "every line needs a positive quantity");

if (!(lines.Select(l => l.Product).Distinct().Count() == lines.Count))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "no duplicate products in an order");
```

:::tip
`distinctBy(l => l.product)` is a uniqueness invariant — it reads as "these are
distinct by product" and compiles to the `Select(...).Distinct().Count() == Count`
check. Use it for "no duplicates" rules instead of writing the LINQ yourself.
:::

## 10.6 Regex invariants (`matches`)

For string shape rules, use `invariant <field> matches /<regex>/ "<message>"`. Koine
emits a `Regex.IsMatch` guard and pulls in `using System.Text.RegularExpressions;`.

```koine
value Email {
  raw:        String
  normalized: String = raw.trim.lower
  invariant raw.trim.length > 0                "an email cannot be blank"
  invariant raw matches /^[^@]+@[^@]+\.[^@]+$/   "invalid email address"
}
```

```csharp
if (!Regex.IsMatch(raw, @"^[^@]+@[^@]+\.[^@]+$", RegexOptions.None, TimeSpan.FromMilliseconds(1000)))
    throw new DomainInvariantViolationException(
        type: nameof(Email),
        rule: "invalid email address");
```

The pattern between the slashes is copied verbatim into a C# verbatim string (`@"…"`),
so write the regex exactly as .NET's `Regex` expects it.

### Bounded evaluation (ReDoS hardening)

A `matches` pattern is **author-supplied** and a value object is exactly where untrusted
external input (emails, identifiers, free text) crosses the trust boundary. A
catastrophic-backtracking pattern could otherwise turn the constructor into a
[ReDoS](https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS)
sink, so Koine bounds the emitted match per target:

| Target | Emitted form | Bound |
| --- | --- | --- |
| **C#** | `Regex.IsMatch(raw, @"…", RegexOptions.None, TimeSpan.FromMilliseconds(1000))` | A real **per-call match timeout** (1000 ms). A timed-out match throws a *contained* `RegexMatchTimeoutException` from the constructor — it never hangs. |
| **TypeScript** | `regexMatch(/…/, raw)` (a runtime helper) | JS has **no** synchronous per-call regex timeout, so the host can't bound a match without changing its result. Every match routes through one `regexMatch` seam that preserves semantics exactly (it *is* `.test`) and is the single place to swap in a linear-time engine (e.g. RE2) for a hard guarantee on untrusted input. |
| **Python** | `re.search(r"…", raw) is not None` | CPython's stdlib `re` has **no** per-call timeout; the form is unchanged. For untrusted input, cap input length or use the third-party `regex` module's `timeout=`. |
| **PHP** | `(bool)preg_match('/…/', $raw)` | PCRE is **already bounded** by `pcre.backtrack_limit` / `pcre.recursion_limit` (set by default), so a catastrophic pattern fails the match instead of hanging. |
| **Rust** | `koine_runtime::regex_is_match(r"…", &raw)` | The `regex` crate is a **linear-time** automaton with no catastrophic backtracking — no timeout is needed by construction. |

The C# timeout is configurable via the `koine.config` key
[`targets.csharp.regexMatchTimeoutMs`](/Koine/guides/cli/#koineconfig) (default `1000`): set a tighter bound
for hostile-input value objects, or a looser one for a legitimately expensive pattern on trusted batch
input. For a one-off override without editing the config, pass
[`--regex-match-timeout-ms <ms>`](/Koine/guides/cli/#koine-build) on the command line — the flag wins over
the config key for that invocation. The value must be a **positive integer** number of milliseconds — `0`
or any negative value is rejected at build time (`regexMatchTimeoutMs must be a positive integer
(milliseconds); got '…'`), because it would otherwise flow into the generated
`TimeSpan.FromMilliseconds(N)` and throw at the *generated* code's own runtime. Disabling the bound is
intentionally not supported — the whole point of the guard is to *have* one. A non-integer value is
ignored (the emitter keeps its `1000` ms default), matching how other malformed config keys are
forward-compatibly skipped.

The generated TypeScript `regexMatch` helper is the seam to harden untrusted-input
matching without touching every call site — replace its body with a linear-time engine (e.g. RE2)
and every `matches` invariant inherits the bound.

### Source-generated form (opt-in, C#)

A hot-path value object — an `Email`, an identifier, a free-text field constructed thousands of
times — pays a per-call cost in the inline form: the static `Regex.IsMatch(string, string, …)` overload
parses the pattern and builds its automaton on **every** call, even though the pattern is a compile-time
constant. The opt-in **`RegexMode.SourceGenerated`** mode emits the .NET
[`[GeneratedRegex]`](https://learn.microsoft.com/dotnet/standard/base-types/regular-expression-source-generators)
source-generator form instead: the pattern is compiled **once, ahead of time**, into a cached,
allocation-free matcher.

With the mode on, the same `Email` emits:

```csharp
public sealed partial class Email : ValueObject        // the type becomes `partial`
{
    public string Raw { get; }

    public Email(string raw)
    {
        if (!RawRegex0().IsMatch(raw))                  // the call site uses the cached matcher
            throw new DomainInvariantViolationException(
                type: nameof(Email),
                rule: "invalid email address");
        Raw = raw;
    }

    [GeneratedRegex(@"^[^@]+@[^@]+\.[^@]+$", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex RawRegex0();            // compiled once by the source generator
}
```

This is a **performance optimization, not a behavior change**. The pattern, `RegexOptions.None`, and the
match timeout are identical to the inline form — only the *evaluation strategy* changes. The same
[`targets.csharp.regexMatchTimeoutMs`](/Koine/guides/cli/#koineconfig) bound flows into
`matchTimeoutMilliseconds:` exactly as it flows into `TimeSpan.FromMilliseconds(N)` above, so a timed-out
match still surfaces the same contained `RegexMatchTimeoutException`. A type holding several `matches`
invariants gets one deterministically-named partial method per pattern (`RawRegex0`, `RawRegex1`, …), so
the output is stable across rebuilds.

The mode is **default-off**: unless it is enabled, every `matches` invariant emits the inline form
above, byte-for-byte. It applies only to **value objects and entities** (which declare the partial method
and become `partial`); a `matches` in a spec, domain service, or generated validator keeps the inline
bounded form, so output always compiles. It requires **C# 11+ / .NET 7+** (the `[GeneratedRegex]` source
generator), which a default `net8.0`+ target satisfies. The other emitter targets are unaffected — their
bounded forms in the table above are unchanged.

:::note
The mode is currently selected through the emitter API (`CSharpEmitterOptions.RegexMode`); a
`targets.csharp.regexMode` `koine.config` key to toggle it from the CLI is a planned follow-up. Until then
the default CLI/`koine build` output is the inline form.
:::

## 10.7 Conditional invariants (`when`)

Sometimes a rule only applies in a particular state. Append a `when <cond>` clause and the
invariant body is only enforced when the condition holds:

```koine
invariant status == Draft when lines.isEmpty
```

This reads as "*when* the order has no lines, its status must be `Draft`". Koine compiles
the `when` condition into a short-circuiting `&&` in front of the negated body — the guard
only fires when the condition is true *and* the rule is broken:

```csharp
if (lines.Count == 0 && !(status == OrderStatus.Draft))
    throw new DomainInvariantViolationException(
        type: nameof(Order),
        rule: "status == Draft when lines.isEmpty");
```

:::note
A `when` invariant takes no message string — Koine synthesizes the `rule` text from the
source (`"status == Draft when lines.isEmpty"`), so the exception still describes exactly
which rule was violated.
:::

## 10.8 Spec-backed invariants

A [specification (§13)](/Koine/reference/specs-services-policies/) is a named, reusable boolean predicate
declared with `spec <Name> on <Type> = <expr>`. You can reference it as an invariant by its
bare name — no message required — and Koine inlines the predicate into the constructor guard:

```koine
spec HasLines on Order = !lines.isEmpty

entity Order identified by OrderId {
  lines: List<OrderLine>
  invariant HasLines   "an order must have at least one line"
}
```

The spec's body is inlined at the guard site, so the emitted check is the same as if you
had written the expression directly — but the rule now lives in one named place and can be
reused in commands, derived fields, and other specs. The spec must target the same type the
invariant lives on (otherwise you get a `SpecTargetMismatch` error), and if the inlined body
uses collection ops, `using System.Linq;` is pulled into the file.

See [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) for the full story on declaring,
composing, and reusing named predicates.

## 10.9 Quick reference

| Form | Emits |
| --- | --- |
| `invariant <expr> "msg"` | `if (!(<expr>)) throw …` |
| `invariant <field> matches /re/ "msg"` | `if (!Regex.IsMatch(<field>, @"re", RegexOptions.None, TimeSpan.FromMilliseconds(1000))) throw …` |
| `invariant <body> when <cond>` | `if (<cond> && !(<body>)) throw …` |
| `invariant <SpecName> "msg"?` | inlines the named spec's predicate into the guard |

## See also

- [Value objects (§5)](/Koine/reference/value-objects/) — where most invariants live; see §5.3.1 for inline validating-constructor examples.
- [Expressions (§9)](/Koine/reference/expressions/) — the full expression grammar used in invariant bodies.
- [Specs, services & policies (§13)](/Koine/reference/specs-services-policies/) — reusable named predicates you can use as invariants.
- [Commands, events & state machines (§11)](/Koine/reference/commands-events-state/) — `requires` preconditions (the command-level cousin of invariants) and legal transitions, also guarded by `DomainInvariantViolationException`.
