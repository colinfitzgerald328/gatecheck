import { useFlags } from 'launchdarkly-react-client-sdk';

export function Nav() {
  const { sidebarNav } = useFlags();
  return sidebarNav ? <SidebarNav /> : <OldNav compact />;
}
