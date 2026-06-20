---
title: "Templates"
description: "The templates/ directory — Koine's single, CI-validated source of truth for example domains — and the template.json manifest schema."
---

Koine ships a set of **example domains** as *templates*. The
[`templates/`](https://github.com/Atypical-Consulting/Koine/tree/main/templates) directory is the
**single, CI-validated source of truth** for every example: the demo project, [Koine
Studio](/Koine/guides/koine-studio/)'s template gallery, and the website's inline playground all read from it. There is no second copy to drift.

## What a template is

A template is a **folder** containing:

- one or more `.koi` files — the domain model itself; and
- a `template.json` **manifest** describing it (display name, difficulty, the contexts it defines, and
  the concepts it teaches).

Single-file *starters* hold one `.koi` file; larger domains spread several `.koi` files across bounded
contexts and compile together in **directory mode** (so imports, the context map, and integration
events resolve across files — see [Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/)).

## Validation: a green build proves every template

Every template is exercised by `TemplatesValidationTests`, which on each build:

- **compiles every template green** — so a passing `dotnet test` proves all templates emit compiling C#;
  and
- **validates every `template.json`** against the JSON Schema below — so each one stays well-described,
  with its `id` matching the folder name and its `entryFile` pointing at a real `.koi` file.

## Available templates

Templates carry one of four `difficulty` levels — **starter**, **beginner**, **intermediate**,
**advanced** — used to order and badge them in listings. (All four are valid schema values;
`beginner` is reserved for future templates and unused today.)

| Template | Difficulty | What it models |
|----------|-----------|----------------|
| `starters/billing` | starter | Money, orders, and invariants — the canonical Koine starter |
| `starters/ordering` | starter | An aggregate with a state machine — renders as a diagram |
| `starters/contextmap` | starter | Two bounded contexts and the relationship between them |
| `starters/values` | starter | Smart enums with data, quantities, ranges, and derived fields |
| `ticketing` | intermediate | A help-desk workflow with a ticket lifecycle and a cross-context SLA policy |
| `pizzeria` | intermediate | A six-context pizza shop (menu, ordering, kitchen, delivery, payment, promotions) plus an external Gateway |
| `library` | intermediate | A lending library across five contexts — the Book-vs-BookCopy distinction, loans, reservations, fines |
| `saas-subscription` | advanced | Multi-tenant subscriptions with trials, metered quotas, dunning, and a payment-provider ACL |

The `pizzeria` template is also the one the [demo](https://github.com/Atypical-Consulting/Koine/tree/main/demo)
compiles in place and the one the site's [generated domain reference](/Koine/reference/domain/) is built
from.

## The `template.json` manifest

Each template folder carries a `template.json` validated against
[`templates/template.schema.json`](https://github.com/Atypical-Consulting/Koine/blob/main/templates/template.schema.json).
All fields are required:

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Stable identifier — **must equal the folder name**. |
| `name` | string | Human-readable display name (e.g. `"Billing"`). |
| `tagline` | string | One-line summary shown in template listings. |
| `description` | string | A paragraph describing what the template models and demonstrates. |
| `difficulty` | enum | `starter` · `beginner` · `intermediate` · `advanced` — relative complexity, used to order and badge. |
| `tags` | string[] | Free-form keywords for search and filtering. |
| `contexts` | string[] | The names of the bounded contexts the template defines. |
| `coreAggregate` | string | The headline aggregate that anchors the template. |
| `entryFile` | string | The primary `.koi` file to open first — **must name a file present in the folder**. |
| `teaches` | string[] | The Koine concepts / DDD patterns a learner picks up from this template. |
| `icon` | string | An icon identifier (an emoji or icon name) for the template card. |

### Example

```json
{
  "id": "billing",
  "name": "Billing",
  "tagline": "Money, orders, and invariants — the canonical Koine starter.",
  "description": "A single Billing context with Money, an Order aggregate, and the invariants that keep them honest.",
  "difficulty": "starter",
  "tags": ["value-objects", "invariants", "aggregate"],
  "contexts": ["Billing"],
  "coreAggregate": "Order",
  "entryFile": "billing.koi",
  "teaches": ["value objects", "invariants", "aggregates"],
  "icon": "💶"
}
```

## See also

- [The CLI](/Koine/guides/cli/) — compile any template with `koine build <template-folder>`.
- [Multi-file, imports & modules](/Koine/reference/multi-file-imports-modules/) — how a multi-context
  template compiles as one model.
- [Koine Studio](/Koine/guides/koine-studio/) — the template gallery that browses these.
