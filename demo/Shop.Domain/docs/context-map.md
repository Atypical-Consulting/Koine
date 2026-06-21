# Context Map

The strategic relationships between the bounded contexts of this domain.

```mermaid
flowchart LR
    Catalog["Catalog"]
    Customers["Customers"]
    Legacy["Legacy"]
    Ordering["Ordering"]
    Payments["Payments"]
    Shipping["Shipping"]

    Catalog <-->|Shared Kernel| Ordering
    Catalog -->|Conformist| Shipping
    Customers -->|Customer-Supplier| Shipping
    Ordering -->|Open Host| Shipping
    Ordering -->|Open Host| Payments
    Shipping <-->|Partnership| Payments
    Legacy -.->|ACL| Payments
```

## Shared Kernels

- **Catalog & Ordering** — shared types: `Currency`

## Anti-Corruption Layers

- **Legacy -> Payments**
  - `Legacy.GatewayResult` -> `Payments.PaymentReceipt`

## Relationships

- `Catalog <-> Ordering` — Shared Kernel
- `Catalog -> Shipping` — Conformist
- `Customers -> Shipping` — Customer-Supplier
- `Ordering -> Shipping` — Open Host
- `Ordering -> Payments` — Open Host
- `Shipping <-> Payments` — Partnership
- `Legacy -> Payments` — ACL
