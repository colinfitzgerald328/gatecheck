import { useFlags } from 'launchdarkly-react-client-sdk';

export function Header() {
  const { search } = useFlags();
  return <header>{search && <Search />}<Logo /></header>;
}
