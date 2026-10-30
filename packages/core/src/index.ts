import type { LanguageAdapter } from './adapter.ts';
import { compareTopLevel, type Category, type Leak } from './compare.ts';
import { tsx } from './lang/tsx.ts';
import { launchdarkly } from './presets/launchdarkly.ts';
import type { FlagPreset } from './presets/types.ts';

export type { LanguageAdapter, TopLevelItem } from './adapter.ts';
export type { AdditiveKind, Category, Leak, LeakKind, Span } from './compare.ts';
export type { FlagPreset, FlagRead } from './presets/types.ts';
export { tsx, launchdarkly };

export type Severity = 'error' | 'warn' | 'allow';
export type Policy = Partial<Record<Category, Severity>>;

/** Changes that can't break an existing caller are allowed unless the config says otherwise. */
export const DEFAULT_POLICY: Required<Policy> = {
  'ungated-modification': 'error',
  'ungated-deletion': 'error',
  'reachable-addition': 'error',
  'optional-field': 'allow',
  'response-field': 'allow',
  'optional-param': 'allow',
  'new-endpoint': 'allow',
};

/** Shape of gatecheck.config.ts / .json. */
export interface Config {
  preset?: 'launchdarkly';
  /**
   * Severity per leak category. Additive API changes default to 'allow',
   * everything else to 'error'.
   */
  policy?: Policy;
}

export const PRESETS: Record<NonNullable<Config['preset']>, FlagPreset> = { launchdarkly };

export interface ReportedLeak extends Leak {
  severity: Severity;
}

export interface CheckOptions {
  base: string;
  head: string;
  lang?: LanguageAdapter;
  preset?: FlagPreset;
  /** Project these flags instead of detecting new ones. */
  flags?: string[];
  policy?: Policy;
}

export interface CheckResult {
  newFlags: string[];
  leaks: ReportedLeak[];
  /** What projection took out, for the report. */
  removed: string[];
}

const ALLOW = /gatecheck-allow:\s*(.+?)\s*(?:\*\/)?$/;

export async function checkSource({ base, head, lang = tsx, preset = launchdarkly, flags, policy }: CheckOptions): Promise<CheckResult> {
  const b = await lang.parse(base);
  const h = await lang.parse(head);

  const baseKeys = lang.collectFlagKeys(b.tree, preset);
  const headKeys = lang.collectFlagKeys(h.tree, preset);
  const newKeys = flags
    ? new Set(flags.map((f) => preset.canonicalKey(f)))
    : new Set([...headKeys].filter((k) => !baseKeys.has(k)));

  // Compare the flag-off world on both sides. New flags don't appear on main, so this
  // only matters for --flag naming a flag main already reads.
  const removed: string[] = [];
  lang.substituteFlags(b.tree, preset, newKeys, []);
  lang.substituteFlags(h.tree, preset, newKeys, removed);
  const baseTree = lang.simplify(b.tree);
  const headTree = lang.simplify(h.tree);
  lang.pruneAdditions(headTree, baseTree, removed);

  const found = compareTopLevel(lang.topLevel(baseTree), lang.topLevel(headTree), headTree, lang.insertionClassifier(baseTree));
  const rules = { ...DEFAULT_POLICY, ...policy };

  // An allow comment covers a leak that starts on its line or the line after.
  const allows = h.comments.flatMap((c) => {
    const m = ALLOW.exec(c.text);
    return m ? [{ line: c.row + 1, reason: m[1] }] : [];
  });
  const leaks = found.map((leak): ReportedLeak => {
    const allow = allows.find((a) => leak.head.line === a.line || leak.head.line === a.line + 1);
    if (allow) return { ...leak, allowed: allow.reason, severity: 'allow' };
    return { ...leak, severity: rules[leak.additive ?? leak.kind] };
  });

  return { newFlags: [...newKeys], leaks, removed };
}
