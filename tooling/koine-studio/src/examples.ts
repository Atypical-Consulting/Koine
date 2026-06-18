// Starter models shown on the welcome screen so a first-time user can open something real with
// one click (and so the Diagrams / Glossary / Context Map tabs have something to show). Each
// source is a compilable .koi model that exercises a different slice of the language; keep them
// small, idiomatic, and green (they double as documentation of the language's shape).

export interface Example {
  id: string;
  name: string;
  /** One-line description shown under the name in the gallery. */
  blurb: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'billing',
    name: 'Billing basics',
    blurb: 'Value objects, invariants, an entity, and an aggregate.',
    source: `context Billing {

  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0        "a monetary amount cannot be negative"
  }

  enum Currency { EUR, USD, GBP }

  value Email {
    raw: String
    invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
  }

  entity Customer identified by CustomerId {
    name: String
    email: Email
  }

  aggregate Order root Order {

    enum OrderStatus { Draft, Placed, Shipped, Cancelled }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      subtotal:  Money = unitPrice * quantity
    }

    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft
      invariant status == Draft when lines.isEmpty
    }
  }
}
`,
  },
  {
    id: 'ordering',
    name: 'Order lifecycle',
    blurb: 'An aggregate with a state machine — renders as a diagram.',
    source: `context Ordering {

  aggregate Order root Order {

    enum OrderStatus { Draft, Placed, Shipped, Cancelled }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Decimal
      subtotal:  Decimal = unitPrice * quantity
    }

    entity Order identified by OrderId {
      lines:  List<OrderLine>
      status: OrderStatus = Draft

      states status {
        Draft   -> Placed
        Placed  -> Shipped
        Placed  -> Cancelled
      }
    }
  }
}
`,
  },
  {
    id: 'contextmap',
    name: 'Strategic context map',
    blurb: 'Two bounded contexts and the relationship between them.',
    source: `context Catalog {
  entity Product identified by ProductId {
    sku:  String
    name: String
  }
}

context Sales {
  value OrderRef {
    value: String
  }
}

contextmap {
  Catalog -> Sales : conformist
}
`,
  },
];
