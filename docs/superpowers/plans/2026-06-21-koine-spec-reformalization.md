# Koine Spec Reformalization (Pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reformalize Koine's `website/` "Language reference" into a C#-spec-style "Language specification" — establish the conventions, add the missing foundational chapters, and convert two pilot construct pages onto a Syntax → Semantics → Translation template.

**Architecture:** Pure documentation change inside the Astro Starlight site (`website/`). We add three new foundational pages (§2 Notation, §3 Lexical structure, §A Keyword index), rework `overview.md` into §1, reformalize §5 Value objects and §9 Expressions, and rewire the sidebar (rename the group, number entries, relocate Templates). No compiler/test code changes.

**Tech Stack:** Astro + Starlight (MDX/Markdown), Expressive Code fences, the repo's `koine` TextMate grammar; Node/npm for the build; the Koine CLI for snippet spot-checks.

> **This is a documentation task, so the "tests" are not unit tests.** Each task's verification is: (a) `cd website && npm run build` succeeds; (b) where a task adds a `.koi` snippet, it compiles with the Koine CLI; (c) a cross-reference/anchor audit in the final task. There is no xUnit involvement and the .NET test suite is untouched.

## Global Constraints

These apply to **every** task. Copy values verbatim.

- **Pragmatic-formal only:** never use conformance vocabulary (`shall`/`should`/`may`) and never tag text as "normative"/"informative". Precise descriptive prose only.
- **Stable chapter per page:** never renumber an existing page; a future chapter **appends** the next free number. The chapter→page mapping is fixed: §1 overview · §2 notation · §3 lexical-structure · §4 contexts-and-types · §5 value-objects · §6 entities-and-identity · §7 aggregates · §8 enums · §9 expressions · §10 invariants · §11 commands-events-state · §12 factories · §13 specs-services-policies · §14 repositories-concurrency · §15 application-cqrs · §16 multi-file-imports-modules · §17 context-maps-integration · §18 versioning · §A keyword-index.
- **Preserve all `reference/` slugs/URLs.** Only sidebar labels, in-page section anchors, and page interiors change. New pages get new slugs.
- **Page title (H1) is clean and unnumbered** (e.g. `title: "Value objects"`). **Section headings carry the chapter-prefixed number** (`## 5.1 General`, `### 5.2.1 Fields`). **Sidebar labels are numbered** `N · Title`.
- **Cross-references** use the `§` glyph in link text and number+slug in the href: `[§5.2](/Koine/reference/value-objects/#52-syntax)`. Anchors are GitHub-slugger form of the heading text (lowercase, spaces→`-`, punctuation dropped): `## 5.2 Syntax` → `#52-syntax`.
- **Grammar** is shown in ` ```ebnf ` fenced blocks, **hand-curated** from `src/Koine.Compiler/Grammar/KoineLexer.g4` + `KoineParser.g4`, which remain canonical.
- **Notes/examples** use Starlight asides: `:::note`, `:::note[Example]`, `:::caution`, `:::tip` — not raw `> *Note*:` blockquotes.
- **Commit identity (required):** `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."`.
- **Scope is the pilot:** build §1, §2, §3, §5, §9 and a seeded §A; renumber the whole sidebar. Do **not** reformalize the other construct pages (their interiors are deferred to a follow-up plan).

---

## File Structure

**Create:**
- `website/src/content/docs/reference/notation.md` — §2 Notation & conventions.
- `website/src/content/docs/reference/lexical-structure.md` — §3 Lexical structure.
- `website/src/content/docs/reference/keyword-index.md` — §A Keyword & operator index (seeded).

**Modify:**
- `website/src/content/docs/reference/overview.md` — rework into §1 "About this specification".
- `website/src/content/docs/reference/value-objects.md` — reformalize as §5.
- `website/src/content/docs/reference/expressions.md` — reformalize as §9.
- `website/astro.config.mjs` — rename the "Language reference" sidebar group to "Language specification", number all entries, add the three new pages, relocate Templates under Guides.

