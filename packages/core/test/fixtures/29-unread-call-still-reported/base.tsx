export function Checkout({ cart }) {
  const total = sumCart(cart);
  return <PayButton amount={total} />;
}
