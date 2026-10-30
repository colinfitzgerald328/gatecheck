import { ldClient } from './ld';

export function total(cart) {
  if (ldClient.variation('loyalty-discount', false)) return applyDiscount(cart.subtotal);
  return cart.subtotal;
}

function applyDiscount(amount) {
  return amount * 0.9;
}