**Read-only references (do not edit):**
- `src/Koine.Compiler/Grammar/KoineLexer.g4`, `KoineParser.g4` — canonical grammar; source for all EBNF.

---

## Task 1: Baseline — confirm the site builds green

**Files:** none changed (verification only).

**Interfaces:**
- Produces: the canonical verification command (`cd website && npm run build`) reused by every later task.

- [ ] **Step 1: Install deps if needed**

Run: `cd website && npm install`
Expected: completes without error (skip/fast if `node_modules` already present).

- [ ] **Step 2: Build the site to capture a known-good baseline**

Run: `cd website && npm run build`
Expected: build completes, prints the generated page count, exits 0. If it fails *before any change*, stop and report — the environment is broken, not the plan.

- [ ] **Step 3: No commit** (nothing changed). Proceed to Task 2.

---

## Task 2: §2 Notation & conventions (new page)

**Files:**
- Create: `website/src/content/docs/reference/notation.md`

**Interfaces:**
- Produces: the conventions every other spec page cites — anchors `#21-how-this-specification-is-organized`, `#22-grammar-notation`, `#23-section-numbering-and-cross-references`, `#24-notes-examples-and-callouts`, `#25-diagnostics`, `#26-emitted-c`.

- [ ] **Step 1: Create the page with this exact content**

````markdown
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

This deliberately separates *what you write* (Syntax) from *what it means* (Semantics) and *what it
becomes* (Translation). Koine's semantic model is target-agnostic; C# is the only shipped target
today, so every "Translation" section describes the current C# emission, not the language itself.

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
language is target-agnostic, the same model can drive other emitters (TypeScript is in progress); only
the Translation sections are C#-specific.
````

- [ ] **Step 2: Build**

Run: `cd website && npm run build`
Expected: PASS (new page builds; an orphan page not yet in the sidebar is fine).

- [ ] **Step 3: Commit**

```bash
git add website/src/content/docs/reference/notation.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): add §2 Notation & conventions"
```

---

## Task 3: §3 Lexical structure (new page)

**Files:**
- Create: `website/src/content/docs/reference/lexical-structure.md`
- Reference (read): `src/Koine.Compiler/Grammar/KoineLexer.g4`

**Interfaces:**
- Produces: anchors `#31-general`, `#32-source-text-and-whitespace`, `#33-comments`, `#34-identifiers`, `#35-keywords`, `#36-literals`, `#37-operators-and-punctuators`, `#38-annotations`. §1 and §A link here.

- [ ] **Step 1: Create the page with this exact content** (facts are taken verbatim from `KoineLexer.g4`)

````markdown
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
DocComment   : '///' ~[/\r\n] ~[\r\n]* ;   // documentation comment
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
````

- [ ] **Step 2: Build**

Run: `cd website && npm run build`
Expected: PASS.

- [ ] **Step 3: Verify the keyword example compiles**

```bash
cat > /tmp/lex-check.koi <<'KOI'
context Inventory {
  value Tag {
    quantity:   Int
    version:    Int
    from:       String
    deprecated: String
  }
}
KOI
dotnet run --project src/Koine.Cli -- build /tmp/lex-check.koi
```
Expected: parses + validates with no errors (no `--out`, so it is validate-only).

- [ ] **Step 4: Commit**

```bash
git add website/src/content/docs/reference/lexical-structure.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): add §3 Lexical structure"
```

---

## Task 4: §A Keyword & operator index (new, seeded)

**Files:**
- Create: `website/src/content/docs/reference/keyword-index.md`

**Interfaces:**
- Consumes: anchors defined in §3 (`lexical-structure`), §5 (`value-objects`), §9 (`expressions`).
- Produces: the appendix page slug `reference/keyword-index`.

- [ ] **Step 1: Create the page with this exact content**

````markdown
---
title: "Keyword & operator index"
description: "Alphabetical index of Koine keywords and operators, linking to where each is defined."
---

An alphabetical index of Koine's keywords and operators, each linking to the section that defines it.

