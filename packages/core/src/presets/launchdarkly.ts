import { child, clone, leaf, namedChildren, type N } from '../tree.ts';
import type { FlagPreset, FlagRead } from './types.ts';

const VARIATION_METHODS = new Set([
  'variation',
  'boolVariation',
  'stringVariation',
  'numberVariation',
  'jsonVariation',
]);

/** Same result as the lodash.camelcase the React SDK uses, for flag-key shapes. */
export function camelCase(key: string): string {
  const words = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length <= 1) return key.charAt(0).toLowerCase() + key.slice(1);
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

function calleeName(call: N): string | undefined {
  const fn = child(call, 'function');
  if (!fn) return undefined;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') return child(fn, 'property')?.text;
  return undefined;
}

/** `client.variation('k', fallback)` or `client.variation('k', ctx, fallback)`. The fallback is always last. */
function matchVariationCall(n: N, methods: Set<string>): FlagRead | null {
  if (n.type !== 'call_expression') return null;
  const fn = child(n, 'function');
  if (fn?.type !== 'member_expression') return null;
  if (!methods.has(calleeName(n) ?? '')) return null;
  const args = namedChildren(child(n, 'arguments') ?? { type: '', named: true, children: [] });
  if (args.length < 2 || args[0].type !== 'string') return null;
  return { key: args[0].text ?? '', off: clone(args[args.length - 1]) };
}

export const launchdarkly: FlagPreset = {
  vendor: 'launchdarkly',
  canonicalKey: camelCase,

  isFlagBag(n) {
    return n.type === 'call_expression' && child(n, 'function')?.type === 'identifier' && calleeName(n) === 'useFlags';
  },

  bagOff() {
    // A flag that doesn't exist yet is missing from useFlags(); a created flag that's off is false.
    return leaf('false', 'false');
  },

  matchRead(n) {
    if (n.type === 'await_expression') {
      const inner = namedChildren(n)[0];
      return inner ? this.matchRead(inner) : null;
    }
    const direct = matchVariationCall(n, VARIATION_METHODS);
    if (direct) return direct;
    if (n.type === 'member_expression') {
      const obj = child(n, 'object');
      const prop = child(n, 'property')?.text;
      if (!obj || !prop) return null;
      // client.variationDetail('k', ctx, fb).value
      const detail = matchVariationCall(obj, new Set(['variationDetail']));
      if (detail && prop === 'value') return detail;
      // useFlags().someFlag
      if (this.isFlagBag(obj)) return { key: prop, off: this.bagOff() };
    }
    return null;
  },
};
