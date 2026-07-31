//! Hand-written driver for the Rust demo (issue #1073).
//!
//! Constructs the generated `Order` aggregate (with `OrderLine` value objects and an
//! `OrderStatus` enum) from `templates/starters/ordering` and asserts VALUES -- never emitted
//! formatting or whitespace -- so this demo never churns when the emitter's output shape changes.
//! A clean run (every assertion holds) exits `0`; any failed assertion calls
//! `std::process::exit(1)` so a red run is unmissable.

use koine_domain::koine_runtime::Decimal;
use koine_domain::ordering::{Order, OrderId, OrderLine, OrderStatus, ProductId};
use std::str::FromStr;

fn dec(text: &str) -> Decimal {
    Decimal::from_str(text).unwrap_or_else(|e| panic!("invalid decimal literal {text:?}: {e}"))
}

fn main() {
    let mut failures = 0i32;

    // Records a failed assertion on `failures` and prints it to stderr; never panics, so every
    // assertion in this driver runs and is reported, mirroring the sibling TypeScript/Python/PHP
    // drivers' `assert`/`check` helpers. A closure capturing `failures` by mutable reference, so
    // call sites read the same as those siblings' -- no extra threaded argument.
    let mut check = |condition: bool, message: &str| {
        if !condition {
            failures += 1;
            eprintln!("ASSERTION FAILED: {message}");
        }
    };

    // --- OrderLine: the derived `subtotal()` must equal unit_price * quantity. ---
    let widget = ProductId::new("11111111-1111-4111-8111-111111111111");
    let gadget = ProductId::new("22222222-2222-4222-8222-222222222222");

    let line1 = OrderLine::new(widget.clone(), 2, dec("19.99"))
        .expect("line1 declares no invariants, so construction cannot fail");
    let line2 = OrderLine::new(gadget.clone(), 3, dec("4.50"))
        .expect("line2 declares no invariants, so construction cannot fail");

    check(
        line1.subtotal() == dec("39.98"),
        &format!("line1.subtotal should be 39.98 (2 * 19.99), got {}", line1.subtotal()),
    );
    check(
        line2.subtotal() == dec("13.50"),
        &format!("line2.subtotal should be 13.50 (3 * 4.50), got {}", line2.subtotal()),
    );

    // --- Order: omitting the trailing `status` parameter (`None`) defaults to Draft. ---
    let order_id = OrderId::new("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let draft_order = Order::new(order_id.clone(), vec![line1.clone(), line2.clone()], None)
        .expect("draft_order declares no invariants, so construction cannot fail");

    check(
        draft_order.status() == OrderStatus::Draft,
        &format!(
            "a freshly constructed order should default to Draft, got {:?}",
            draft_order.status()
        ),
    );
    check(
        draft_order.lines().len() == 2,
        &format!("order should carry both lines, got {}", draft_order.lines().len()),
    );
    check(
        draft_order.lines()[0] == line1,
        "the first line should round-trip by value equality",
    );
    check(
        draft_order.lines()[1] == line2,
        "the second line should round-trip by value equality",
    );

    // --- Order: passing `Some(...)` overrides the trailing `status` parameter, constructing a
    // `Placed` order directly (#1380) -- mirroring the sibling TypeScript/Python/PHP drivers'
    // equivalent assertion. ---
    let placed_order = Order::new(
        order_id.clone(),
        vec![line1.clone(), line2.clone()],
        Some(OrderStatus::Placed),
    )
    .expect("placed_order declares no invariants, so construction cannot fail");
    check(
        placed_order.status() == OrderStatus::Placed,
        &format!(
            "overriding the status parameter should construct a Placed order, got {:?}",
            placed_order.status()
        ),
    );

    // --- Order identity: equality is by id, not by structural contents (aggregate roots are
    // entities) -- two orders with the same id are equal regardless of differing `lines` or
    // `status`. ---
    let same_id_different_lines = Order::new(order_id.clone(), vec![line1.clone()], None)
        .expect("same_id_different_lines declares no invariants, so construction cannot fail");
    check(
        draft_order == same_id_different_lines,
        "two Order instances with the same id must be equal regardless of their lines contents \
         (entity identity)",
    );

    let different_order_id = OrderId::new("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let different_order = Order::new(different_order_id, vec![line1.clone(), line2.clone()], None)
        .expect("different_order declares no invariants, so construction cannot fail");
    check(
        draft_order != different_order,
        "two Order instances with different ids must not be equal",
    );

    // --- OrderStatus: the Draft/Placed/Shipped/Cancelled lifecycle values are all constructible
    // as freestanding enum values, mutually distinguishable, and round-trip through the generated
    // `from_name`/`from_value` lookups and the `match_` exhaustive dispatch. ---
    check(
        OrderStatus::from_name("Placed") == Some(OrderStatus::Placed),
        "from_name(\"Placed\") should resolve to OrderStatus::Placed",
    );
    check(
        OrderStatus::from_name("Nope") == None,
        "from_name of an unknown name should return None",
    );
    check(
        OrderStatus::from_value(2) == Some(OrderStatus::Shipped),
        "from_value(2) should resolve to OrderStatus::Shipped",
    );
    check(
        OrderStatus::from_value(99) == None,
        "from_value of an unknown ordinal should return None",
    );
    check(
        OrderStatus::Draft != OrderStatus::Placed,
        "Draft and Placed must be distinguishable status values",
    );

    let matched = OrderStatus::Shipped.match_(
        || "unexpected-draft",
        || "unexpected-placed",
        || "shipped",
        || "unexpected-cancelled",
    );
    check(
        matched == "shipped",
        &format!("OrderStatus::match_ should route Shipped to its 'shipped' case, got '{matched}'"),
    );

    // --- State machine: a legal Draft -> Placed -> Shipped walk through the generated mutators,
    // and an illegal Draft -> Shipped transition rejected by the generated runtime guard. Rust
    // commands return `Result`, not panic, so the illegal transition is asserted via `.is_err()`
    // rather than an unwind. ---
    let walk_id = OrderId::new("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    let mut walked_order = Order::new(walk_id, vec![line1.clone(), line2.clone()], None)
        .expect("walked_order declares no invariants, so construction cannot fail");
    walked_order.place().expect("place() should succeed on a fresh Draft order");
    check(
        walked_order.status() == OrderStatus::Placed,
        &format!("place() should transition Draft -> Placed, got {:?}", walked_order.status()),
    );
    walked_order.ship().expect("ship() should succeed on a Placed order");
    check(
        walked_order.status() == OrderStatus::Shipped,
        &format!("ship() should transition Placed -> Shipped, got {:?}", walked_order.status()),
    );

    let illegal_id = OrderId::new("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    let mut illegal_order = Order::new(illegal_id, vec![line1.clone(), line2.clone()], None)
        .expect("illegal_order declares no invariants, so construction cannot fail");
    check(
        illegal_order.ship().is_err(),
        "ship() on a Draft order should return Err (Draft -> Shipped is not a legal transition)",
    );

    if failures > 0 {
        eprintln!("{failures} assertion(s) failed.");
        std::process::exit(1);
    }

    println!("Rust demo: all assertions passed.");
}
