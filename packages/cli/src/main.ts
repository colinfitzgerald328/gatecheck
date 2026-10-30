#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BUILTIN_PRESETS,
  branchChanges,
  checkFiles,
  importedOnRef,
  keyOnRef,
  readAt,
  repoRoot,
  runBench,
  type CheckResult,
  type Config,
  type Expectation,
  type PresetSpec,
  type ReportedLeak,
  type Score,
} from '@gatecheck/core';
import { describe, github, markdown, why, type Sources } from './formats.ts';

const USAGE = `gatecheck: check that new code is fully behind its feature flags

Usage:
  gatecheck check [--base main] [--head <ref>]   every file the branch changed
  gatecheck file <path> --base <ref>             one file against a git ref
  gatecheck file <base-file> <head-file>         two files
  gatecheck bench <expected-dir> --repo <path>   score against labeled test branches

Options:
  --base <ref>      what the branch is compared to (default: main)
  --head <ref>      check a ref instead of the working tree
  --flag <key>      project this flag instead of detecting new ones (repeatable)
  --config <path>   config file (default: nearest gatecheck.config.{ts,mjs,json})
  --format <f>      text (default), json, markdown (PR comment) or github (annotations)
  --json            same as --format json

Exit codes: 0 no errors, 1 leaks at error severity, 2 usage error.
`;

const CONFIG_NAMES = ['gatecheck.config.ts', 'gatecheck.config.mjs', 'gatecheck.config.js', 'gatecheck.config.json'];

function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of CONFIG_NAMES) if (existsSync(join(dir, name))) return join(dir, name);
    if (dirname(dir) === dir) return undefined;
  }
}

