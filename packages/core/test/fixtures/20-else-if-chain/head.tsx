import { ldClient } from './ld';

export function shippingLabel(order) {
  if (ldClient.variation('drone-delivery', false) && order.droneEligible) {
    return 'Drone';
  } else if (order.express) {
    return 'Express';
  } else {
    return 'Standard';
  }
}
