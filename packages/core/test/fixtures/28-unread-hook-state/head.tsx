import { useState } from 'react';
import { useFlags } from 'launchdarkly-react-client-sdk';

export function Checkout({ cart }) {
  const { giftWrap } = useFlags();
  const [wrapped, setWrapped] = useState(false);
  const toggle = () => setWrapped(!wrapped);
  const total = sumCart(cart);
  return (
    <>
      {giftWrap && <input type="checkbox" checked={wrapped} onChange={toggle} />}
      <PayButton amount={total} />
    </>
  );
}
