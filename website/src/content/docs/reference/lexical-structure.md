---
title: "Lexical structure"
description: "Source text, comments, identifiers, keywords, literals, and operators — the tokens a .koi file is made of."
---

A `.koi` source file is a sequence of Unicode characters that the compiler reduces to a stream of
**tokens** before parsing. Koine's grammar is split in two — a *lexical* grammar (this chapter) that
forms tokens from characters, and a *syntactic* grammar (the construct chapters) that forms
declarations from tokens. The split is real: the lexer enters a dedicated mode after `matches` so a
`/…/` regex literal is read as one token rather than two division operators.

## 3.1 General

Lexical processing forms the **longest possible** token at each point (maximal munch). Several token
definitions exist precisely to win such ties — `<->` is matched before `<`, `->` before `-`,
`versioned` before `version`, and `///` before `//`. These are called out in
[§3.7](#37-operators-and-punctuators) and [§3.3](#33-comments).

## 3.2 Source text and whitespace

```ebnf
Whitespace
    : [ \t\r\n]+
    ;
```

Whitespace (spaces, tabs, carriage returns, line feeds) separates tokens but is otherwise
insignificant to the grammar. Indentation is never significant. (Internally the compiler keeps
whitespace and comments on side channels so the formatter can round-trip a file losslessly; this has
no effect on parsing or semantics.)

## 3.3 Comments

```ebnf
DocComment   : '///' ( ~[/\r\n] ~[\r\n]* )? ;   // documentation comment
LineComment  : '//'  ~[\r\n]* ;            // ordinary comment
BlockComment : '/*'  .*? '*/' ;            // ordinary comment
```

Koine has three comment forms:

- **Line comments** start with `//` and run to end of line.
- **Block comments** are delimited by `/*` … `*/` and do not nest.
- **Documentation comments** start with `///` and attach to the declaration that follows them; the
  `docs` emitter surfaces them in generated reference material.

:::note
A run of four or more slashes (`////…`) is an ordinary line comment, not a doc comment — `///` is
matched only when the fourth character is not a slash. This matches the C#/Rust convention that
`////` is a visual divider.
:::

## 3.4 Identifiers

```ebnf
Identifier
    : [a-zA-Z_] [a-zA-Z0-9_]*
    ;
```

An identifier starts with a letter or underscore and continues with letters, digits, or underscores.
Identifiers are case-sensitive. **Hyphens are not allowed** in identifiers; the only hyphenated names
in the language are the fixed context-map role keywords ([§3.5](#35-keywords)), which are legal solely
as relation roles (see [Context maps & integration](/Koine/reference/context-maps-integration/)).

## 3.5 Keywords

Koine deliberately keeps very few words off-limits, so domain vocabulary rarely collides with the
language.

### 3.5.1 Reserved keywords

Two words are **fully reserved** and can never be used as a name: `invariant` and `matches`.
(`invariant` opens a guard; `matches` switches the lexer into regex mode — see
[§3.6](#36-literals).)

### 3.5.2 Soft keywords

Every other keyword is **soft**: outside its declaration position it is an ordinary identifier, so you
may name a field after it. The soft keywords are:

`context`, `value`, `quantity`, `entity`, `aggregate`, `enum`, `identified`, `by`, `root`, `command`,
`requires`, `result`, `event`, `emit`, `states`, `create`, `spec`, `on`, `service`, `operation`,
`policy`, `as`, `natural`, `sequence`, `guid`, `versioned`, `repository`, `operations`, `find`,
`usecase`, `readmodel`, `from`, `query`, `import`, `module`, `acl`, `integration`, `publishes`,
`subscribes`, `version`, `let`, `in`.

`if`, `then`, `else`, and `when` are also usable as member names; `let` and `in` are reserved only as
the *leading* token of an expression (the `let … in` binding form — see
[Expressions §9.2](/Koine/reference/expressions/#92-syntax)).

:::note[Example]
Every name below parses as a plain field, even though each is a keyword elsewhere:

```koine
context Inventory {
  value Tag {
    quantity:   Int
    version:    Int
    from:       String
    deprecated: String
  }
}
```
:::

### 3.5.3 Contextual (hyphenated) role keywords

The context-map roles are contextual keywords whose hyphen is part of the spelling — they match the
Evans DDD vocabulary verbatim and are legal **only** as a relation role:

`partnership`, `shared-kernel`, `customer-supplier`, `conformist`, `anti-corruption-layer`,
`open-host`, `published-language`.

### 3.5.4 Reserved type names

The four built-in generic constructors — `List`, `Set`, `Map`, `Range` — cannot be reused as your own
type names. Declaring a `value`, `entity`, `enum`, `quantity`, or `module` with one of these names
raises `KOI0908` (`ReservedTypeName`).

## 3.6 Literals

```ebnf
IntLiteral     : [0-9]+ ;
DecimalLiteral : [0-9]+ '.' [0-9]+ ;
StringLiteral  : '"' ( ~["\\] | '\\' . )* '"' ;
BoolLiteral    : 'true' | 'false' ;
Regex          : '/' ( ~[/\r\n\\] | '\\' . )* '/' ;   // only after `matches`
```

- **Integer** literals are one or more digits.
- **Decimal** literals require digits on both sides of the dot (`0.9`, `10.0`) and carry **no
  suffix**; the C# emitter adds the `m` suffix when the target type is `Decimal`.
- **String** literals are double-quoted and accept `\`-escapes.
- **Boolean** literals are `true` and `false`.
- **Regex** literals are written `/pattern/` and are only lexed after the `matches` keyword, which
  switches the lexer into regex mode. Outside that position `/` is the division operator.

:::caution
There is **no `null` literal** in Koine. Absence is modelled with optional fields (`String?`) and the
`??`, `.isPresent`, and `.isNone` forms — see
[Expressions](/Koine/reference/expressions/#910-optionality).
:::

## 3.7 Operators and punctuators

| Token | Role |
| --- | --- |
| `{` `}` `(` `)` | grouping / block delimiters |
| `,` `:` `.` | separators and member access |
| `=` | declaration default (`status: OrderStatus = Draft`) |
| `->` | state effect — factory init and command/state transition |
| `<->` | bidirectional context-map relation |
| `=>` | lambda arrow (`l => l.quantity`) |
| `??` | null-coalescing over optionals |
| `?` | optional-type marker (`String?`) |
| `@` | annotation prefix (`@since(2)`) |
| `==` `!=` `<` `<=` `>` `>=` | equality and relational comparison |
| `+` `-` `*` `/` | arithmetic |
| `&&` `\|\|` `!` | boolean logic |

`->`, `<->`, `=>`, `??`, and the comparison operators are **single atomic tokens** — never split them
with internal whitespace. Because of maximal munch, write `status -> Submitted`, not
`status - > Submitted` (which lexes as minus then greater-than).

## 3.8 Annotations

```ebnf
annotation
    : '@' Identifier ( '(' ( IntLiteral | StringLiteral ) ')' )?
    ;
```

An annotation is `@` followed by an ordinary identifier (so `since`/`deprecated` remain usable as
field names). Only `@since(n)` (integer argument) and `@deprecated("reason")` (string argument) are
recognized; any other `@name` parses but is silently ignored. See
[Model versioning & evolution](/Koine/reference/versioning/).
