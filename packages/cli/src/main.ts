#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkSource, PRESETS, type Config, type ReportedLeak } from '@gatecheck/core';

const USAGE = `gatecheck: check that new code is fully behind its feature flags

Usage:
  gatecheck file <path> --base <git-ref>     compare a file against a git ref
  gatecheck file <base-file> <head-file>     compare two files

Options:
  --flag <key>      project this flag instead of detecting new ones (repeatable)
  --config <path>   config file (default: nearest gatecheck.config.{ts,mjs,json})
  --json            machine-readable output
`;

const CONFIG_NAMES = ['gatecheck.config.ts', 'gatecheck.config.mjs', 'gatecheck.config.js', 'gatecheck.config.json'];

function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of CONFIG_NAMES) if (existsSync(join(dir, name))) return join(dir, name);
    if (dirname(dir) === dir) return undefined;
  }
}

async function loadConfig(path: string | undefined): Promise<Config> {
  if (!path) return {};
  if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'));
  return (await import(pathToFileURL(resolve(path)).href)).default ?? {};
}

function gitShow(ref: string, path: string): string {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(resolve(path)), encoding: 'utf8' }).trim();
  const rel = resolve(path).slice(root.length + 1);
  try {
    return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // new file: everything in it is an addition
  }
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

function lines(source: string, from: number, to: number, max = 4): string[] {
  const all = source.split('\n').slice(from - 1, to);
  return all.length > max ? [...all.slice(0, max), '…'] : all;
}

function describe(leak: ReportedLeak): string {
  return leak.additive ? `additive: ${leak.additive}` : leak.kind;
}

function printText(path: string, base: string, head: string, newFlags: string[], leaks: ReportedLeak[], removed: string[]): void {
  console.log(`${bold('gatecheck')} ${dim(path)}`);
  console.log(dim(`new flags: ${newFlags.join(', ') || 'none'}`));
  console.log();

  const groups: [string, ReportedLeak[], (s: string) => string][] = [
    ['leak', leaks.filter((l) => l.severity === 'error'), red],
    ['warning', leaks.filter((l) => l.severity === 'warn'), yellow],
    ['allowed', leaks.filter((l) => l.severity === 'allow'), green],
  ];
  for (const [label, group, tint] of groups) {
    if (group.length === 0) continue;
    const plural = group.length === 1 || label === 'allowed' ? label : `${label}s`;
    console.log(tint(`${label === 'leak' ? '✗' : label === 'warning' ? '!' : '✓'} ${group.length} ${plural}`));
    for (const leak of group) {
      console.log(`  ${path}:${leak.head.line}  ${tint(describe(leak))}  ${dim(`in ${leak.decl}`)}`);
      if (leak.base) for (const l of lines(base, leak.base.line, leak.base.endLine)) console.log(red(`    - ${l.trim()}`));
      if (leak.kind !== 'ungated-deletion') for (const l of lines(head, leak.head.line, leak.head.endLine)) console.log(green(`    + ${l.trim()}`));
      if (leak.allowed) console.log(dim(`    allowed: ${leak.allowed}`));
      else if (leak.severity === 'error') console.log(dim(`    runs with ${newFlags.join(', ') || 'the flag'} off. Move it behind the flag, or add // gatecheck-allow: <reason>`));
    }
    console.log();
  }
  if (!leaks.some((l) => l.severity !== 'allow')) console.log(green('✓ no leaks'));
  if (removed.length) console.log(dim(`removed by projection: ${removed.join(', ')}`));
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      flag: { type: 'string', multiple: true },
      config: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || command !== 'file' || args.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  let base: string;
  let head: string;
  let path: string;
  if (values.base) {
    path = args[0];
    head = readFileSync(path, 'utf8');
    base = gitShow(values.base, path);
  } else if (args.length === 2) {
    path = args[1];
    base = readFileSync(args[0], 'utf8');
    head = readFileSync(args[1], 'utf8');
  } else {
    console.error('Pass --base <git-ref>, or two files.');
    return 2;
  }

  const config = await loadConfig(values.config ?? findConfig(dirname(resolve(path))));
  const result = await checkSource({
    base,
    head,
    preset: PRESETS[config.preset ?? 'launchdarkly'],
    policy: config.policy,
    flags: values.flag,
  });

  if (values.json) console.log(JSON.stringify({ file: path, ...result }, null, 2));
  else printText(path, base, head, result.newFlags, result.leaks, result.removed);
  return result.leaks.some((l) => l.severity === 'error') ? 1 : 0;
}

process.exitCode = await main();
