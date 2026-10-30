import { useFlags } from 'launchdarkly-react-client-sdk';

export function Banner({ user }) {
  const { newBanner } = useFlags();
  if (!newBanner) return <OldBanner name={user.name} />;
  const greeting = `Welcome back, ${user.name}`;
  return <HeroBanner title={greeting} />;
}
