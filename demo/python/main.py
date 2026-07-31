"""Hand-written driver for the Python demo (issue #1073).

Constructs the generated `Order` aggregate (with `OrderLine` value objects and an `OrderStatus`
smart enum) from templates/starters/ordering and asserts VALUES -- never emitted formatting or
whitespace -- so this demo never churns when the emitter's output shape changes. A clean run (every
assertion holds) exits 0; any failed assertion calls `sys.exit(1)` so a red run is unmissable.
"""

from __future__ import annotations

import sys
import uuid
from decimal import Decimal

from koine_runtime import DomainInvariantViolationError
from ordering.enums.order_status import OrderStatus
from ordering.order import Order
from ordering.value_objects.order_id import OrderId
from ordering.value_objects.order_line import OrderLine
from ordering.value_objects.product_id import ProductId

failures = 0


def check(condition: bool, message: str) -> None:
    global failures
    if not condition:
        failures += 1
        print(f"ASSERTION FAILED: {message}", file=sys.stderr)


# --- OrderLine: the derived `subtotal` property must equal unit_price * quantity. ---
widget = ProductId(uuid.UUID("11111111-1111-4111-8111-111111111111"))
gadget = ProductId(uuid.UUID("22222222-2222-4222-8222-222222222222"))

line1 = OrderLine(widget, 2, Decimal("19.99"))
line2 = OrderLine(gadget, 3, Decimal("4.50"))

check(
    line1.subtotal == Decimal("39.98"),
    f"line1.subtotal should be 39.98 (2 * 19.99), got {line1.subtotal}",
)
check(
    line2.subtotal == Decimal("13.50"),
    f"line2.subtotal should be 13.50 (3 * 4.50), got {line2.subtotal}",
)

# --- Order: construction with two lines defaults to Draft. ---
order_id = OrderId.new()
draft_order = Order(order_id, (line1, line2))

check(
    draft_order.status is OrderStatus.DRAFT,
    f"a freshly constructed order should default to Draft, got '{draft_order.status.name}'",
)
check(len(draft_order.lines) == 2, f"order should carry both lines, got {len(draft_order.lines)}")
check(draft_order.lines[0] == line1, "the first line should round-trip by value equality")
check(draft_order.lines[1] == line2, "the second line should round-trip by value equality")

# --- Order identity: equality is by id, not by structural contents (aggregate roots are entities). ---
same_id_different_lines = Order(order_id, (line1,), OrderStatus.PLACED)
check(
    draft_order == same_id_different_lines,
    "two Order instances with the same id must be equal regardless of their line/status contents "
    "(entity identity)",
)

different_order = Order(OrderId.new(), (line1, line2))
check(draft_order != different_order, "two Order instances with different ids must not be equal")

# --- OrderStatus: the Draft -> Placed -> Shipped lifecycle values are all constructible and
# distinguishable. ---
placed_order = Order(order_id, (line1, line2), OrderStatus.PLACED)
shipped_order = Order(order_id, (line1, line2), OrderStatus.SHIPPED)

check(placed_order.status is OrderStatus.PLACED, f"expected Placed, got '{placed_order.status.name}'")
check(shipped_order.status is OrderStatus.SHIPPED, f"expected Shipped, got '{shipped_order.status.name}'")
check(
    draft_order.status is not placed_order.status,
    "Draft and Placed must be distinguishable status values",
)

matched = shipped_order.status.match(
    draft=lambda: "unexpected-draft",
    placed=lambda: "unexpected-placed",
    shipped=lambda: "shipped",
    cancelled=lambda: "unexpected-cancelled",
)
check(
    matched == "shipped",
    f"OrderStatus.match should route a Shipped order to its 'shipped' case, got '{matched}'",
)

# --- State machine: a legal Draft -> Placed -> Shipped walk through the generated mutators, and an
# illegal Draft -> Shipped transition rejected by the generated runtime guard. ---
walked_order = Order(OrderId.new(), (line1, line2))
walked_order.place()
check(walked_order.status is OrderStatus.PLACED, f"place() should transition Draft -> Placed, got '{walked_order.status.name}'")
walked_order.ship()
check(walked_order.status is OrderStatus.SHIPPED, f"ship() should transition Placed -> Shipped, got '{walked_order.status.name}'")

illegal_order = Order(OrderId.new(), (line1, line2))
illegal_transition_rejected = False
try:
    illegal_order.ship()
except DomainInvariantViolationError:
    illegal_transition_rejected = True
check(
    illegal_transition_rejected,
    "ship() on a Draft order should raise DomainInvariantViolationError (Draft -> Shipped is not a legal transition)",
)

if failures:
    print(f"{failures} assertion(s) failed.", file=sys.stderr)
    sys.exit(1)

print("Python demo: all assertions passed.")
