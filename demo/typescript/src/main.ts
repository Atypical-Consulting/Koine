// Hand-written driver for the TypeScript demo (issue #1073).
//
// Constructs the generated `Order` aggregate (with `OrderLine` value objects and an `OrderStatus`
// smart enum) from templates/starters/ordering and asserts VALUES — never emitted formatting or
// whitespace — so this demo never churns when the emitter's output shape changes. A clean run (every
// assertion holds) exits 0; any failed assertion calls `process.exit(1)` so a red run is unmissable.

import { Order } from '../generated/Ordering/Order.js';
import { OrderLine } from '../generated/Ordering/value-objects/OrderLine.js';
import { OrderIdNew } from '../generated/Ordering/value-objects/OrderId.js';
import { ProductId } from '../generated/Ordering/value-objects/ProductId.js';
import { OrderStatus, OrderStatusMatch } from '../generated/Ordering/enums/OrderStatus.js';
import { Decimal, DomainInvariantViolationError } from '../generated/runtime.js';

// Minimal ambient declaration so this driver type-checks with plain `tsc --strict` and no
// `@types/node` install (this demo deliberately has zero npm dependencies — see run.sh). Node
// itself provides the real `process` global at runtime.
declare const process: { exit(code: number): never };

let failures = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures += 1;
    console.error(`ASSERTION FAILED: ${message}`);
  }
}

// --- OrderLine: the derived `subtotal` must equal unitPrice * quantity. ---
const widget = new ProductId('11111111-1111-4111-8111-111111111111');
const gadget = new ProductId('22222222-2222-4222-8222-222222222222');

const line1 = new OrderLine(widget, 2, new Decimal('19.99'));
const line2 = new OrderLine(gadget, 3, new Decimal('4.50'));

assert(
  line1.subtotal.equals(new Decimal('39.98')),
  `line1.subtotal should be 39.98 (2 * 19.99), got ${line1.subtotal.toString()}`,
);
assert(
  line2.subtotal.equals(new Decimal('13.50')),
  `line2.subtotal should be 13.50 (3 * 4.50), got ${line2.subtotal.toString()}`,
);

// --- Order: construction with two lines defaults to Draft. ---
const orderId = OrderIdNew();
const draftOrder = new Order(orderId, [line1, line2]);

assert(draftOrder.status.name === 'Draft', `a freshly constructed order should default to Draft, got '${draftOrder.status.name}'`);
assert(draftOrder.lines.length === 2, `order should carry both lines, got ${draftOrder.lines.length}`);
assert(draftOrder.lines[0]!.equals(line1), 'the first line should round-trip by value equality');
assert(draftOrder.lines[1]!.equals(line2), 'the second line should round-trip by value equality');

// --- Order identity: equality is by id, not by structural contents (aggregate roots are entities). ---
const sameIdDifferentLines = new Order(orderId, [line1], OrderStatus.Placed);
assert(
  draftOrder.equals(sameIdDifferentLines),
  'two Order instances with the same id must be equal regardless of their line/status contents (entity identity)',
);

const differentOrder = new Order(OrderIdNew(), [line1, line2]);
assert(!draftOrder.equals(differentOrder), 'two Order instances with different ids must not be equal');

// --- OrderStatus: the Draft -> Placed -> Shipped lifecycle values are all constructible and
// distinguishable. ---
const placedOrder = new Order(orderId, [line1, line2], OrderStatus.Placed);
const shippedOrder = new Order(orderId, [line1, line2], OrderStatus.Shipped);

assert(placedOrder.status.name === 'Placed', `expected Placed, got '${placedOrder.status.name}'`);
assert(shippedOrder.status.name === 'Shipped', `expected Shipped, got '${shippedOrder.status.name}'`);
assert(draftOrder.status.name !== placedOrder.status.name, 'Draft and Placed must be distinguishable status values');

const matched = OrderStatusMatch(shippedOrder.status, {
  draft: () => 'unexpected-draft',
  placed: () => 'unexpected-placed',
  shipped: () => 'shipped',
  cancelled: () => 'unexpected-cancelled',
});
assert(matched === 'shipped', `OrderStatusMatch should route a Shipped order to its 'shipped' case, got '${matched}'`);

// --- State machine: a legal Draft -> Placed -> Shipped walk through the generated mutators, and an
// illegal Draft -> Shipped transition rejected by the generated runtime guard. ---
const walkedOrder = new Order(OrderIdNew(), [line1, line2]);
walkedOrder.place();
assert(walkedOrder.status.name === 'Placed', `place() should transition Draft -> Placed, got '${walkedOrder.status.name}'`);
walkedOrder.ship();
assert(walkedOrder.status.name === 'Shipped', `ship() should transition Placed -> Shipped, got '${walkedOrder.status.name}'`);

const illegalOrder = new Order(OrderIdNew(), [line1, line2]);
let illegalTransitionRejected = false;
try {
  illegalOrder.ship();
} catch (error) {
  illegalTransitionRejected = error instanceof DomainInvariantViolationError;
}
assert(illegalTransitionRejected, 'ship() on a Draft order should throw DomainInvariantViolationError (Draft -> Shipped is not a legal transition)');

if (failures > 0) {
  console.error(`${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log('TypeScript demo: all assertions passed.');
