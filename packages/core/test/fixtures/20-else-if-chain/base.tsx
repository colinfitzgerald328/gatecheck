export function shippingLabel(order) {
  if (order.express) {
    return 'Express';
  } else {
    return 'Standard';
  }
}
