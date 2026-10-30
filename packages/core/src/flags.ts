import { clone, leaf, namedChildren, type N } from './tree.ts';

export interface FlagRead {
  key: string;
  off: N;
}

/**
 * Keys are compared in camelCase, so `express-checkout`, `express_checkout` and the
 * LaunchDarkly React SDK's `expressCheckout` are the same flag.
 */
export function canonicalKey(key: string): string {
  const words = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length <= 1) return key.charAt(0).toLowerCase() + key.slice(1);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

export function matchRead(n: N): FlagRead | null {
  if (n.type === 'await_expression') {
    const inner = namedChildren(n)[0];
    return inner ? matchRead(inner) : null;
  }
  return n.flag?.kind === 'read' ? { key: n.flag.key, off: clone(n.flag.off) } : null;
}

export function isFlagBag(n: N): boolean {
  return n.flag?.kind === 'bag';
}

/** A flag that doesn't exist yet is missing from the bag; one that's created and off is false. */
export function bagOff(): N {
  return leaf('false', 'false');
}
