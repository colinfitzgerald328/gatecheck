import { checkFiles, type CheckOptions, type ReportedLeak } from './check.ts';
import type { BuiltinPreset } from './presets/index.ts';
import type { PresetSpec } from './presets/types.ts';

export type { LanguageAdapter, TopLevelItem } from './adapter.ts';
export type { AdditiveKind, Category, Leak, LeakKind, Span } from './compare.ts';
export type { PresetSpec } from './presets/types.ts';
export type { BuiltinPreset } from './presets/index.ts';
export type { CheckOptions, CheckResult, FileChange, Policy, ReportedLeak, Severity } from './check.ts';
export { checkFiles, DEFAULT_POLICY } from './check.ts';
export { BUILTIN_PRESETS } from './presets/index.ts';
export { branchChanges, defaultBase, importedOnRef, keyOnRef, readAt, repoRoot } from './git.ts';
export { checkBranch, type BranchCheck } from './branch.ts';
export { canonicalKey } from './flags.ts';
export { tsx } from './lang/tsx.ts';

/** Shape of gatecheck.config.ts / .json. */
export interface Config {
  /** Built-in preset names or your own query presets. Default: ['launchdarkly']. */
  presets?: (BuiltinPreset | PresetSpec)[];
  /**
   * Severity per leak category. Additive API changes default to 'allow',
   * `outside-projection` to 'warn', everything else to 'error'.
   */
  policy?: CheckOptions['policy'];
  /** What branches are compared to. Default: origin's default branch, else main. */
  base?: string;
  /** Claude Code plugin hooks. */
  hooks?: {
    /** Report leaks in a file right after Claude edits it. Default 'on'. */
    postEdit?: 'on' | 'off';
    /** Before Claude finishes: 'block' sends it back to fix leaks, 'warn' tells you. Default 'warn'. */
    stop?: 'block' | 'warn' | 'off';
    /** Stay quiet unless the branch adds a new flag, so ordinary edits aren't flagged. Default true. */
    requireNewFlag?: boolean;
  };
}

/** Check one file's two versions. Handy for tests and editor integrations. */
export async function checkSource(
  options: { base: string; head: string; path?: string } & Omit<CheckOptions, 'existsOnBase'>,
): Promise<{ newFlags: string[]; leaks: ReportedLeak[]; removed: string[] }> {
  const { base, head, path = 'input.tsx', ...rest } = options;
  const result = await checkFiles([{ path, base, head }], rest);
  return { newFlags: result.newFlags, leaks: result.leaks, removed: result.removed.map((r) => r.what) };
}
export { runBench, type BenchResult, type Expectation, type Score } from './bench.ts';
