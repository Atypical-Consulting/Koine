//! Hand-written driver for the Rust demo (issue #1073).
//!
//! Constructs the generated `Order` aggregate (with `OrderLine` value objects and an
//! `OrderStatus` enum) from `templates/starters/ordering` and asserts VALUES -- never emitted
//! formatting or whitespace -- so this demo never churns when the emitter's output shape changes.
//! A clean run (every assertion holds) exits `0`; any failed assertion calls
//! `std::process::exit(1)` so a red run is unmissable.
//!
//! KNOWN GAPS (see reference/README.md and ../README.md "What this demo does NOT prove"):
//!
//! 1. `templates/starters/ordering`'s `states status { ... }` block has no paired `command`
//!    declarations, so -- per the documented Koine semantics ("the block by itself emits nothing;
//!    its effect appears wherever a command assigns that field") -- the emitted `Order` has no
//!    transition method and no runtime guard. This demo therefore does not assert that an illegal
//!    transition (e.g. Draft -> Shipped) is rejected, because nothing in the emitted code rejects
//!    it. This is a property of the *template*, not a Rust-emitter bug -- identical to the
//!    TypeScript, Python, and PHP demos of this same template.
//!
//! 2. RUST-SPECIFIC GAP (unlike the other three targets): the emitted `Order::new(id, lines)` has
//!    NO `status` parameter at all -- it unconditionally initializes `status: OrderStatus::Draft`
//!    inside the constructor body. The C#/TypeScript/Python/PHP emitters all render an *optional*
//!    trailing `status` constructor parameter that defaults to `Draft` (e.g. TypeScript's
//!    `constructor(id, lines, status = OrderStatus.Draft)`, PHP's `status: OrderStatus =
//!    OrderStatus::DRAFT`), so those demos construct a `Placed`/`Shipped` `Order` directly. The
//!    Rust emitter drops the default-valued `status` field from the generated `new(...)` signature
//!    entirely -- a real Rust-emitter parity gap, flagged here rather than fixed (this demo does
//!    not touch `src/Koine.Emit.Rust/`, per this issue's scope). This driver works around it by
//!    exercising the `OrderStatus` enum's `Draft`/`Placed`/`Shipped`/`Cancelled` values directly
//!    (they are public, freestanding, and constructible with zero dependency on `Order`) instead
//!    of embedding them in a freshly-built `Order`, and only asserts entity-identity equality for
//!    "same id, different lines" rather than "same id, different status" (which the constructor
//!    cannot express). See reference/README.md for the exact repro and the follow-up this
//!    warrants.

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

    // --- Order: construction with two lines defaults to Draft (Order::new has no `status`
    // parameter at all -- see KNOWN GAP 2 above). ---
    let order_id = OrderId::new("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let draft_order = Order::new(order_id.clone(), vec![line1.clone(), line2.clone()])
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

    // --- Order identity: equality is by id, not by structural contents (aggregate roots are
    // entities). Order::new has no `status` override (KNOWN GAP 2), so both instances below are
    // Draft; this still proves identity ignores `lines` contents, just not `status`. ---
    let same_id_different_lines = Order::new(order_id.clone(), vec![line1.clone()])
        .expect("same_id_different_lines declares no invariants, so construction cannot fail");
    check(
        draft_order == same_id_different_lines,
        "two Order instances with the same id must be equal regardless of their lines contents \
         (entity identity)",
    );

    let different_order_id = OrderId::new("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let different_order = Order::new(different_order_id, vec![line1.clone(), line2.clone()])
        .expect("different_order declares no invariants, so construction cannot fail");
    check(
        draft_order != different_order,
        "two Order instances with different ids must not be equal",
    );

    // --- OrderStatus: the Draft/Placed/Shipped/Cancelled lifecycle values are all constructible
    // (as freestanding enum values -- see KNOWN GAP 2 above for why this driver cannot embed them
    // in an Order) and mutually distinguishable, and round-trip through the generated
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

    if failures > 0 {
        eprintln!("{failures} assertion(s) failed.");
        std::process::exit(1);
    }

    println!("Rust demo: all assertions passed.");
}
