import { posix } from 'node:path';
import type { LanguageAdapter } from './adapter.ts';
import { compareTopLevel, type Category, type Leak } from './compare.ts';
import { canonicalKey } from './flags.ts';
import { python } from './lang/python.ts';
import { tsx } from './lang/tsx.ts';
import { BUILTIN_PRESETS } from './presets/index.ts';
import type { PresetSpec } from './presets/types.ts';
import { ser, type Comment, type N } from './tree.ts';

export type Severity = 'error' | 'warn' | 'allow';
export type Policy = Partial<Record<Category, Severity>>;

/** Changes that can't break an existing caller are allowed unless the config says otherwise. */
export const DEFAULT_POLICY: Required<Policy> = {
  'ungated-modification': 'error',
  'ungated-deletion': 'error',
  'reachable-addition': 'error',
  'outside-projection': 'warn',
  'optional-field': 'allow',
  'response-field': 'allow',
  'optional-param': 'allow',
  'new-endpoint': 'allow',
};

export const DEFAULT_ADAPTERS: LanguageAdapter[] = [tsx, python];

/** File extensions gatecheck can project, as git pathspecs. */
export function codePathspecs(adapters: LanguageAdapter[] = DEFAULT_ADAPTERS): string[] {
  return adapters.flatMap((a) => a.extensions.map((e) => `*${e}`));
}

export interface ReportedLeak extends Leak {
  file: string;
  severity: Severity;
}

/** One changed file. `null` means the file doesn't exist on that side. */
export interface FileChange {
  path: string;
  /** Path on main, when the file was renamed. */
  basePath?: string;
  base: string | null;
  head: string | null;
}

export interface CheckOptions {
  presets?: PresetSpec[];
  policy?: Policy;
  /** Project these flags instead of detecting new ones. */
  flags?: string[];
  /** Whether main reads this flag anywhere, including files the branch didn't touch. */
  existsOnBase?: (key: string) => boolean;
  /**
   * Whether a file the branch didn't change might import this new file. Without it,
   * only changed files count as importers.
   */
  importedElsewhere?: (path: string, lang: LanguageAdapter) => boolean;
  adapters?: LanguageAdapter[];
}

export interface CheckResult {
  newFlags: string[];
  leaks: ReportedLeak[];
  /** What projection took out, per file, for the report. */
  removed: { file: string; what: string }[];
}

interface CodeFile {
  change: FileChange;
  lang: LanguageAdapter;
  base: N;
  head: N;
  comments: Comment[];
  removed: string[];
}

const ALLOW = /gatecheck-allow:\s*(.+?)\s*(?:\*\/)?$/;

function adapterFor(path: string, adapters: LanguageAdapter[]): LanguageAdapter | undefined {
  return adapters.find((a) => a.extensions.includes(posix.extname(path)));
}

/**
 * One change often touches neighboring statements (split a line into two, add a guard
 * and its body). Report it once, so one allow comment covers it.
 */
function mergeAdjacent(leaks: Leak[]): Leak[] {
  const out: Leak[] = [];
  for (const leak of [...leaks].sort((a, b) => a.head.line - b.head.line)) {
    const prev = out.at(-1);
    const sameKind = prev && prev.decl === leak.decl && prev.kind === leak.kind && prev.kind !== 'ungated-deletion' && !prev.additive && !leak.additive;
    if (prev && sameKind && leak.head.line <= prev.head.endLine + 1) {
      prev.head = { line: prev.head.line, endLine: Math.max(prev.head.endLine, leak.head.endLine) };
      if (leak.base) {
        prev.base = prev.base
          ? { line: Math.min(prev.base.line, leak.base.line), endLine: Math.max(prev.base.endLine, leak.base.endLine) }
          : leak.base;
      }
      continue;
    }
    out.push({ ...leak });
  }
  return out;
}

