import { ldClient } from './ld';

export async function submitOrder(order) {
  if (ldClient.variation('stripe-v2', false)) {
    await stripeV2Charge(order);
  } else {
    await legacyCharge(order);
  }
  return { ok: true };
}

async function stripeV2Charge(order) {
  return fetch('/v2/charge', { method: 'POST', body: JSON.stringify(order) });
}
