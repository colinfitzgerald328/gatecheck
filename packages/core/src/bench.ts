import { checkBranch } from './branch.ts';
import type { CheckOptions } from './check.ts';
import type { Category } from './compare.ts';
import { runDynamic } from './dynamic.ts';

/** Hand-labeled result for one test branch. */
export interface Expectation {
  branch: string;
  base?: string;
  /** `name` identifies a test finding, since runners like node --test report no line. */
  leaks: { file: string; line: number; category: Category; name?: string }[];
  /** Also run this test command on both sides, as `gatecheck check --test` does. */
  test?: string;
}

export interface Score {
  tp: number;
  fp: number;
  fn: number;
}

export interface BranchScore extends Score {
  branch: string;
  /** Reported but not expected. */
  extra: string[];
  /** Expected but not reported. */
  missed: string[];
}

export interface BenchResult {
  branches: BranchScore[];
  byCategory: Map<Category, Score>;
  total: Score;
}

const id = (l: { file: string; line: number; category: Category; name?: string }) =>
  `${l.file}:${l.line} ${l.category}${l.category.startsWith('test-') && l.name ? ` "${l.name}"` : ''}`;

export async function runBench(
  root: string,
  expectations: Expectation[],
  options: Omit<CheckOptions, 'existsOnBase' | 'importedElsewhere'> = {},
): Promise<BenchResult> {
  const byCategory = new Map<Category, Score>();
  const bump = (category: Category, key: keyof Score) => {
    const s = byCategory.get(category) ?? { tp: 0, fp: 0, fn: 0 };
    s[key]++;
    byCategory.set(category, s);
  };
  const branches: BranchScore[] = [];

  for (const exp of expectations) {
    const { result, mergeBase } = await checkBranch(root, exp.base ?? 'main', exp.branch, options);
    if (exp.test) {
      const dynamic = runDynamic({ root, mergeBase, head: exp.branch, command: exp.test, newFlags: result.newFlags });
      result.leaks.push(...dynamic.leaks.map((l) => ({ ...l, severity: 'error' as const })));
    }
    const actual = result.leaks.map((l) => ({ file: l.file, line: l.head.line, category: l.additive ?? l.kind, name: l.decl }));
    const expected = new Map(exp.leaks.map((l) => [id(l), l]));
    const reported = new Map(actual.map((l) => [id(l), l]));

    const score: BranchScore = { branch: exp.branch, tp: 0, fp: 0, fn: 0, extra: [], missed: [] };
    for (const [key, l] of reported) {
      if (expected.has(key)) {
        score.tp++;
        bump(l.category, 'tp');
      } else {
        score.fp++;
        score.extra.push(key);
        bump(l.category, 'fp');
      }
    }
    for (const [key, l] of expected) {
      if (reported.has(key)) continue;
      score.fn++;
      score.missed.push(key);
      bump(l.category, 'fn');
    }
    branches.push(score);
  }

  const total = branches.reduce((t, b) => ({ tp: t.tp + b.tp, fp: t.fp + b.fp, fn: t.fn + b.fn }), { tp: 0, fp: 0, fn: 0 });
  return { branches, byCategory, total };
}
