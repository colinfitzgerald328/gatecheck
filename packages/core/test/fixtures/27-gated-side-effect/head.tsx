import { ldClient } from './ld';

export function onAddToCart(item) {
  ldClient.variation('cart-analytics', false) && analytics.track('add_to_cart', { sku: item.sku });
  cart.add(item);
}
