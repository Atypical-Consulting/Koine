---
title: "Notation & conventions"
description: "How to read this specification: the page template, grammar notation, section numbering, and callouts."
---

This page explains the conventions used throughout the Koine language specification. It is the
reference for *how to read* the chapters that follow — the structure of each page, the grammar
notation, how sections are numbered and cross-referenced, and what the callouts mean.

## 2.1 How this specification is organized

Each construct chapter (a value object, an entity, the expression language, …) follows the same
spine, so you can predict where any fact lives:

- **General** — what the construct is and the domain-modelling role it plays.
- **Syntax** — the grammar of the construct, as one or more [EBNF productions](#22-grammar-notation),
  followed by prose describing each part.
- **Semantics** — the rules: well-formedness, defaults, derived members, validation, equality, and
  the [diagnostics](#25-diagnostics) the compiler raises for ill-formed input.
- **Translation to C#** — the C# the current emitter produces for the construct.

Some chapters adapt this spine to their material — the expression language ([§9](/Koine/reference/expressions/)), for example, is organized per operator rather than as a single Translation section.

This deliberately separates *what you write* (Syntax) from *what it means* (Semantics) and *what it
becomes* (Translation). Koine's semantic model is target-agnostic and drives several emitters — C#,
TypeScript, Python, and PHP today, with Rust on the roadmap — so every "Translation" section in this
reference describes the C# emission specifically, not the language itself.

## 2.2 Grammar notation

Grammar is shown in ANTLR-style EBNF in `ebnf` code blocks:

```ebnf
value_declaration
    : 'value' identifier '{' member* invariant* '}'
    ;
```

The conventions:

| Notation | Meaning |
| --- | --- |
| `'value'` | a literal terminal (keyword, operator, or punctuation) |
| `UpperCamel` | a **lexical** token (produced by the lexer — e.g. `Identifier`, `IntLiteral`) |
| `lower_snake` | a **syntactic** rule (produced by the parser) |
| `x?` | zero or one `x` |
| `x*` | zero or more `x` |
| `x+` | one or more `x` |
| `a \| b` | either `a` or `b` |
| `( … )` | grouping |

The grammar shown here is **hand-curated for readability**. The canonical, build-time grammar is the
ANTLR source in
[`KoineLexer.g4`](https://github.com/Atypical-Consulting/Koine/blob/main/src/Koine.Compiler/Grammar/KoineLexer.g4)
and
[`KoineParser.g4`](https://github.com/Atypical-Consulting/Koine/blob/main/src/Koine.Compiler/Grammar/KoineParser.g4);
where this specification simplifies a production for clarity, those files win.

## 2.3 Section numbering and cross-references

Every chapter owns a **fixed chapter number** (shown in the sidebar as `5 · Value objects`). Section
headings within a chapter carry that number as a prefix — `## 5.1 General`, `### 5.2.1 Fields` — and
cross-references cite it with the `§` glyph, linking to the heading anchor:

> See [§5.2](/Koine/reference/value-objects/#52-syntax) for the value-object grammar.

Chapter numbers are **stable**: a new chapter added later takes the next free number; existing
chapters are never renumbered, so anchors and inbound links stay valid.

## 2.4 Notes, examples, and callouts

This specification uses themed asides:

:::note
A **Note** adds clarifying detail that is not essential to the rule being stated.
:::

:::note[Example]
An **Example** illustrates a rule with a concrete `.koi` snippet and, where useful, its emitted C#.
:::

:::caution
A **Caution** flags a sharp edge — something that compiles but may surprise you.
:::

:::tip
A **Tip** offers practical guidance for using a construct well.
:::

## 2.5 Diagnostics

When the compiler rejects ill-formed input it raises a diagnostic with a stable code of the form
`KOI####` and a symbolic name. Semantics sections cite these inline, e.g. "declaring a type named
`List` raises `KOI0908` (`ReservedTypeName`)". The codes are part of the compiler's contract and are
safe to match on in tooling.

## 2.6 Emitted C#

"Translation to C#" sections show idiomatic C# from the current emitter (`Emit/CSharp/`). The emitted
code is snapshot- and compile-tested in the repository, so the shapes shown are real. Because the
language is target-agnostic, the same model drives other emitters too (TypeScript, Python, and PHP
ship today, with Rust on the roadmap); only the Translation sections are C#-specific.