:::note
This index is populated as chapters are reformalized. Entries below cover the lexical structure
([§3](/Koine/reference/lexical-structure/)), value objects
([§5](/Koine/reference/value-objects/)), and expressions
([§9](/Koine/reference/expressions/)); the remaining construct chapters are added as they land.
:::

## Keywords

| Keyword | Kind | Defined in |
| --- | --- | --- |
| `invariant` | reserved | [§3.5.1](/Koine/reference/lexical-structure/#351-reserved-keywords), [§5.3](/Koine/reference/value-objects/#53-semantics) |
| `matches` | reserved | [§3.5.1](/Koine/reference/lexical-structure/#351-reserved-keywords), [§9.8](/Koine/reference/expressions/#98-pattern-matching) |
| `value` | soft (declaration) | [§5.2](/Koine/reference/value-objects/#52-syntax) |
| `quantity` | soft (declaration) | [§5.5](/Koine/reference/value-objects/#55-quantities) |
| `let` … `in` | soft (leading expression) | [§9.2](/Koine/reference/expressions/#92-syntax) |
| `if` / `then` / `else` | conditional expression | [§9.6](/Koine/reference/expressions/#96-conditionals) |
| `when` | guard operator | [§9.7](/Koine/reference/expressions/#97-guards) |

## Operators and punctuators

| Operator | Meaning | Defined in |
| --- | --- | --- |
| `=` | declaration default | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) |
| `->` | state effect (init / transition) | [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) |
| `=>` | lambda arrow | [§9.9](/Koine/reference/expressions/#99-collection-operations) |
| `??` | coalesce | [§9.10](/Koine/reference/expressions/#910-optionality) |
| `+` `-` `*` `/` | arithmetic | [§9.4](/Koine/reference/expressions/#94-arithmetic) |
| `== != < <= > >=` | comparison | [§9.5](/Koine/reference/expressions/#95-comparison) |
| `&& \|\| !` | boolean logic | [§9.3](/Koine/reference/expressions/#93-logical-operators) |
| `matches /…/` | regex match | [§9.8](/Koine/reference/expressions/#98-pattern-matching) |
````

- [ ] **Step 2: Build**

Run: `cd website && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add website/src/content/docs/reference/keyword-index.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): seed §A Keyword & operator index"
```

---

## Task 5: §1 — rework `overview.md` into "About this specification"

**Files:**
- Modify: `website/src/content/docs/reference/overview.md`

**Interfaces:**
- Consumes: §2 (`notation`) and §3 (`lexical-structure`) anchors created in Tasks 2–3.
- Produces: the spec landing page. Keeps slug `reference/overview`.

This task is a **transform**, not a rewrite. Read the current file first. Keep the construct map and primitive-types tables; relocate the lexical material; add a "How to read this specification" pointer.

- [ ] **Step 1: Change the frontmatter title**

Replace:
```yaml
title: "Language reference overview"
description: "A map of every Koine construct and where to read about it."
```
with:
```yaml
title: "About this specification"
description: "What this specification covers, how to read it, and a map of every Koine construct."
```

- [ ] **Step 2: Add a "How to read this specification" section** immediately after the opening paragraph and before `## How the language is shaped`:

```markdown
## How to read this specification

Each construct chapter follows a fixed **General → Syntax → Semantics → Translation** structure, uses
EBNF for grammar, and cites sections with the `§` glyph. The full set of conventions — grammar
notation, numbering, callouts, and diagnostics — is described in
[Notation & conventions (§2)](/Koine/reference/notation/). The token-level rules (comments,
identifiers, keywords, literals, operators) live in
[Lexical structure (§3)](/Koine/reference/lexical-structure/).
```

- [ ] **Step 3: Replace the "Reserved words and the soft-keyword rule" section and the "A note on operator spacing" section with pointers.** Delete the bodies of both sections (the soft-keyword lists, reserved-type-names, annotations, and the `->`/`<->` spacing prose now live in §3) and replace the two `##` sections with a single pointer section:

```markdown
## Tokens, keywords, and operators

The lexical layer — comments, identifiers, the reserved (`invariant`, `matches`) vs soft keyword
rule, reserved type names, literals, and the atomic `->` / `<->` operators — is specified in
[Lexical structure (§3)](/Koine/reference/lexical-structure/).
```

- [ ] **Step 4: Keep** the `## How the language is shaped`, `## The construct map`, and `## Primitive types` sections as-is (they remain the navigational heart of §1). Leave the `## Where to next` section.

- [ ] **Step 5: Build**

Run: `cd website && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add website/src/content/docs/reference/overview.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): rework overview into §1 About this specification"
```

---

## Task 6: §5 — reformalize `value-objects.md` (pilot)

**Files:**
- Modify: `website/src/content/docs/reference/value-objects.md`
- Reference (read): `src/Koine.Compiler/Grammar/KoineParser.g4` (`valueDecl`, `member`, `invariant`, `typeRef`)

**Interfaces:**
- Consumes: §2, §3 anchors; links to §9 (`expressions`), §6 (`entities-and-identity`), §4 (`contexts-and-types`), §10 (`invariants`).
- Produces: anchors `#51-general`, `#52-syntax`, `#53-semantics`, `#54-translation-to-c`, `#55-quantities`, `#56-example`.

This is a **transform**: keep the existing prose and code blocks, reorganize them under the numbered S/S/T headings, add the EBNF, and rewrite cross-references to `§` form. Read the current file first.

- [ ] **Step 1: Restructure the page to this heading skeleton** (move existing content under the matching heading; keep the `title:` frontmatter as `"Value objects"`):

```
## 5.1 General
    ← the opening "A value object is a small immutable type…" paragraph.
## 5.2 Syntax
    ← the EBNF block from Step 2, then the `value Price { … }` snippet that opens the page today.
## 5.3 Semantics
    ← "What you get" table; the :::note about positional construction & eager validation;
      "Validating constructors"; "Derived (computed) fields"; "Defensive copies of collections".
      (Keep their .koi/csharp examples.)
## 5.4 Translation to C#
    ← the emitted `public sealed class Price : ValueObject { … }` block and the paragraph about the
      ValueObject base; "Scalar arithmetic operators" (demand-driven operators) belongs here too.
### 5.4.1 Scalar arithmetic operators
    ← the "Scalar arithmetic operators" subsection.
## 5.5 Quantities
    ← the "Quantities: unit-checked arithmetic" subsection (promoted to a top-level §5.5).
## 5.6 Example
    ← the "A complete example" Catalog context.
## See also
    ← keep, but rewrite links to § form (Step 4).
```

- [ ] **Step 2: Insert this EBNF block at the top of `## 5.2 Syntax`** (curated from `valueDecl`/`member`/`invariant`/`typeRef`):

````markdown
A value object is declared with the `value` keyword (a `quantity` — [§5.5](#55-quantities) — shares
the same body grammar):

```ebnf
value_declaration
    : 'value' Identifier '{' member* invariant* '}'
    ;

member
    : Identifier ':' type_ref ( '=' expression )?   // '= expression' makes it a derived field
    ;

invariant
    : 'invariant' expression StringLiteral?         // the string is the failure message
    ;

type_ref
    : Identifier ( '<' type_ref ( ',' type_ref )? '>' )? '?'?   // T, List<T>, Map<K,V>, T?
    ;
```

A `member` with an `= expression` initialiser that references sibling fields is a **derived field**
([§5.3](#53-semantics)); without it, the member is a constructor parameter. The expression grammar is
specified in [Expressions (§9)](/Koine/reference/expressions/).
````

- [ ] **Step 3: Convert the in-prose callouts** that are plain notes/tips to the spec aside convention if not already (`:::note`, `:::tip`, `:::caution` are already used — leave them). Add one `:::note[Example]` wrapper is **not** required; the closing `## 5.6 Example` section suffices.

- [ ] **Step 4: Rewrite every cross-reference to `§` form.** Replace the bare links in the body and "See also" with section-cited links:
  - `[Invariants](/Koine/reference/invariants/)` → `[Invariants (§10)](/Koine/reference/invariants/)`
  - `[entity](/Koine/reference/entities-and-identity/)` / `[entities & identity]` → `[Entities & identity (§6)](/Koine/reference/entities-and-identity/)`
  - `[Contexts & types](/Koine/reference/contexts-and-types/)` / `[type mapping]` → `[Contexts & types (§4)](/Koine/reference/contexts-and-types/)`
  - `[Expressions](/Koine/reference/expressions/)` → `[Expressions (§9)](/Koine/reference/expressions/)`

- [ ] **Step 5: Build**

Run: `cd website && npm run build`
Expected: PASS.

- [ ] **Step 6: Verify the Catalog example still compiles**

```bash
# paste the §5.6 Catalog context into the file below, then:
dotnet run --project src/Koine.Cli -- build /tmp/vo-check.koi
```
Expected: parses + validates with no errors. (If the example uses constructs from other contexts, build validate-only is still expected to pass since it is self-contained.)

- [ ] **Step 7: Commit**

```bash
git add website/src/content/docs/reference/value-objects.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): reformalize §5 Value objects onto the syntax/semantics/translation template"
```

---

## Task 7: §9 — reformalize `expressions.md` (pilot)

**Files:**
- Modify: `website/src/content/docs/reference/expressions.md`
- Reference (read): `src/Koine.Compiler/Grammar/KoineParser.g4` (the `expression` … `primary` chain)

**Interfaces:**
- Consumes: §3 (`lexical-structure`) anchors; links to §5, §10, §11, §12, §13, §15.
- Produces: anchors `#91-general`, `#92-syntax`, `#93-logical-operators`, `#94-arithmetic`, `#95-comparison`, `#96-conditionals`, `#97-guards`, `#98-pattern-matching`, `#99-collection-operations`, `#910-optionality`, `#911-translation-to-c`.

This is a **transform** plus two additions: the **operator-precedence table** and the **`let … in`** form (present in the grammar but undocumented today). Read the current file first.

- [ ] **Step 1: Restructure to this heading skeleton** (keep `title: "Expressions"`):

```
## 9.1 General
    ← the "Koine has one small, pure expression language…" intro + the "Where expressions are
      allowed" table.
## 9.2 Syntax
    ← the EBNF chain (Step 2) + the precedence table (Step 3) + "Literals and identifiers".
## 9.3 Logical operators        ← existing "Logical operators".
## 9.4 Arithmetic               ← the arithmetic half of "Arithmetic and comparison".
## 9.5 Comparison               ← the comparison half (orderable rule) + "Instant comparison".
## 9.6 Conditionals             ← existing "Conditionals".
## 9.7 Guards                   ← new short section for the `when` guard (Step 4).
## 9.8 Pattern matching         ← the `matches /…/` material (currently under the :::tip in
                                  "String operations"); state the regex form here.
## 9.9 Collection operations    ← existing "Collection operations" (incl. lambda `=>`).
   ### 9.9.1 String operations  ← existing "String operations".
## 9.10 Optionality             ← existing "Optionality" (`??`, `.isPresent`, `.isNone`, no null).
## 9.11 Translation to C#       ← a short consolidating section: each form's emitted C# is shown
                                  inline above; restate that derived fields → get-only properties and
                                  invariants → constructor guards.
## See also
```

Fold the existing "Operator spacing: `->` and `<->` are atomic tokens" section into a one-line pointer to [§3.7](/Koine/reference/lexical-structure/#37-operators-and-punctuators) (the atomic-token rule is now specified in Lexical structure).

- [ ] **Step 2: Insert this EBNF chain at the top of `## 9.2 Syntax`** (curated verbatim from the `expression`…`primary` productions):

````markdown
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
````

- [ ] **Step 3: Insert this operator-precedence table** immediately after the EBNF in §9.2 (derived directly from the grammar's precedence climb, lowest → highest):

```markdown
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
```

- [ ] **Step 4: Add the new `## 9.7 Guards` section**:

````markdown
A boolean expression may be qualified with a `when` guard, written `body when condition`. The guard is
how a conditional invariant reads: the `body` is only required to hold *when* the `condition` is true.

```koine
invariant status == Draft when lines.isEmpty   "an empty order must stay in Draft"
```

`when` sits just above the conditional expression in precedence ([§9.2](#92-syntax)) and is
non-associative — a single optional guard per expression.
````

- [ ] **Step 5: Rewrite cross-references to `§` form** in the body and "See also":
  - `[Value objects]` → `[Value objects (§5)](/Koine/reference/value-objects/)`
  - `[Invariants]` → `[Invariants (§10)](/Koine/reference/invariants/)`
  - `[Commands, events & state]` → `[Commands, events & state machines (§11)](/Koine/reference/commands-events-state/)`
  - `[Factories]` → `[Factories (§12)](/Koine/reference/factories/)`
  - `[Specs, services & policies]` → `[Specifications, services & policies (§13)](/Koine/reference/specs-services-policies/)`
  - `[read-model projections]` / `[application-cqrs]` → `[Application layer & CQRS (§15)](/Koine/reference/application-cqrs/)`

- [ ] **Step 6: Build**

Run: `cd website && npm run build`
Expected: PASS.

- [ ] **Step 7: Verify a `let … in` snippet compiles** (guards against documenting a non-existent form)

```bash
cat > /tmp/expr-check.koi <<'KOI'
context Billing {
  enum Currency { EUR, USD }
  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "an amount cannot be negative"
  }
  value Line {
    unitPrice: Money
    quantity:  Int
    total:     Money = let net = unitPrice * quantity in net
  }
}
KOI
dotnet run --project src/Koine.Cli -- build /tmp/expr-check.koi
```
Expected: parses + validates with no errors. If `let … in` is rejected, **stop** and remove the `let` material from §9 rather than documenting an unsupported form.

- [ ] **Step 8: Commit**

```bash
git add website/src/content/docs/reference/expressions.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): reformalize §9 Expressions with grammar, precedence table, and let…in"
```

---

## Task 8: Sidebar — rename group, number entries, add new pages, relocate Templates

**Files:**
- Modify: `website/astro.config.mjs` (the `sidebar` array, ~lines 108–162)

**Interfaces:**
- Consumes: every spec page slug, including the three created in Tasks 2–4.

- [ ] **Step 1: Replace the entire `Language reference` sidebar group** (currently `{ label: 'Language reference', items: [ … 17 entries … ] }`) with this numbered "Language specification" group. Note: `notation`, `lexical-structure`, and `keyword-index` are added; `templates` is **removed from this group** (it moves to Guides in Step 2):

```js
{
    label: 'Language specification',
    items: [
        { label: '1 · About this specification', slug: 'reference/overview' },
        { label: '2 · Notation & conventions', slug: 'reference/notation' },
        { label: '3 · Lexical structure', slug: 'reference/lexical-structure' },
        { label: '4 · Contexts & the type system', slug: 'reference/contexts-and-types' },
        { label: '5 · Value objects', slug: 'reference/value-objects' },
        { label: '6 · Entities & identity', slug: 'reference/entities-and-identity' },
        { label: '7 · Aggregates', slug: 'reference/aggregates' },
        { label: '8 · Enumerations', slug: 'reference/enums' },
        { label: '9 · Expressions', slug: 'reference/expressions' },
        { label: '10 · Invariants', slug: 'reference/invariants' },
        { label: '11 · Commands, events & state machines', slug: 'reference/commands-events-state' },
        { label: '12 · Factories', slug: 'reference/factories' },
        { label: '13 · Specifications, services & policies', slug: 'reference/specs-services-policies' },
        { label: '14 · Repositories & concurrency', slug: 'reference/repositories-concurrency' },
        { label: '15 · Application layer & CQRS', slug: 'reference/application-cqrs' },
        { label: '16 · Multi-file models, imports & modules', slug: 'reference/multi-file-imports-modules' },
        { label: '17 · Context maps & integration', slug: 'reference/context-maps-integration' },
        { label: '18 · Model versioning & evolution', slug: 'reference/versioning' },
        { label: 'A · Keyword & operator index', slug: 'reference/keyword-index' },
    ],
},
```

- [ ] **Step 2: Add Templates to the `Guides` group.** In the `{ label: 'Guides', items: [ … ] }` array, add as the last entry (the file stays at `reference/templates.md`, so its URL is unchanged — only its sidebar placement moves):

```js
{ label: 'Templates', slug: 'reference/templates' },
```

- [ ] **Step 3: Build** (this is the real test that every slug resolves)

Run: `cd website && npm run build`
Expected: PASS. A wrong slug here fails the build with "couldn't find … in the docs collection".

- [ ] **Step 4: Commit**

```bash
git add website/astro.config.mjs
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): rename reference→specification, number chapters, relocate Templates"
```

---

## Task 9: Final verification — anchors, cross-links, render

**Files:** none changed unless the audit surfaces a fix.

- [ ] **Step 1: Full build**

Run: `cd website && npm run build`
Expected: PASS.

- [ ] **Step 2: List every `§` cross-reference target and every heading in the changed pages** so a human can confirm each link resolves (Starlight does not fail the build on a broken in-page anchor, so this is a manual audit):

```bash
cd website/src/content/docs/reference
echo "=== cross-reference targets ===" && grep -rnoE '/Koine/reference/[a-z0-9-]+/#[a-z0-9-]+' overview.md notation.md lexical-structure.md keyword-index.md value-objects.md expressions.md
echo "=== headings (anchors are slugified heading text) ===" && grep -rnE '^#{2,4} ' overview.md notation.md lexical-structure.md keyword-index.md value-objects.md expressions.md
```
Expected: every `#…` target on the left corresponds to a heading on the right (slugified: lowercase, spaces→`-`, drop `.`/`&`/`§`). Fix any mismatch, rebuild, and amend the relevant commit.

- [ ] **Step 3: Confirm fences render** — open the built site (`cd website && npm run preview`) and spot-check that §3/§5/§9 show `koine` blocks highlighted and `ebnf` blocks as clean monospace, and that the sidebar shows the numbered "Language specification" group with Templates under Guides.
Expected: as described. (If `npm run preview` is unavailable in the environment, rely on Step 1 + Step 2 and note that visual review is pending.)

- [ ] **Step 4: Confirm the .NET suite is unaffected** (sanity — we changed only docs)

Run: `git status --porcelain` 
Expected: only `website/` and `docs/superpowers/` paths appear; no `src/` or `tests/` changes.

- [ ] **Step 5: Commit any audit fixes** (skip if none)

```bash
git add -A website/
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "docs(spec): fix cross-reference anchors from pilot audit"
```

---

## Self-Review (completed during planning)

**Spec coverage:** §2 page → Task 2; §3 page → Task 3; §A seed → Task 4; §1 rework → Task 5; §5 pilot → Task 6; §9 pilot → Task 7; sidebar rename/number/relocate-Templates → Task 8; build + anchor audit verification → Task 9. The page template (spec §5), formatting conventions (spec §6), numbering mechanics (spec §5.2), and pilot scope (spec §7) are all realized. Deferred-by-design: the other construct chapters (spec §8 "out of scope") — not in this plan.

**Placeholder scan:** EBNF and the precedence table are concrete (curated from the actual `.g4`); new-page content is given in full; transform tasks specify exact headings, fragments, and link rewrites. The `let … in` snippet has a compile gate (Task 7 Step 7) so we never ship an unsupported form.

**Type/anchor consistency:** anchor names produced by Tasks 6–7 (e.g. `#92-syntax`, `#98-pattern-matching`, `#910-optionality`) match the links the §A index (Task 4) and cross-references point at; the chapter→slug map in Global Constraints matches the sidebar in Task 8.
