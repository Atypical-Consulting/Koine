# Reformalize the Koine language reference into a C#-spec-style specification

**Status:** Approved design — ready for implementation planning
**Date:** 2026-06-21
**Author:** Philippe Matray (with Claude)
**Area:** `website/` (Astro Starlight docs) — the `reference/` section

---

## 1. Summary

Koine's `website/src/content/docs/reference/` already contains a strong, 18-page,
construct-by-construct reference (~4,450 lines). It is friendly and didactic. This design turns it
into a **language *specification*** that reads with the structural rigor of the
[C# language specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/readme):
§-numbered sections, a published grammar, and a consistent **Syntax → Semantics → Translation** spine
on every construct page — while keeping Koine's readable prose.

The reformalization is **pragmatic-formal**: we adopt the C# spec's *structure* (numbering, grammar
blocks, Note/Example conventions, a clean split between syntax and "what it compiles to"), but **not**
its ISO/ECMA *conformance apparatus* (`shall`/`should`/`may`, normative-vs-informative tagging). The
goal is a precise, navigable, internally-consistent spec — not a standards document.

This effort is a **pilot**: it establishes the conventions, adds the missing foundational chapters,
and reformalizes **two** representative construct pages end-to-end. A follow-up plan applies the
template to the remaining chapters.

### Decisions locked during brainstorming

| Decision | Choice |
| --- | --- |
| Scope | **Reformalize the reference in place** (transform existing pages; not a separate parallel spec section) |
| Formalism | **Pragmatic-formal** — C# *structure*, no ISO conformance language |
| Numbering | **Stable chapter per page** — each page owns a fixed chapter number; new pages append; existing pages never renumber |
| Rollout | **Pilot, then roll out** — template + conventions + foundational pages + 2 pilot pages now; the rest later |

---

## 2. Goals & non-goals

### Goals

- A coherent, §-numbered **Language specification** section with a published, readable grammar.
- A single **canonical page template** (Syntax / Semantics / Translation) applied consistently, so a
  reader can predict where to find any fact about a construct.
- Make implicit knowledge explicit: a real **Lexical structure** chapter, an **operator
  precedence & associativity** table, and a **keyword/operator index** — none of which exist today.
- Preserve all existing `reference/` URLs (no broken inbound links) and Koine's themed, readable prose.

### Non-goals

- No conformance vocabulary (`shall`/`should`/`may`) or normative/informative tagging.
- No build-time grammar generation or heading auto-numbering plugin (numbers are hardcoded — YAGNI).
- No changes to the Start, Tutorials, or Guides sections (beyond possibly relocating the Templates page).
- No renumber-on-insert: per the "stable chapter per page" decision, inserting a future chapter
  appends a new number rather than shifting existing ones.

---

## 3. Current state (baseline)

- **Sidebar** is an *explicit* list in `website/astro.config.mjs` (the `Language reference` group,
  lines ~109–129). Renumbering labels is a localized edit — no autogeneration to fight.
- **Pages** use Starlight **asides** (`:::note`, `:::tip`, `:::caution`) and `:::note[Title]`, plus
  ` ```koine ` / ` ```csharp ` fences (a `koine` TextMate grammar is registered in `astro.config.mjs`).
- **`reference/overview.md`** already holds a lot of latent specification material that today lives
  nowhere formal: the construct map, the **primitive types** table, the **reserved-words / soft-keyword
  rule**, reserved type names, annotations, and **operator spacing** (`->`, `<->`, maximal munch). This
  is harvested into the new foundational chapters rather than rewritten from scratch.
- **Canonical grammar** lives only in code: `src/Koine.Compiler/Grammar/KoineLexer.g4` +
  `KoineParser.g4` (ANTLR; lexer split from parser so `matches /regex/` can use a lexer mode). No EBNF
  is exposed in the docs.
- Existing construct pages follow a loose but recurring shape: intro → `.koi` syntax snippet → "What
  you get" table → emitted C# → per-aspect subsections → "See also". The reformalization regularizes
  this into the explicit Syntax/Semantics/Translation spine.

---

## 4. Information architecture — the numbered chapter map

