import { useFlags } from 'launchdarkly-react-client-sdk';

export function Checkout({ cart }) {
  const { giftWrap } = useFlags();
  const quote = fetchWrapQuote(cart.id);
  const total = sumCart(cart);
  return (
    <>
      {giftWrap && <WrapQuote quote={quote} />}
      <PayButton amount={total} />
    </>
  );
}
