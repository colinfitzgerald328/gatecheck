import { store } from './store';

const unsubscribe = store.subscribe(() => console.log('cart changed'));
const LABEL = 'Total';

export function total(cart) {
  return cart.subtotal;
}
