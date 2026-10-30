export function receipt(order) {
  const t = order.lines.reduce((s, l) => s + l.price, 0);
  log(`total ${t}`);
  return { total: t, tax: t * 0.08 };
}
