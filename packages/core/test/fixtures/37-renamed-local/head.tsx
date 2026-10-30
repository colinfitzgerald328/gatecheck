export function receipt(order) {
  const subtotal = order.lines.reduce((s, l) => s + l.price, 0);
  log(`total ${subtotal}`);
  return { total: subtotal, tax: subtotal * 0.08 };
}
