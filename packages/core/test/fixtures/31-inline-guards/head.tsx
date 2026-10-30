export function usedTwice(order) {
  const t = order.total;
  log(t);
  send(t);
}

export function notAdjacent(order) {
  const c = compute(order);
  warmCache();
  track(c);
}

export function intoClosure(order) {
  const id = order.id;
  return later(() => id);
}
