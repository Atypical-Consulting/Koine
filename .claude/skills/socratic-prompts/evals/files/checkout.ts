// A deliberately messy checkout function — for the auto-anchoring eval.
export async function checkout(cart: any, user: any, opts: any) {
  let total = 0;
  for (let i = 0; i < cart.items.length; i++) {
    total += cart.items[i].price * cart.items[i].qty;
  }
  if (user.coupon) {
    if (user.coupon.type == "percent") {
      total = total - total * (user.coupon.value / 100);
    } else if (user.coupon.type == "flat") {
      total = total - user.coupon.value;
    }
  }
  if (total < 0) total = 0;

  if (opts.tax) {
    total = total + total * 0.2;
  }

  let res;
  try {
    res = await fetch("/api/pay", {
      method: "POST",
      body: JSON.stringify({ amount: total, uid: user.id, card: opts.card }),
    });
  } catch (e) {
    console.log("payment failed", e);
    return false;
  }
  if (res.status == 200) {
    cart.items = [];
    return true;
  }
  return false;
}
