# Domain Documentation

Living documentation generated from the Koine model. Each bounded context has its own
page with the ubiquitous language, aggregates, and Mermaid diagrams of its lifecycles.

## Bounded Contexts

- [Catalog](./Catalog.md) — version 2
- [Customers](./Customers.md) — version 1
- [Legacy](./Legacy.md) — version 1 — Legacy bounded context — an external payment gateway whose model we do not control. Payments shields itself from it with an anti-corruption layer (R14.2).
- [Ordering](./Ordering.md) — version 1 — Ordering bounded context — placing and pricing customer orders.
- [Payments](./Payments.md) — version 1 — Payments bounded context — authorizing and capturing money for orders.
- [Shipping](./Shipping.md) — version 1 — Shipping bounded context — getting orders to customers.

## Strategic Views

- [Context Map](./context-map.md) — the strategic relationships between contexts
- [Integration Events](./integration-events.md) — cross-context published-language flows
