import { checkFiles, codePathspecs, DEFAULT_ADAPTERS, type CheckOptions, type CheckResult, type FileChange } from './check.ts';
import { branchChanges, importedOnRef, keyOnRef } from './git.ts';

export interface BranchCheck {
  result: CheckResult;
  changes: FileChange[];
  mergeBase: string;
}

/** Check a branch (or the working tree, with no `head`) against where it split from `base`. */
export async function checkBranch(
  root: string,
  base: string,
  head: string | undefined,
  options: Omit<CheckOptions, 'existsOnBase' | 'importedElsewhere'> = {},
): Promise<BranchCheck> {
  const { mergeBase, changes } = branchChanges(root, base, head);
  const changed = changes.map((c) => c.path);
  const pathspecs = codePathspecs(options.adapters ?? DEFAULT_ADAPTERS);
  const result = await checkFiles(changes, {
    ...options,
    existsOnBase: (k) => keyOnRef(root, mergeBase, k, pathspecs),
    importedElsewhere: (p, lang) => importedOnRef(root, head, lang.importerPattern(p), changed, pathspecs),
  });
  return { result, changes, mergeBase };
}
