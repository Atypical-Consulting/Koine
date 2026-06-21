# Legacy — version 1

Legacy bounded context — an external payment gateway whose model we do not control. Payments shields itself from it with an anti-corruption layer (R14.2).

## Domain Types

### GatewayResult — value object

The raw result the legacy gateway returns. Payments never references this directly — it goes through the generated translator interface.

| Field | Type | Description |
| --- | --- | --- |
| rawReference | `String` |  |
| rawAmount | `Decimal` |  |
