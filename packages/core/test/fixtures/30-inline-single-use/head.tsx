import { useFlags } from 'launchdarkly-react-client-sdk';

export function Checkout({ cart }) {
  const { promoCodes } = useFlags();
  const subtotal = sumCart(cart);
  const total = promoCodes ? applyPromo(subtotal) : subtotal;
  const items = cart.items;
  return <Summary total={total} items={items} />;
}

function applyPromo(n) {
  return n * 0.9;
}
