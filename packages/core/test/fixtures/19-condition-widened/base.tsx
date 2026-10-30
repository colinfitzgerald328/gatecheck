export function canRefund(user, order) {
  if (user.isAdmin) return true;
  return order.ageDays < 30;
}
