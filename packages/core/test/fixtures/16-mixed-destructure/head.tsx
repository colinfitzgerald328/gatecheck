import { useFlags } from 'launchdarkly-react-client-sdk';

export function Header() {
  const { search, newNav } = useFlags();
  return <header>{search && <Search />}<Logo />{newNav && <MegaMenu />}</header>;
}
