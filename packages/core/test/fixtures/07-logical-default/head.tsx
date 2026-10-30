import { ldClient } from './ld';

export function pageSize() {
  const limit = (ldClient.variation('big-pages', false) && 50) || 10;
  return limit;
}
