export function Checkout({ cart }) {
  const total = sumCart(cart);
  return <Summary total={total} />;
}

function sumCart(cart) {
  return cart.items.reduce(
    (s, i) => s + i.price * i.qty, 0);
}
