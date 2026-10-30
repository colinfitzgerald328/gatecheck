export async function submitOrder(order) {
  await legacyCharge(order);
  return { ok: true };
}
