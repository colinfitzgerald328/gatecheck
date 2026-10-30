import type { ClassifyInsertion } from './compare.ts';
import type { PresetSpec } from './presets/types.ts';
import type { Comment, N } from './tree.ts';

export interface TopLevelItem {
  node: N;
  /** Shown in reports, e.g. `sumCart`. */
  label: string;
  /** Whether this item declares something (vs. a bare statement). */
  isDeclaration: boolean;
  /** An import with bindings. Adding or removing one runs nothing by itself. */
  importOnly?: boolean;
}

/**
 * Everything language-specific. M0 keeps the rewrite rules inside each adapter;
 * the shared "shapes" layer from the plan gets extracted in M3, once Python
 * gives a second language to generalize from.
 */
export interface LanguageAdapter {
  id: string;
  extensions: string[];
  /** Parse and tag flag reads using each preset's query for this language. */
  parse(source: string, presets: PresetSpec[]): Promise<{ tree: N; comments: Comment[] }>;
  /** Canonical keys of every flag the file reads. */
  collectFlagKeys(tree: N): Set<string>;
  /** Replace reads of `newKeys` with their off values and drop the alias declarations. */
  substituteFlags(tree: N, newKeys: Set<string>, removed: string[]): void;
  /** Relative import specifiers and the names imported from each. `*` means everything. */
  imports(tree: N): { source: string; names: string[] }[];
  /** Rewrite every static import/re-export specifier in place. */
  mapImportSources(tree: N, map: (source: string) => string): void;
  /** A file's identity as a module: `src/x.ts` → `src/x`, `pkg/__init__.py` → `pkg`. */
  moduleStem(path: string): string;
  /**
   * Where an import in `from` points, as a module stem. Prefix `~/` when only the end of
   * the path is known (Python's `from app.services import x`): it matches any changed
   * file whose stem ends that way. Imports of packages come back unchanged.
   */
  resolveImport(from: string, source: string): string;
  /** An extended regex for `git grep` that matches lines which may import `path`. */
  importerPattern(path: string): string;
  /** Fold constants, pick branches, cut dead code, normalize. Applied to both sides. */
  simplify(tree: N): N;
  /** Remove new top-level declarations and imports that nothing reaches any more. */
  pruneAdditions(head: N, base: N, removed: string[], keep: Set<string>): void;
  /** Top-level items keyed by a stable identity, for matching base against head. */
  topLevel(tree: N): Map<string, TopLevelItem>;
  /** Recognizes additive API changes on the branch, given main for context (e.g. existing routes). */
  insertionClassifier(base: N): ClassifyInsertion;
}
