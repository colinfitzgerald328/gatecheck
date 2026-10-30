import { ldClient } from './ld';

export function canRefund(user, order) {
  if (ldClient.variation('self-serve-refunds', false) && order.total < 100) return true;
  if (user.isAdmin || user.isSupport) return true;
  return order.ageDays < 30;
}
