import { useFlags } from 'launchdarkly-react-client-sdk';

export function Footer() {
  const flags = useFlags();
  return <footer><Links />{flags.newsletterSignup ? <Newsletter /> : null}</footer>;
}