async function loadConfig(path: string | undefined): Promise<{ presets: PresetSpec[]; policy: Config['policy'] }> {
  const config: Config = !path
    ? {}
    : path.endsWith('.json')
      ? JSON.parse(readFileSync(path, 'utf8'))
      : ((await import(pathToFileURL(resolve(path)).href)).default ?? {});
  const presets = (config.presets ?? ['launchdarkly']).map((p): PresetSpec => {
    if (typeof p === 'string') {
      const builtin = BUILTIN_PRESETS[p];
      if (!builtin) throw new Error(`Unknown preset "${p}". Built in: ${Object.keys(BUILTIN_PRESETS).join(', ')}`);
      return builtin;
    }
    // A query ending in .scm is a file path, relative to the config file.
    const queries = Object.fromEntries(
      Object.entries(p.queries).map(([lang, q]) => [lang, q && /^[^\n]*\.scm$/.test(q) ? readFileSync(resolve(dirname(path!), q), 'utf8') : q]),
    );
    return { ...p, queries };
  });
  return { presets, policy: config.policy };
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

function snippet(source: string | null | undefined, from: number, to: number, max = 4): string[] {
  if (!source) return [];
  const lines = source.split('\n').slice(from - 1, to);
  return lines.length > max ? [...lines.slice(0, max), '…'] : lines;
}

function output(format: string, result: CheckResult, sources: Sources, title: string): void {
  if (format === 'json') console.log(JSON.stringify(result, null, 2));
  else if (format === 'markdown') console.log(markdown(result, sources, title));
  else if (format === 'github') {
    const annotations = github(result);
    if (annotations) console.log(annotations);
  } else printText(title, result, sources);
}

function printText(title: string, result: CheckResult, sources: Sources): void {
  const { newFlags, leaks, removed } = result;
  console.log(`${bold('gatecheck')} ${dim(title)}`);
  console.log(dim(`new flags: ${newFlags.join(', ') || 'none'}`));
  console.log();

  const groups: [string, ReportedLeak[], (s: string) => string, string][] = [
    ['leak', leaks.filter((l) => l.severity === 'error'), red, '✗'],
    ['warning', leaks.filter((l) => l.severity === 'warn'), yellow, '!'],
    ['allowed', leaks.filter((l) => l.severity === 'allow'), green, '✓'],
  ];
  for (const [label, group, tint, mark] of groups) {
    if (group.length === 0) continue;
    const plural = group.length === 1 || label === 'allowed' ? label : `${label}s`;
    console.log(tint(`${mark} ${group.length} ${plural}`));
    for (const leak of group) {
      const src = sources.get(leak.file);
      console.log(`  ${leak.file}:${leak.head.line}  ${tint(describe(leak))}  ${dim(`in ${leak.decl}`)}`);
      if (leak.kind === 'outside-projection') {
        console.log(dim('    not code gatecheck can project; review it by hand'));
        continue;
      }
      if (leak.base) for (const l of snippet(src?.base, leak.base.line, leak.base.endLine)) console.log(red(`    - ${l.trim()}`));
      if (leak.kind !== 'ungated-deletion') for (const l of snippet(src?.head, leak.head.line, leak.head.endLine)) console.log(green(`    + ${l.trim()}`));
      if (leak.allowed) console.log(dim(`    allowed: ${leak.allowed}`));
      else if (leak.severity === 'error') {
        console.log(dim(`    ${why(newFlags)}. Move it behind a flag, or add // gatecheck-allow: <reason>`));
      }
    }
    console.log();
  }
  if (!leaks.some((l) => l.severity === 'error')) console.log(green('✓ no leaks'));
  if (removed.length) {
    const byFile = Map.groupBy(removed, (r) => r.file);
    console.log(dim('removed by projection:'));
    for (const [file, items] of byFile) console.log(dim(`  ${file}: ${items.map((i) => i.what).join(', ')}`));
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '   —' : `${Math.round((100 * n) / d)}%`.padStart(4);
}

function scoreLine(label: string, s: Score): string {
  return `  ${label.padEnd(24)} ${pct(s.tp, s.tp + s.fp)} ${pct(s.tp, s.tp + s.fn)}   ${dim(`tp ${s.tp}  fp ${s.fp}  fn ${s.fn}`)}`;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      repo: { type: 'string' },
      flag: { type: 'string', multiple: true },
      config: { type: 'string' },
      json: { type: 'boolean' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  const format = values.json ? 'json' : (values.format ?? 'text');
  if (!['text', 'json', 'markdown', 'github'].includes(format)) {
    console.error(`Unknown format "${format}". Use text, json, markdown or github.`);
    return 2;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  if (command === 'check') {
    const root = repoRoot(process.cwd());
    const { presets, policy } = await loadConfig(values.config ?? findConfig(process.cwd()));
    const base = values.base ?? 'main';
    const { mergeBase, changes } = branchChanges(root, base, values.head);
    const changed = changes.map((c) => c.path);
    const result = await checkFiles(changes, {
      presets,
      policy,
      flags: values.flag,
      existsOnBase: (k) => keyOnRef(root, mergeBase, k),
      importedElsewhere: (p) => importedOnRef(root, values.head, p, changed),
    });
    const title = `${values.head ?? 'working tree'} vs ${base}, ${changes.length} changed ${changes.length === 1 ? 'file' : 'files'}`;
    output(format, result, new Map(changes.map((c) => [c.path, c])), title);
    return result.leaks.some((l) => l.severity === 'error') ? 1 : 0;
  }

  if (command === 'file') {
    let base: string | null;
    let head: string | null;
    let path: string;
    if (values.base && args.length === 1) {
      path = args[0];
      head = readFileSync(path, 'utf8');
      const root = repoRoot(dirname(resolve(path)));
      base = readAt(root, values.base, resolve(path).slice(root.length + 1));
    } else if (args.length === 2) {
      path = args[1];
      base = readFileSync(args[0], 'utf8');
      head = readFileSync(args[1], 'utf8');
    } else {
      console.error('Pass a file and --base <git-ref>, or two files.\n');
      console.log(USAGE);
      return 2;
    }
    const { presets, policy } = await loadConfig(values.config ?? findConfig(dirname(resolve(path))));
    const result = await checkFiles([{ path, base, head }], { presets, policy, flags: values.flag });
    output(format, result, new Map([[path, { base, head }]]), path);
    return result.leaks.some((l) => l.severity === 'error') ? 1 : 0;
  }

  if (command === 'bench') {
    if (args.length !== 1 || !values.repo) {
      console.error('Usage: gatecheck bench <expected-dir> --repo <path>\n');
      return 2;
    }
    const dir = resolve(args[0]);
    const expectations: Expectation[] = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    const root = repoRoot(resolve(values.repo));
    const { presets, policy } = await loadConfig(values.config ?? findConfig(root));
    const result = await runBench(root, expectations, { presets, policy });

    if (format === 'json') {
      console.log(JSON.stringify({ ...result, byCategory: Object.fromEntries(result.byCategory) }, null, 2));
      return result.total.fp + result.total.fn > 0 ? 1 : 0;
    }
    console.log(`${bold('gatecheck bench')} ${dim(`${expectations.length} branches in ${values.repo}`)}\n`);
    for (const b of result.branches) {
      const ok = b.fp === 0 && b.fn === 0;
      console.log(`  ${ok ? green('✓') : red('✗')} ${b.branch.padEnd(32)} ${dim(`tp ${b.tp}  fp ${b.fp}  fn ${b.fn}`)}`);
      for (const e of b.extra) console.log(yellow(`      false report: ${e}`));
      for (const m of b.missed) console.log(red(`      missed: ${m}`));
    }
    console.log(`\n  ${''.padEnd(24)} ${'prec'.padStart(4)} ${'rec'.padStart(4)}`);
    for (const [category, s] of [...result.byCategory].sort()) console.log(scoreLine(category, s));
    console.log(bold(scoreLine('total', result.total)));
    return result.total.fp + result.total.fn > 0 ? 1 : 0;
  }

  console.error(`Unknown command "${command}".\n`);
  console.log(USAGE);
  return 2;
}

process.exitCode = await main();
