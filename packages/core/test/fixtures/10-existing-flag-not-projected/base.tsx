import { useFlags } from 'launchdarkly-react-client-sdk';

export function Checkout() {
  const { expressCheckout } = useFlags();
  return expressCheckout ? <ExpressPay /> : <Pay />;
}

export function trackCheckout() {
  analytics.track('checkout');
}
