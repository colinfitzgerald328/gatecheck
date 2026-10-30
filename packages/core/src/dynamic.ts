import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Leak } from './compare.ts';

export interface TestOutcome {
  /** `file::name`, stable across both runs. */
  id: string;
  file: string;
  name: string;
  line?: number;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
}

const decode = (s: string) =>
  s
    .replace(/&#10;/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** "Expected values to be strictly equal:\n\n55 !== 50" → "Expected values to be strictly equal: 55 !== 50". */
function oneLine(message: string, max = 200): string {
  const text = message.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]) : undefined;
}

/**
 * Reads the `<testcase>` entries of a JUnit XML report (node --test, vitest, pytest and
 * most other runners write one). `root` makes file paths relative to the checkout.
 */
export function parseJUnit(xml: string, root: string): TestOutcome[] {
  const out: TestOutcome[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const tag = m[1];
    const body = m[3] ?? '';
    const name = attr(tag, 'name') ?? '(unnamed)';
    let file = attr(tag, 'file') ?? attr(tag, 'classname') ?? '';
    if (isAbsolute(file)) file = relative(root, file);
    const failure = /<(failure|error)\b([^>]*)>/.exec(body);
    const status = failure ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    const line = attr(tag, 'line');
    out.push({
      id: `${file}::${name}`,
      file,
      name,
      line: line ? Number(line) : undefined,
      status,
      message: failure ? oneLine(attr(failure[2], 'message') ?? '') : undefined,
    });
  }
  return out;
}

/** Adds the runner's JUnit flags, or fills a `{junit}` placeholder. */
export function withJUnit(command: string, out: string): string {
  if (command.includes('{junit}')) return command.replaceAll('{junit}', out);
  // Node reads its options only before the first file argument, so they go right after --test.
  if (/\bnode\b.*\s--test(\s|$)/.test(command)) {
    return command.replace(/(\s)--test(?=\s|$)/, `$1--test --test-reporter=junit --test-reporter-destination=${out}`);
  }
  if (/\bvitest\b/.test(command)) return `${command} --reporter=junit --outputFile=${out}`;
  if (/\bpytest\b/.test(command)) return `${command} --junitxml=${out}`;
  throw new Error(
    `gatecheck can't tell how to get JUnit XML from "${command}". Put {junit} where the report path goes, e.g. "npm test -- --reporter=junit --outputFile={junit}".`,
  );
}

export interface DynamicOptions {
  root: string;
  /** Where the branch split from main. */
  mergeBase: string;
  /** A ref to test, or the working tree when undefined. */
  head?: string;
  command: string;
  /** Canonical keys of the new flags; passed to tests in GATECHECK_FLAGS_OFF. */
  newFlags: string[];
}

export interface DynamicResult {
  base: TestOutcome[];
  head: TestOutcome[];
  leaks: (Leak & { file: string })[];
  /** Tests that failed once on the branch and passed when run again. */
  flaky: string[];
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function run(cwd: string, command: string, newFlags: string[]): { outcomes: TestOutcome[]; output: string } {
  const report = join(mkdtempSync(join(tmpdir(), 'gatecheck-junit-')), 'report.xml');
  const flagsOff = [...new Set(newFlags.flatMap((k) => [k, kebab(k)]))].join(',');
  const result = spawnSync(withJUnit(command, report), {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', GATECHECK: '1', GATECHECK_FLAGS_OFF: flagsOff },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!existsSync(report)) {
    throw new Error(`The test command wrote no JUnit report in ${cwd}. Its output:\n${output.slice(-2000)}`);
  }
  return { outcomes: parseJUnit(readFileSync(report, 'utf8'), cwd), output };
}

function git(root: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** A detached worktree at `ref`, sharing the main checkout's node_modules. */
function worktree(root: string, ref: string): { dir: string; remove: () => void } {
  // Real path: on macOS the temp folder is a symlink, and test runners report real paths.
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'gatecheck-wt-'))), 'tree');
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, ref]);
  const deps = join(root, 'node_modules');
  if (existsSync(deps) && !existsSync(join(dir, 'node_modules'))) symlinkSync(deps, join(dir, 'node_modules'), 'dir');
  return {
    dir,
    remove: () => {
      spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs the tests on main and on the branch with the new flags off, and reports tests
 * that passed on main but fail on the branch, after one retry to rule out flakes.
 */
export function runDynamic(options: DynamicOptions): DynamicResult {
  const { root, mergeBase, head, command, newFlags } = options;
  const base = worktree(root, mergeBase);
  const headTree = head ? worktree(root, head) : undefined;
  const headDir = headTree?.dir ?? realpathSync(root);
  try {
    const before = run(base.dir, command, newFlags).outcomes;
    let after = run(headDir, command, newFlags).outcomes;
    const passedOnBase = new Map(before.filter((t) => t.status === 'pass').map((t) => [t.id, t]));
    let failing = after.filter((t) => t.status === 'fail' && passedOnBase.has(t.id));

    const flaky: string[] = [];
    if (failing.length > 0) {
      const again = new Map(run(headDir, command, newFlags).outcomes.map((t) => [t.id, t]));
      for (const t of failing) if (again.get(t.id)?.status === 'pass') flaky.push(t.id);
      failing = failing.filter((t) => !flaky.includes(t.id));
      after = after.map((t) => (flaky.includes(t.id) ? { ...t, status: 'pass' } : t));
    }

    const headIds = new Set(after.map((t) => t.id));
    const at = (t: TestOutcome) => ({ line: t.line ?? 1, endLine: t.line ?? 1 });
    const leaks: DynamicResult['leaks'] = [
      ...failing.map((t) => ({ kind: 'test-regression' as const, file: t.file, decl: t.name, head: at(t), detail: t.message })),
      ...before.filter((t) => !headIds.has(t.id)).map((t) => ({ kind: 'test-removed' as const, file: t.file, decl: t.name, head: at(t) })),
    ];
    return { base: before, head: after, leaks, flaky };
  } finally {
    base.remove();
    headTree?.remove();
  }
}
