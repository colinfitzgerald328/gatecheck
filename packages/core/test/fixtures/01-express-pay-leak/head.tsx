import { useFlags } from 'launchdarkly-react-client-sdk';
import { ExpressPay } from './ExpressPay';

export function Checkout({ cart }) {
  const { expressCheckout } = useFlags();
  const total = sumCart(cart);
  return (
    <>
      <Summary total={total} />
      {expressCheckout && <ExpressPay total={total} />}
    </>
  );
}

function sumCart(cart) {
  return cart.items.reduce(
    (s, i) => s + i.price * i.qty, 0) + cart.tax;
}
