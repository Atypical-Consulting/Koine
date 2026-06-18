// Starter models shown on the welcome screen so a first-time user can open something real with
// one click (and so the Diagrams / Glossary / Context Map tabs have something to show). Each
// source is a compilable .koi model that exercises a different slice of the language; keep them
// small, idiomatic, and green (they double as documentation of the language's shape).

/** A single file inside a multi-file example workspace. `relPath` is forward-slashed. */
export interface ExampleFile {
  relPath: string;
  contents: string;
}

export interface Example {
  id: string;
  name: string;
  /** One-line description shown under the name in the gallery. */
  blurb: string;
  /**
   * The model opened in single-file scratch mode. For a multi-file example this is the
   * representative file used as the fallback when the host can't materialize a workspace.
   */
  source: string;
  /**
   * When set, the example opens as a real multi-file workspace (folder mode → the explorer),
   * rather than a single scratch buffer. In directory mode every `.koi` compiles as one model,
   * so the files can span bounded contexts and a context map that references them all.
   */
  files?: ExampleFile[];
}

// --- Pizzeria: a multi-file, multi-context example -----------------------------
// Five .koi files — four bounded contexts plus the strategic context map. Opening it materializes
// a workspace so the file explorer (create/rename/delete/move) has something real to show, and the
// Diagrams / Context Map tabs render the whole pizzeria. Validated green by the CLI.

const PIZZERIA_MENU = `// Menu bounded context — the pizzas and toppings the pizzeria sells.
context Menu {

  enum Size { Small, Medium, Large }

  enum Currency { EUR, USD, GBP }

  value Money {
    amount:   Decimal
    currency: Currency
    invariant amount >= 0   "a price cannot be negative"
  }

  value Topping {
    name:      String
    surcharge: Money
  }

  // A pizza on the menu — the catalog aggregate's root.
  aggregate MenuCatalog root Pizza {
    entity Pizza identified by PizzaId {
      name:       String
      size:       Size = Medium
      basePrice:  Money
      toppings:   List<Topping>
      vegetarian: Bool = false
    }
  }
}
`;

const PIZZERIA_ORDERING = `// Ordering bounded context — a customer's order through its lifecycle.
context Ordering {

  enum OrderStatus { Draft, Placed, InKitchen, OutForDelivery, Delivered, Cancelled }

  aggregate Order root Order {

    value OrderLine {
      pizza:     PizzaId
      quantity:  Int
      unitPrice: Decimal
      subtotal:  Decimal = unitPrice * quantity
      invariant quantity >= 1   "an order line needs at least one pizza"
    }

    entity Order identified by OrderId {
      customer:  CustomerId
      lines:     List<OrderLine>
      status:    OrderStatus = Draft
      total:     Decimal = lines.sum(l => l.subtotal)
      lineCount: Int = lines.count

      invariant status == Draft when lines.isEmpty

      states status {
        Draft          -> Placed, Cancelled
        Placed         -> InKitchen, Cancelled
        InKitchen      -> OutForDelivery
        OutForDelivery -> Delivered
        Delivered
        Cancelled
      }

      command place {
        requires status == Draft  "only a draft order can be placed"
        requires !lines.isEmpty   "cannot place an empty order"
        status -> Placed
      }
    }
  }
}
`;

const PIZZERIA_KITCHEN = `// Kitchen bounded context — preparing the food for a placed order.
context Kitchen {

  enum TicketStatus { Queued, Cooking, Ready }

  aggregate Ticket root Ticket {
    entity Ticket identified by TicketId {
      order:  OrderId
      status: TicketStatus = Queued

      states status {
        Queued  -> Cooking
        Cooking -> Ready
        Ready
      }
    }
  }
}
`;

const PIZZERIA_DELIVERY = `// Delivery bounded context — getting the order to the customer's door.
context Delivery {

  value Address {
    street:   String
    city:     String
    postcode: String
    invariant postcode matches /^[0-9]{4,6}$/   "invalid postcode"
  }

  entity Courier identified by CourierId {
    name: String
  }

  aggregate Dispatch root Shipment {
    enum DeliveryStatus { Assigned, EnRoute, Delivered }

    entity Shipment identified by ShipmentId {
      order:       OrderId
      courier:     CourierId
      destination: Address
      status:      DeliveryStatus = Assigned

      states status {
        Assigned -> EnRoute
        EnRoute  -> Delivered
        Delivered
      }
    }
  }
}
`;

const PIZZERIA_CONTEXT_MAP = `// Strategic view — how the pizzeria's bounded contexts relate.
contextmap {
  Menu     -> Ordering : conformist
  Ordering -> Kitchen  : open-host
  Ordering -> Delivery : open-host
}
`;

export const EXAMPLES: Example[] = [
  {
    id: 'pizzeria',
    name: 'Pizzeria (multi-file)',
    blurb: 'Four bounded contexts + a context map across five files — opens the explorer.',
    source: PIZZERIA_ORDERING,
    files: [
      { relPath: 'menu.koi', contents: PIZZERIA_MENU },
      { relPath: 'ordering.koi', contents: PIZZERIA_ORDERING },
      { relPath: 'kitchen.koi', contents: PIZZERIA_KITCHEN },
      { relPath: 'delivery.koi', contents: PIZZERIA_DELIVERY },
      { relPath: 'context-map.koi', contents: PIZZERIA_CONTEXT_MAP },
    ],
  },
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
