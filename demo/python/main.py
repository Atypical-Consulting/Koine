"""Hand-written driver for the Python demo (issue #1073).

Constructs the generated `Order` aggregate (with `OrderLine` value objects and an `OrderStatus`
smart enum) from templates/starters/ordering and asserts VALUES -- never emitted formatting or
whitespace -- so this demo never churns when the emitter's output shape changes. A clean run (every
assertion holds) exits 0; any failed assertion calls `sys.exit(1)` so a red run is unmissable.

KNOWN GAP (see ../README.md "What this demo does NOT prove"): templates/starters/ordering's
`states status { ... }` block has no paired `command` declarations, so -- per the documented Koine
semantics ("the block by itself emits nothing; its effect appears wherever a command assigns that
field") -- the emitted `Order` has no transition method and no runtime guard. This demo therefore
constructs immutable Order snapshots at each lifecycle value instead of driving a mutator, and does
NOT assert that an illegal transition (e.g. Draft -> Shipped) is rejected, because nothing in the
emitted code rejects it. This is a property of the *template* (every other Koine template that uses
`states` pairs it with commands), not a Python-emitter bug -- see the README for the full note.
"""

from __future__ import annotations

import sys
import uuid
from decimal import Decimal

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
# distinguishable (see the KNOWN GAP note above the imports: this does not exercise a runtime
# transition guard, because templates/starters/ordering emits none). ---
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

if failures:
    print(f"{failures} assertion(s) failed.", file=sys.stderr)
    sys.exit(1)

print("Python demo: all assertions passed.")
