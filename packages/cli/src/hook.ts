import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { checkBranch, defaultBase, repoRoot, type CheckResult, type ReportedLeak } from '@gatecheck/core';
import { findConfig, loadConfig } from './config.ts';
import { describe } from './formats.ts';

interface HookInput {
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
  stop_hook_active?: boolean;
}

function snippet(source: string | null | undefined, from: number, to: number, max = 6): string[] {
  if (!source) return [];
  const lines = source.split('\n').slice(from - 1, to);
  return lines.length > max ? [...lines.slice(0, max), '…'] : lines;
}

/** What Claude reads: where, what, and the two ways out. */
function report(intro: string, leaks: ReportedLeak[], result: CheckResult, sources: Map<string, { base: string | null; head: string | null }>): string {
  const flags = result.newFlags.join(', ');
  const out = [intro, ''];
  for (const leak of leaks) {
    out.push(`${leak.file}:${leak.head.line} in ${leak.decl} (${describe(leak)})`);
    const src = sources.get(leak.file);
    if (leak.base) for (const l of snippet(src?.base, leak.base.line, leak.base.endLine)) out.push(`- ${l}`);
    if (leak.kind !== 'ungated-deletion') for (const l of snippet(src?.head, leak.head.line, leak.head.endLine)) out.push(`+ ${l}`);
    out.push('');
  }
  out.push(
    `Every behavior change for this feature should only run when its flag (${flags}) is on.`,
    '- If the change is part of the feature, move it behind the flag.',
    '- If the user asked for it as its own change, keep it and add `// gatecheck-allow: <reason>` on the line before it.',
    "Don't revert work the user asked for just to clear this check.",
  );
  return out.join('\n');
}

export async function runHook(event: string): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    console.error('gatecheck hook: expected the hook event as JSON on stdin');
    return 1;
  }

  let root: string;
  try {
    root = repoRoot(input.cwd);
  } catch {
    return 0; // not a git repo
  }
  // Opt in per repo: no config file, no hooks.
  const configPath = findConfig(input.cwd);
  if (!configPath || !configPath.startsWith(root)) return 0;
  const config = await loadConfig(configPath);

  if (event === 'post-edit') {
    if (config.hooks.postEdit === 'off') return 0;
    const file = input.tool_input?.file_path;
    if (!file) return 0;
    const rel = relative(root, resolve(input.cwd, file));
    if (rel.startsWith('..')) return 0;

    const { result, changes } = await checkBranch(root, config.base ?? defaultBase(root), undefined, config);
    if (config.hooks.requireNewFlag && result.newFlags.length === 0) return 0;
    const leaks = result.leaks.filter((l) => l.file === rel && l.severity === 'error');
    if (leaks.length === 0) return 0;

    const count = leaks.length === 1 ? '1 change' : `${leaks.length} changes`;
    const intro = `gatecheck: after this edit, ${count} in ${rel} ${leaks.length === 1 ? 'runs' : 'run'} with the new flag off. If you're about to gate it, carry on.`;
    console.error(report(intro, leaks, result, new Map(changes.map((c) => [c.path, c]))));
    return 2; // shown to Claude
  }

  if (event === 'stop') {
    if (config.hooks.stop === 'off') return 0;
    const { result, changes } = await checkBranch(root, config.base ?? defaultBase(root), undefined, config);
    if (config.hooks.requireNewFlag && result.newFlags.length === 0) return 0;
    const leaks = result.leaks.filter((l) => l.severity === 'error');
    if (leaks.length === 0) return 0;

    const count = leaks.length === 1 ? '1 change runs' : `${leaks.length} changes run`;
    const sources = new Map(changes.map((c) => [c.path, c]));
    // Block once; if Claude stops again with leaks left, let it finish and tell the person.
    if (config.hooks.stop === 'block' && !input.stop_hook_active) {
      console.error(report(`gatecheck: before you finish, ${count} with the new flag off.`, leaks, result, sources));
      return 2;
    }
    const where = leaks.map((l) => `${l.file}:${l.head.line}`).join(', ');
    console.log(JSON.stringify({ systemMessage: `gatecheck: ${count} with ${result.newFlags.join(', ')} off (${where}). Run /gatecheck for details.` }));
    return 0;
  }

  return 0;
}
