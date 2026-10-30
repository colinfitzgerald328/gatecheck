import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange } from './check.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** File contents at a ref, or in the working tree when `ref` is undefined. `null` if absent. */
export function readAt(root: string, ref: string | undefined, path: string): string | null {
  if (ref === undefined) {
    const file = join(root, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  const result = spawnSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Every file the branch changed since it split from `baseRef`. With no `headRef`,
 * the branch is the working tree, including uncommitted and untracked files.
 */
export function branchChanges(root: string, baseRef: string, headRef?: string): { mergeBase: string; changes: FileChange[] } {
  const mergeBase = git(root, ['merge-base', baseRef, headRef ?? 'HEAD']).trim();
  const diffArgs = ['diff', '--name-status', '-M', '-z', mergeBase, ...(headRef ? [headRef] : [])];
  const fields = git(root, diffArgs).split('\0').filter(Boolean);

  const changes: FileChange[] = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = fields[i++];
      const to = fields[i++];
      changes.push({ path: to, basePath: from, base: readAt(root, mergeBase, from), head: readAt(root, headRef, to) });
    } else {
      const path = fields[i++];
      changes.push({
        path,
        base: status === 'A' ? null : readAt(root, mergeBase, path),
        head: status === 'D' ? null : readAt(root, headRef, path),
      });
    }
  }
  if (!headRef) {
    for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
      changes.push({ path, base: null, head: readAt(root, undefined, path) });
    }
  }
  return { mergeBase, changes };
}

// Only code counts: a key mentioned in a README or a changelog isn't a flag read.
const CODE_PATHSPECS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];

/**
 * Whether any file at `ref` mentions the flag, in any key spelling: `expressCheckout`
 * also matches `express-checkout` and `express_checkout`. Over-matching only means a
 * flag is treated as existing, which reports more, never less.
 */
export function keyOnRef(root: string, ref: string, canonical: string): boolean {
  const words = canonical.split(/(?=[A-Z])/).map((w) => w.replace(/[^A-Za-z0-9]/g, ''));
  const pattern = words.join('[-_.]?');
  const result = spawnSync('git', ['grep', '-q', '-i', '-E', pattern, ref, '--', ...CODE_PATHSPECS], { cwd: root });
  return result.status === 0;
}

/**
 * Whether any file at `ref` (or the working tree) other than the branch's changed
 * files has an import that could point at `path`. Matches on the file name, so it
 * over-matches; that keeps a new file in the check, which reports more, never less.
 */
export function importedOnRef(root: string, ref: string | undefined, path: string, changed: string[]): boolean {
  const base = path.split('/').pop()!.replace(/\.(m|c)?[jt]sx?$/, '');
  const name = base === 'index' ? path.split('/').at(-2)! : base;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `(from|import|require\\()[[:space:]]*\\(?['"][^'"]*/${escaped}(\\.[a-z]+)?['"]`;
  const args = ['grep', '-l', '-E', pattern, ...(ref ? [ref] : []), '--', ...CODE_PATHSPECS];
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return false;
  const exclude = new Set(changed);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => (ref ? line.slice(ref.length + 1) : line))
    .some((file) => !exclude.has(file));
}
