/**
 * A vendor preset: tree-sitter queries, one per language, that find flag reads.
 *
 * Captures:
 *   @read      an expression that evaluates to the flag's value
 *   @key       the flag key (a string literal or property name) inside @read
 *   @fallback  optional; the value @read has when the flag is off. Without it, `false`.
 *   @bag       an expression returning every flag as an object, like `useFlags()`.
 *              Properties destructured or read from it are flag reads.
 *
 * Captures starting with `_` are for predicates only.
 */
export interface PresetSpec {
  vendor: string;
  queries: Partial<Record<string, string>>;
}
