import { useFlags } from 'launchdarkly-react-client-sdk';

export function Checkout() {
  const { expressCheckout } = useFlags();
  return expressCheckout ? <ExpressPay /> : <Pay />;
}

export function trackCheckout() {
  if (ldClient.variation('express-checkout', false)) analytics.track('express');
  analytics.track('checkout');
}
