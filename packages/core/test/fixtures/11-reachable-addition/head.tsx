export function total(cart) {
  return applyDiscount(cart.subtotal);
}

function applyDiscount(amount) {
  return amount * 0.9;
}
