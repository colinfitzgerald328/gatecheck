import type { N } from '../tree.ts';

export interface FlagRead {
  key: string;
  /** What the expression evaluates to when the flag is off. */
  off: N;
}

/**
 * How one vendor's SDK reads flags. M0 matches in code; M1 moves the simple
 * call patterns to tree-sitter queries so users can add their own.
 */
export interface FlagPreset {
  vendor: string;
  /** Keys are compared in this form, so `express-checkout` and `expressCheckout` match. */
  canonicalKey(key: string): string;
  /** A complete flag read, e.g. `ldClient.variation('k', ctx, false)`. */
  matchRead(n: N): FlagRead | null;
  /** A call returning every flag as an object, e.g. `useFlags()`. */
  isFlagBag(n: N): boolean;
  /** Off value for a key read from the flag bag. */
  bagOff(): N;
}
