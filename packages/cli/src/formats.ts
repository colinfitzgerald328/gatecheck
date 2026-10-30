import type { CheckResult, ReportedLeak } from '@gatecheck/core';

export type Sources = Map<string, { base: string | null; head: string | null }>;

/** Marks gatecheck's PR comment so later runs update it instead of adding another. */
export const COMMENT_MARKER = '<!-- gatecheck -->';

export function describe(leak: ReportedLeak): string {
  return leak.additive ? `additive: ${leak.additive}` : leak.kind;
}

/** The allow comment in the file's own comment syntax. */
export function allowComment(file: string): string {
  return `${/\.pyi?$/.test(file) ? '#' : '//'} gatecheck-allow: <reason>`;
}

export function why(newFlags: string[]): string {
  return newFlags.length ? `Runs with ${newFlags.join(', ')} off` : 'No new flag gates this';
}

function snippet(source: string | null | undefined, from: number, to: number, max = 8): string[] {
  if (!source) return [];
  const lines = source.split('\n').slice(from - 1, to);
  return lines.length > max ? [...lines.slice(0, max), '…'] : lines;
}

/** GitHub workflow commands: each becomes an annotation on the PR's changed lines. */
export function github(result: CheckResult): string {
  const escape = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return result.leaks
    .filter((l) => l.severity !== 'allow')
    .map((l) => {
      const level = l.severity === 'error' ? 'error' : 'warning';
      const message =
        l.kind === 'outside-projection'
          ? 'gatecheck can’t project this file. Review it by hand.'
          : `${why(result.newFlags)}. Move it behind a flag, or add ${allowComment(l.file)}`;
      return `::${level} file=${l.file},line=${l.head.line},endLine=${l.head.endLine},title=gatecheck: ${describe(l)} in ${escape(l.decl)}::${escape(message)}`;
    })
    .join('\n');
}

/** A PR comment. */
export function markdown(result: CheckResult, sources: Sources, title: string): string {
  const { newFlags, leaks, removed } = result;
  const errors = leaks.filter((l) => l.severity === 'error');
  const warnings = leaks.filter((l) => l.severity === 'warn');
  const allowed = leaks.filter((l) => l.severity === 'allow');

  const status = errors.length
    ? `❌ **${errors.length} ${errors.length === 1 ? 'leak' : 'leaks'}**: ${errors.length === 1 ? 'a change runs' : 'changes run'} with the flag off`
    : '✅ **No leaks**: with the new flags off, this branch behaves like the base';
  const counts = [warnings.length && `${warnings.length} to review`, allowed.length && `${allowed.length} allowed`].filter(Boolean).join(' · ');
  const flags = newFlags.length ? newFlags.map((f) => `\`${f}\``).join(', ') : 'none';

  const out = [COMMENT_MARKER, `### gatecheck`, '', status, '', `New flags: ${flags}${counts ? ` · ${counts}` : ''} · ${title}`, ''];

  const section = (heading: string, group: ReportedLeak[], open: boolean) => {
    if (group.length === 0) return;
    out.push(`<details${open ? ' open' : ''}><summary><b>${heading} (${group.length})</b></summary>`, '');
    for (const leak of group) {
      out.push(`**\`${leak.file}:${leak.head.line}\`** · ${describe(leak)} · in \`${leak.decl}\``, '');
      if (leak.kind === 'outside-projection') {
        out.push('gatecheck can’t project this file. Review it by hand.', '');
        continue;
      }
      const src = sources.get(leak.file);
      const minus = leak.base ? snippet(src?.base, leak.base.line, leak.base.endLine).map((l) => `- ${l}`) : [];
      const plus = leak.kind === 'ungated-deletion' ? [] : snippet(src?.head, leak.head.line, leak.head.endLine).map((l) => `+ ${l}`);
      if (minus.length || plus.length) out.push('```diff', ...minus, ...plus, '```', '');
      if (leak.allowed) out.push(`Allowed: ${leak.allowed}`, '');
    }
    out.push('</details>', '');
  };
  section('Leaks', errors, true);
  section('Review by hand', warnings, true);
  section('Allowed', allowed, false);

  if (errors.length) {
    const comments = [...new Set(errors.map((l) => allowComment(l.file)))].map((c) => `\`${c}\``).join(' or ');
    out.push(`To fix a leak, move the change behind the new flag. If it's intentional, add ${comments} on the line before it.`, '');
  }
  if (removed.length) {
    out.push('<details><summary>Removed by projection</summary>', '');
    for (const [file, items] of Map.groupBy(removed, (r) => r.file)) out.push(`- \`${file}\`: ${items.map((i) => i.what).join(', ')}`);
    out.push('', '</details>', '');
  }
  return out.join('\n');
}
