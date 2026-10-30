export function usedTwice(order) {
  log(order.total);
  send(order.total);
}

export function notAdjacent(order) {
  track(compute(order));
}

export function intoClosure(order) {
  return later(order.id);
}
