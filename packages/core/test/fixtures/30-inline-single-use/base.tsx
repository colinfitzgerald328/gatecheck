export function Checkout({ cart }) {
  const total = sumCart(cart);
  return <Summary total={total} items={cart.items} />;
}
