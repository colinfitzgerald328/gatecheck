export function formatPrice(n) {
  return `$${n.toFixed(2)}`;
}

export function formatLegacy(n) {
  return `USD ${n}`;
}