export async function checkFiles(changes: FileChange[], options: CheckOptions = {}): Promise<CheckResult> {
  const { presets = [BUILTIN_PRESETS.launchdarkly], policy, flags, existsOnBase, importedElsewhere, adapters = DEFAULT_ADAPTERS } = options;
  const rules = { ...DEFAULT_POLICY, ...policy };
  const leaks: ReportedLeak[] = [];
  const code: CodeFile[] = [];

  for (const change of changes) {
    if (/(^|\/)gatecheck\.config\.[a-z]+$/.test(change.path)) continue; // our own config
    const lang = adapterFor(change.path, adapters);
    if (!lang) {
      leaks.push({
        file: change.path,
        kind: 'outside-projection',
        decl: change.head === null ? 'deleted file' : change.base === null ? 'new file' : 'file',
        head: { line: 1, endLine: 1 },
        severity: rules['outside-projection'],
      });
      continue;
    }
    const base = await lang.parse(change.base ?? '', presets);
    const head = await lang.parse(change.head ?? '', presets);
    code.push({ change, lang, base: base.tree, head: head.tree, comments: head.comments, removed: [] });
  }

  // A flag is new if the branch reads it and main doesn't, anywhere.
  const baseKeys = new Set(code.flatMap((f) => [...f.lang.collectFlagKeys(f.base)]));
  const headKeys = new Set(code.flatMap((f) => [...f.lang.collectFlagKeys(f.head)]));
  const newKeys = flags
    ? new Set(flags.map(canonicalKey))
    : new Set([...headKeys].filter((k) => !baseKeys.has(k) && !existsOnBase?.(k)));

  // Imports compare by the file they point at, and a renamed file counts as its old self,
  // so a rename alone doesn't make every importer look changed.
  const renamed = new Map(
    code.filter((f) => f.change.basePath).map((f) => [f.lang.moduleStem(f.change.path), f.lang.moduleStem(f.change.basePath!)]),
  );
  for (const f of code) {
    f.lang.mapImportSources(f.base, (s) => f.lang.resolveImport(f.change.basePath ?? f.change.path, s));
    f.lang.mapImportSources(f.head, (s) => {
      const target = f.lang.resolveImport(f.change.path, s);
      return renamed.get(target) ?? target;
    });
  }

  for (const f of code) {
    // Both sides, so --flag naming a flag main already reads compares flag-off to flag-off.
    f.lang.substituteFlags(f.base, newKeys, []);
    f.lang.substituteFlags(f.head, newKeys, f.removed);
    f.base = f.lang.simplify(f.base);
    f.head = f.lang.simplify(f.head);
  }

  // Prune across files until nothing changes: removing a dead branch in one file can
  // make another file's new export, or a whole new file, unreachable.
  // Imports are canonical by now: the target path without extension, old path for renames.
  const byStem = new Map<string, string>();
  for (const f of code) {
    byStem.set(f.lang.moduleStem(f.change.path), f.change.path);
    if (f.change.basePath) byStem.set(f.lang.moduleStem(f.change.basePath), f.change.path);
  }
  const target = (source: string): string | undefined => {
    if (!source.startsWith('~/')) return byStem.get(source);
    // Only the end of the path is known; any changed file ending that way may be it.
    const tail = source.slice(2);
    for (const [stem, path] of byStem) if (stem === tail || stem.endsWith(`/${tail}`)) return path;
    return undefined;
  };
  const empty = (n: N) => !n.children.some((c) => c.named);
  // A new file an untouched file may import keeps all its exports. Asked once per file.
  const elsewhere = new Map<string, boolean>();
  const importedByUntouched = (path: string) => {
    const lang = adapterFor(path, adapters)!;
    if (!elsewhere.has(path)) elsewhere.set(path, importedElsewhere?.(path, lang) ?? false);
    return elsewhere.get(path)!;
  };
  for (let changed = true; changed; ) {
    changed = false;
    const keep = new Map<string, Set<string>>();
    for (const f of code) {
      for (const imp of f.lang.imports(f.head)) {
        const path = target(imp.source);
        if (!path) continue;
        const names = keep.get(path) ?? new Set<string>();
        for (const n of imp.names) names.add(n);
        keep.set(path, names);
      }
    }
    for (const f of code) {
      const before = ser(f.head);
      const isNew = f.change.base === null;
      if (isNew && !keep.has(f.change.path) && !empty(f.head) && !importedByUntouched(f.change.path)) {
        // Nothing that runs with the flag off imports this new file.
        f.head = { ...f.head, children: [] };
        f.removed.push('unreached new file');
      } else {
        const names = keep.get(f.change.path) ?? new Set<string>();
        if (isNew && importedByUntouched(f.change.path)) names.add('*');
        f.lang.pruneAdditions(f.head, f.base, f.removed, names);
      }
      if (ser(f.head) !== before) changed = true;
    }
  }

  for (const f of code) {
    const found = mergeAdjacent(compareTopLevel(f.lang.topLevel(f.base), f.lang.topLevel(f.head), f.head, f.lang.insertionClassifier(f.base)));
    // An allow comment covers a leak that starts on its line or the line after.
    const allows = f.comments.flatMap((c) => {
      const m = ALLOW.exec(c.text);
      return m ? [{ line: c.row + 1, reason: m[1] }] : [];
    });
    for (const leak of found) {
      const allow = allows.find((a) => leak.head.line === a.line || leak.head.line === a.line + 1);
      leaks.push(
        allow
          ? { ...leak, file: f.change.path, allowed: allow.reason, severity: 'allow' }
          : { ...leak, file: f.change.path, severity: rules[leak.additive ?? leak.kind] },
      );
    }
  }

  return {
    newFlags: [...newKeys],
    leaks: leaks.sort((a, b) => a.file.localeCompare(b.file) || a.head.line - b.head.line),
    removed: code.flatMap((f) => f.removed.map((what) => ({ file: f.change.path, what }))),
  };
}