The sidebar group **"Language reference" is renamed "Language specification."** Every entry is numbered
`N · Title` (matching the existing Tutorials' `1 · …` style). **URLs/slugs under `reference/` do not
change.**

### 4.1 Foundational chapters (built this effort)

| § | Page (slug) | Origin | Contents |
| --- | --- | --- | --- |
| **§1** | About this specification (`reference/overview`) | rework of `overview.md` | Scope, audience, language-vs-emitter relationship, current version, and the construct map as a navigation table. |
| **§2** | Notation & conventions (`reference/notation`, **new**) | new | Grammar notation (ANTLR EBNF; UPPER = lexical, lower = syntactic); the canonical page template; aside & example conventions; the `§` cross-reference convention; how diagnostic codes (`KOI####`) are cited; the stable-numbering rule. |
| **§3** | Lexical structure (`reference/lexical-structure`, **new**) | new + harvested from `overview.md` | Source text & encoding; whitespace & line terminators; comments; identifiers; **keywords** (reserved vs soft/contextual); **literals** (string, number, bool, **regex**); **operators & punctuators** (incl. `->` / `<->` and maximal munch); annotations (`@since`, `@deprecated`). |

### 4.2 Construct chapters (existing pages, renumbered in place)

| § | Page (slug) | Notes |
| --- | --- | --- |
| §4 | Contexts & the type system (`reference/contexts-and-types`) | Absorbs the primitive/built-in types table; documents `context`, `module`, and the type families. |
| **§5** | **Value objects** (`reference/value-objects`) | **Pilot.** |
| §6 | Entities & identity (`reference/entities-and-identity`) | |
| §7 | Aggregates (`reference/aggregates`) | |
| §8 | Enumerations (`reference/enums`) | |
| **§9** | **Expressions** (`reference/expressions`) | **Pilot.** Hosts the operator-precedence & associativity table. |
| §10 | Invariants (`reference/invariants`) | |
| §11 | Commands, events & state machines (`reference/commands-events-state`) | |
| §12 | Factories (`reference/factories`) | |
| §13 | Specifications, services & policies (`reference/specs-services-policies`) | |
| §14 | Repositories & concurrency (`reference/repositories-concurrency`) | |
| §15 | Application layer & CQRS (`reference/application-cqrs`) | |
| §16 | Multi-file models, imports & modules (`reference/multi-file-imports-modules`) | |
| §17 | Context maps & integration (`reference/context-maps-integration`) | |
| §18 | Model versioning & evolution (`reference/versioning`) | |

### 4.3 Appendix

| § | Page (slug) | Notes |
| --- | --- | --- |
| **§A** | Keyword & operator index (`reference/keyword-index`, **new**) | Alphabetical reserved/contextual keywords + operators/punctuators, each linking to its defining §. Seeded this effort (covers what §1–§3, §5, §9 define); completed in the follow-up. |

### 4.4 Templates page

The current `reference/templates.md` documents the `template.json` *manifest*, not the Koine language.
**Proposed:** move it to the **Guides** group so the specification section is purely about the language.
(Low-risk relocation — flag during review if it should stay.)

### 4.5 Interim numbering state

This effort numbers **all** spec pages in the sidebar immediately (so the chapter tree exists), but
only reformalizes the foundational chapters + the two pilots. Untouched construct pages keep today's
prose under their new chapter number until the follow-up plan reaches them. This is an accepted,
temporary inconsistency.

---

## 5. The canonical page template

This is the core of the reformalization and what delivers the requested **syntax-vs-translation split**.
Every construct chapter `§N` follows this spine:

```
§N  <Construct>                 ← page H1 (clean, unnumbered — like the C# spec)
  §N.1  General                 ← what it is, its DDD role (today's friendly intro)
  §N.2  Syntax                  ← hand-curated EBNF production(s) + prose walking each element
  §N.3  Semantics               ← well-formedness rules, defaults, derived members, validation,
                                   equality, and the diagnostics raised (cite KOI####)
  §N.4  Translation to C#       ← the emitted shape ("What you get" table) + generated code
  §N.5+ <Variant sub-constructs>← e.g. Quantities, scalar operators; each folds in its own
                                   mini Syntax/Semantics/Translation as needed
  §N.x  Example                 ← a closing, copy-paste-valid worked example
        See also                ← cross-references
```

### 5.1 Worked skeleton — §5 Value objects (pilot)

```
§5 Value objects                                  (title: "Value objects")
  5.1 General            value objects have no identity; equal by fields; the `value` keyword.
  5.2 Syntax             EBNF for `value` / `quantity` declarations, fields, derived fields,
                         invariants, collection field types.
  5.3 Semantics          immutability; eager validation (constructor guards, declaration order);
                         structural equality & GetEqualityComponents; derived fields excluded from
                         equality & ctor; defensive collection copies; demand-driven scalar operators;
                         diagnostics referenced.
  5.4 Translation to C#  sealed class : ValueObject, get-only props, validating ctor, equality
                         components, derived expression-bodied props, operator overloads.
  5.5 Quantities         unit-checked +/- and scalar */ ; (sub-construct, with its own S/S/T).
  5.6 Example            the `Catalog` context (Sku, Price, Weight, SalePeriod).
      See also           Invariants (§10), Entities (§6), Contexts & types (§4), Expressions (§9).
```

### 5.2 Heading & numbering mechanics

- **Sidebar label:** `5 · Value objects` (number visible for ordering, matching Tutorials' style).
- **Page title / H1:** `Value objects` — clean and unnumbered, exactly like the C# spec, whose H1 is
  the chapter name while sub-headings carry the prefixed numbers.
- **Section headings** carry the chapter prefix and produce deterministic Starlight anchors:
  - `## 5.1 General` → `#51-general`
  - `## 5.2 Syntax` → `#52-syntax`
  - `### 5.2.1 Fields` → `#521-fields`
- **Cross-references** use the `§` symbol in the link text and number+slug in the href:
  `[§5.2](/Koine/reference/value-objects/#52-syntax)`.
- **Numbers are hardcoded** in the heading text. There is no remark/rehype auto-numbering plugin.
  Stability is a *process* guarantee (never renumber existing pages; append new ones), documented in §2.

---

## 6. Formatting conventions (mapped onto Starlight)

These adapt the C# spec's conventions to Koine's existing Starlight theming rather than importing C#'s
raw-markdown forms.

| Element | C# spec form | Koine form (this design) |
| --- | --- | --- |
| Grammar / EBNF | ` ```ANTLR ` fenced block | ` ```ebnf ` fenced block (renders cleanly without a highlighter, like the C# blocks) |
| Note | `> *Note*: … *end note*` blockquote | `:::note` Starlight aside (house style, themed) |
| Caution / Tip | — | keep existing `:::caution` / `:::tip` |
| Example (short) | `> *Example*: … *end example*` | `:::note[Example]` aside |
| Example (worked, long) | blockquote w/ code | a closing `Example` section |
| Term definition | `***term***` | `**term**` bold first-use (current Koine style) |
| Cross-reference | `([§6.2](slug#anchor))` | `[§6.2](/Koine/reference/<slug>/#anchor)` |
| Diagnostics | n/a | cite codes inline, e.g. "raises `KOI0908` (`ReservedTypeName`)" |

### 6.1 Grammar (EBNF) sourcing

The grammar shown in the spec is **hand-curated** from `KoineLexer.g4` + `KoineParser.g4`, simplified
for readability — the same approach the C# spec itself takes (it explicitly does *not* ship the literal
ANTLR reference grammar). **The `.g4` files remain canonical**; §2 states this and points readers to
them. A future automated sync/consistency check is noted as an idea but is **out of scope**.

Illustrative target shape for a `§5.2` production (final wording produced during implementation from
the actual grammar):

```ebnf
value_declaration
    : 'value' identifier '{' value_member* '}'
    ;

value_member
    : field_declaration
    | invariant_declaration
    ;

field_declaration
    : identifier ':' type ('=' expression)?   // '= expression' marks a derived field
    ;
```

---

## 7. Pilot scope (this effort)

**Build:** §1 (rework `overview.md`), §2 (new), §3 (new), and **seed** §A; **renumber the whole spec
sidebar** and rename the group to "Language specification."

**Reformalize two construct pages** end-to-end onto the template:

- **§5 Value objects** — Syntax/Translation-heavy and self-contained; the clearest template exemplar.
- **§9 Expressions** — the richest sublanguage; exercises the grammar approach *and* the
  operator-precedence & associativity table.

**Definition of done (pilot):**

- §1, §2, §3, §5, §9 fully on the new template; §A seeded with the keywords/operators those pages define.
- Sidebar renamed + numbered; Templates relocated to Guides (or kept, per review).
- `cd website && npm run build` succeeds; pilot pages render with correct numbering; all in-page `§`
  cross-references resolve; `koine` fences still highlight.
- Pilot `.koi` snippets remain copy-paste-valid (spot-checked with `koine build`).

---

## 8. Out of scope / follow-up (separate plan)

- Reformalize the remaining construct chapters: §4, §6–§8, §10–§18.
- Complete §A (full keyword/operator index across all chapters).
- (Optional, later) an automated grammar-sync check between the docs EBNF and the `.g4` files.

---

## 9. Verification

- **Build:** `cd website && npm run build` completes without errors.
- **Numbering & anchors:** pilot pages show `5.1/5.2/…`, `9.1/9.2/…`; sidebar shows numbered entries
  under "Language specification".
- **Links:** every in-page `§` cross-reference resolves to a real anchor; no broken internal links on
  the pilot + foundational pages.
- **Highlighting:** ` ```koine ` blocks still syntax-highlight; ` ```ebnf ` blocks render as clean
  monospace.
- **Snippets:** pilot `.koi` examples compile with
  `dotnet run --project src/Koine.Cli -- build <snippet>` (spot check).
- **No regression** to the .NET solution: docs changes do not touch compiler/tests; `dotnet test`
  is unaffected.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Deep-link breakage from changed in-page anchors | Page **URLs/slugs are unchanged**; only intra-page anchors shift. Inbound deep links to specific headings are rare; the pilot proves the new anchor scheme before mass rollout. |
| EBNF drift from canonical `.g4` | Spec states `.g4` is canonical; keep productions minimal/readable; note a future sync check. |
| Half-formalized section during interim | All pages numbered up front so the tree is coherent; only interiors lag, and the follow-up plan closes the gap. |
| Numbering churn if a chapter is inserted later | "Stable chapter per page" rule: new chapters **append** a number; existing pages never renumber. |
| `:::note[Example]` semantics feel like a "note" | Acceptable trade for theming consistency; long examples use a dedicated section instead. |
