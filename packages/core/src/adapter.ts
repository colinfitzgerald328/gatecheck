import type { ClassifyInsertion } from './compare.ts';
import type { FlagPreset } from './presets/types.ts';
import type { Comment, N } from './tree.ts';

export interface TopLevelItem {
  node: N;
  /** Shown in reports, e.g. `sumCart`. */
  label: string;
  /** Whether this item declares something (vs. a bare statement). */
  isDeclaration: boolean;
}

/**
 * Everything language-specific. M0 keeps the rewrite rules inside each adapter;
 * the shared "shapes" layer from the plan gets extracted in M3, once Python
 * gives a second language to generalize from.
 */
export interface LanguageAdapter {
  id: string;
  extensions: string[];
  parse(source: string): Promise<{ tree: N; comments: Comment[] }>;
  /** Canonical keys of every flag the file reads. */
  collectFlagKeys(tree: N, preset: FlagPreset): Set<string>;
  /** Replace reads of `newKeys` with their off values and drop the alias declarations. */
  substituteFlags(tree: N, preset: FlagPreset, newKeys: Set<string>, removed: string[]): void;
  /** Fold constants, pick branches, cut dead code, normalize. Applied to both sides. */
  simplify(tree: N): N;
  /** Remove new top-level declarations and imports that nothing reaches any more. */
  pruneAdditions(head: N, base: N, removed: string[]): void;
  /** Top-level items keyed by a stable identity, for matching base against head. */
  topLevel(tree: N): Map<string, TopLevelItem>;
  /** Recognizes additive API changes on the branch, given main for context (e.g. existing routes). */
  insertionClassifier(base: N): ClassifyInsertion;
}
