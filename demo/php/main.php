<?php

declare(strict_types=1);

/**
 * Hand-written driver for the PHP demo (issue #1073).
 *
 * Constructs the generated `Order` aggregate (with `OrderLine` value objects and an `OrderStatus`
 * native enum) from templates/starters/ordering and asserts VALUES -- never emitted formatting or
 * whitespace -- so this demo never churns when the emitter's output shape changes. A clean run
 * (every assertion holds) exits 0; any failed assertion calls `exit(1)` so a red run is unmissable.
 *
 * No Composer autoloading is used: the emitted classes are required directly, in dependency order,
 * the same way the Conformance/PhpConformanceTests harness exercises them (it writes files to a
 * temp directory and analyses them as-is, with no autoloader).
 */

require_once __DIR__ . '/generated/KoineRuntime.php';
require_once __DIR__ . '/generated/src/Ordering/ValueObjects/ProductId.php';
require_once __DIR__ . '/generated/src/Ordering/ValueObjects/OrderId.php';
require_once __DIR__ . '/generated/src/Ordering/ValueObjects/OrderLine.php';
require_once __DIR__ . '/generated/src/Ordering/Enums/OrderStatus.php';
require_once __DIR__ . '/generated/src/Ordering/Entities/Order.php';

use Koine\Ordering\Entities\Order;
use Koine\Ordering\Enums\OrderStatus;
use Koine\Ordering\ValueObjects\OrderId;
use Koine\Ordering\ValueObjects\OrderLine;
use Koine\Ordering\ValueObjects\ProductId;
use Koine\Runtime\Decimal;

$failures = 0;

$check = function (bool $condition, string $message) use (&$failures): void {
    if (!$condition) {
        $failures++;
        fwrite(STDERR, "ASSERTION FAILED: {$message}\n");
    }
};

// --- OrderLine: the derived `subtotal()` method must equal unitPrice * quantity. ---
$widget = new ProductId('11111111-1111-4111-8111-111111111111');
$gadget = new ProductId('22222222-2222-4222-8222-222222222222');

$line1 = new OrderLine($widget, 2, new Decimal('19.99'));
$line2 = new OrderLine($gadget, 3, new Decimal('4.50'));

$check(
    $line1->subtotal()->equals(new Decimal('39.98')),
    "line1.subtotal should be 39.98 (2 * 19.99), got {$line1->subtotal()->getValue()}",
);
$check(
    $line2->subtotal()->equals(new Decimal('13.50')),
    "line2.subtotal should be 13.50 (3 * 4.50), got {$line2->subtotal()->getValue()}",
);

// --- Order: construction with two lines defaults to Draft. ---
$orderId = OrderId::generate();
$draftOrder = new Order($orderId, [$line1, $line2]);

$check(
    $draftOrder->status === OrderStatus::DRAFT,
    "a freshly constructed order should default to Draft, got '{$draftOrder->status->name}'",
);
$check(count($draftOrder->lines) === 2, 'order should carry both lines, got ' . count($draftOrder->lines));
$check($draftOrder->lines[0]->equals($line1), 'the first line should round-trip by value equality');
$check($draftOrder->lines[1]->equals($line2), 'the second line should round-trip by value equality');

// --- Order identity: equality is by id, not by structural contents (aggregate roots are
// entities). This constructs a SECOND, distinct OrderId object from the same underlying UUID
// string -- the realistic shape a repository rehydrating an entity from a persisted id on two
// separate loads would produce -- to prove identity is compared by value, not by PHP object
// reference. ---
$sameIdDifferentObject = new OrderId($orderId->value);
$sameIdDifferentLines = new Order($sameIdDifferentObject, [$line1], OrderStatus::PLACED);
$check(
    $draftOrder->equals($sameIdDifferentLines),
    'two Order instances with the same id must be equal regardless of their line/status contents '
        . '(entity identity)',
);

$differentOrder = new Order(OrderId::generate(), [$line1, $line2]);
$check(!$draftOrder->equals($differentOrder), 'two Order instances with different ids must not be equal');

// --- OrderStatus: the Draft -> Placed -> Shipped lifecycle values are all constructible and
// distinguishable. ---
$placedOrder = new Order($orderId, [$line1, $line2], OrderStatus::PLACED);
$shippedOrder = new Order($orderId, [$line1, $line2], OrderStatus::SHIPPED);

$check($placedOrder->status === OrderStatus::PLACED, "expected Placed, got '{$placedOrder->status->name}'");
$check($shippedOrder->status === OrderStatus::SHIPPED, "expected Shipped, got '{$shippedOrder->status->name}'");
$check(
    $draftOrder->status !== $placedOrder->status,
    'Draft and Placed must be distinguishable status values',
);

// match_() is emitted with a `mixed` return type (it dispatches to whichever closures the caller
// passes), so narrow it back to the `string` these four arms return via an is_string() guard rather
// than an unchecked cast -- if a future emitter change ever made match_ return something else, this
// demo should fail loudly here instead of silently stringifying the wrong value.
$matchedRaw = $shippedOrder->status->match_(
    draft: fn (): string => 'unexpected-draft',
    placed: fn (): string => 'unexpected-placed',
    shipped: fn (): string => 'shipped',
    cancelled: fn (): string => 'unexpected-cancelled',
);
if (!is_string($matchedRaw)) {
    throw new \RuntimeException('OrderStatus::match_ was expected to return a string here.');
}
$matched = $matchedRaw;
$check(
    $matched === 'shipped',
    "OrderStatus::match_ should route a Shipped order to its 'shipped' case, got '{$matched}'",
);

// --- State machine: a legal Draft -> Placed -> Shipped walk through the generated mutators, and an
// illegal Draft -> Shipped transition rejected by the generated runtime guard. ---
$walkedOrder = new Order(OrderId::generate(), [$line1, $line2]);
$walkedOrder->place();
$check($walkedOrder->status === OrderStatus::PLACED, "place() should transition Draft -> Placed, got '{$walkedOrder->status->name}'");
$walkedOrder->ship();
$check($walkedOrder->status === OrderStatus::SHIPPED, "ship() should transition Placed -> Shipped, got '{$walkedOrder->status->name}'");

$illegalOrder = new Order(OrderId::generate(), [$line1, $line2]);
$illegalTransitionRejected = false;
try {
    $illegalOrder->ship();
} catch (\Koine\Runtime\DomainInvariantViolationException $e) {
    $illegalTransitionRejected = true;
}
$check(
    $illegalTransitionRejected,
    'ship() on a Draft order should throw DomainInvariantViolationException (Draft -> Shipped is not a legal transition)',
);

if ($failures > 0) {
    fwrite(STDERR, "{$failures} assertion(s) failed.\n");
    exit(1);
}

echo "PHP demo: all assertions passed.\n";
