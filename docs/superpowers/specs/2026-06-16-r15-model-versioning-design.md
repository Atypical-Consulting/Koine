# Epic R15 — Model Versioning & Evolution (design)

_Status: implemented 2026-06-16. Diagnostic range: KOI1500–1599._

Builds directly on R14's published surfaces (integration events, shared kernel, open-host).
Once published languages exist, they must be able to evolve without silently breaking
downstream consumers. R15 adds explicit version stamping, evolution annotations, and an
automated breaking-change check.

## R15.1 — Version-stamp contexts and annotate evolution

### Surface syntax
```koine
context Sales version 3 {
  @deprecated("use Money") value LegacyMoney { amount: Decimal }
  integration event OrderPlaced {
    orderId: OrderId
    total:   Money
    @since(2) couponCode: String
    @deprecated("use total") legacyAmount: Decimal
  }
}
```

### Decisions
- **Soft keywords.** `version` is a new lexer token (needed for the context clause) added to
  `declKeyword`, so it stays usable as a field name. `since`/`deprecated` are **not** keywords —
  the annotation rule is `AT Identifier (...)`, so they read as ordinary identifiers and remain
  usable as type/field names. (Consistent with the existing rule that a keyword cannot be a *type
  name*; `version` joins `value`, `entity`, … in that set.)
- **Shorthand AST, not a generic annotation list.** The spec defines exactly two annotations, so
  `ContextNode.Version (int?)`, `TypeDecl.Since/Deprecated`, and `Member.Since/Deprecated` are
  modelled as direct properties rather than an open `Annotation[]`. Simpler, type-safe; revisit if
  more annotations land.
- **Emitter renders `@deprecated` only.** `[Obsolete("reason")]` on every deprecated value object,
  entity, smart enum, domain event, integration event, and on each deprecated property (ctor-member
  and derived). `@since` and `version` are documentation-only → glossary, never C#. Aggregate-level
  `@deprecated` has no single emitted class, so it surfaces in the glossary only.
- **Version-ceiling warning (KOI1501).** A `@since(n)` whose `n` exceeds the context's declared
  `version` is a Warning. No-op for an unversioned context (no ceiling to exceed).

## R15.2 — `koine check --baseline <dir>`

A target-agnostic `CompatibilityChecker` (in `Services/`) diffs two `KoineModel`s' **published
surfaces** and the CLI maps the result to an exit code. Tests drive the checker directly.

### Published surface
Keyed so the same contract maps to the same key across both models:
- **Integration events** — always published; key `Context.Type`.
- **Shared-kernel types** — named in a `shared-kernel { … }` relation; key `shared-kernel:Type`
  (the contract is the name, owned jointly by the partners).
- **Open-host types** — value objects and enums of a context that is the **upstream** of an
  `open-host`/`published-language` relation (both endpoints when bidirectional); key `Context.Type`.
  Entities/aggregates are internal and excluded (mirrors R14.2's shareability rule).

### Classification
| Change | Verdict | Code |
| --- | --- | --- |
| Published type removed | breaking | KOI1510 |
| Published field/enum-value removed | breaking | KOI1511 |
| Published field type changed | breaking | KOI1512 |
| Optional field made required | breaking | KOI1513 |
| New required field on existing published type | breaking | KOI1514 |
| New optional field | additive | — |
| New enum value | additive | — |
| New published type/event | additive | — |
| Internal (non-published) change | ignored | — |

- **Type change = breaking (conservative).** Any change to a field's type shape (name + generics,
  ignoring nullability/qualifier) is breaking. This is a safe superset of "narrowing"; without a
  type lattice we do not try to prove a widening is safe.
- **Enums:** removing a value is breaking (a consumer may reference it); adding one is additive.
- The CLI parses both models (syntax only, per "parses both models"), prints breaking changes to
  stderr (`breaking KOIxxxx: …`) and additive ones to stdout, and exits non-zero iff any breaking.
