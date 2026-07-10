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
 *
 * KNOWN GAPS (see reference/README.md and ../README.md "What this demo does NOT prove"):
 *
 * 1. templates/starters/ordering's `states status { ... }` block has no paired `command`
 *    declarations, so -- per the documented Koine semantics ("the block by itself emits nothing;
 *    its effect appears wherever a command assigns that field") -- the emitted `Order` has no
 *    transition method and no runtime guard. This demo therefore constructs immutable Order
 *    snapshots at each lifecycle value instead of driving a mutator, and does NOT assert that an
 *    illegal transition (e.g. Draft -> Shipped) is rejected, because nothing in the emitted code
 *    rejects it. This is a property of the *template*, not a PHP-emitter bug -- identical to the
 *    TypeScript, Python, and Rust demos of this same template.
 *
 * 2. The emitted `Order::equals()` compares its `id` member with PHP's `===` operator
 *    (object-identity equality), not with the `OrderId` value object's own `equals()` method (a
 *    value comparison). The TypeScript emitter calls `this.id.equals(other.id)` and the Python
 *    emitted dataclass uses value-based `==`, so this is a PHP-emitter-specific divergence: two
 *    `OrderId` instances holding the *same* underlying UUID string, but constructed as separate PHP
 *    objects (e.g. one built fresh from a persisted string, as a repository load would do), would
 *    incorrectly compare as NOT equal. This demo works around the gap by reusing the very same
 *    `OrderId` PHP object reference across the "same identity" assertion below (which is also
 *    exactly how the TypeScript/Python demos are written), so it never actually exercises the
 *    broken cross-instance case -- see reference/README.md for the concrete repro and the follow-up
 *    this warrants.
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
// entities). NOTE: this reuses the same $orderId PHP object reference across both instances below
// -- see KNOWN GAP 2 above for why that matters for the emitted `===` comparison. ---
$sameIdDifferentLines = new Order($orderId, [$line1], OrderStatus::PLACED);
$check(
    $draftOrder->equals($sameIdDifferentLines),
    'two Order instances with the same id must be equal regardless of their line/status contents '
        . '(entity identity)',
);

$differentOrder = new Order(OrderId::generate(), [$line1, $line2]);
$check(!$draftOrder->equals($differentOrder), 'two Order instances with different ids must not be equal');

// --- OrderStatus: the Draft -> Placed -> Shipped lifecycle values are all constructible and
// distinguishable (see KNOWN GAP 1 above: this does not exercise a runtime transition guard,
// because templates/starters/ordering emits none). ---
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

if ($failures > 0) {
    fwrite(STDERR, "{$failures} assertion(s) failed.\n");
    exit(1);
}

echo "PHP demo: all assertions passed.\n";
