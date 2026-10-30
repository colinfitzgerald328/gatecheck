export function sumCart(cart) {
  return cart.items.reduce(addLine, 0);
}

function addLine(sum, item) {
  return sum + item.price * item.qty;
}
