import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBase, repoRoot } from '@gatecheck/core';
import { findConfig } from './config.ts';

/** Writes a starter gatecheck.config.json at the repo root. */
export function runInit(cwd: string): number {
  let root: string;
  try {
    root = repoRoot(cwd);
  } catch {
    console.error('gatecheck init: run this inside a git repository.');
    return 2;
  }
  const existing = findConfig(cwd);
  if (existing?.startsWith(root)) {
    console.error(`gatecheck init: ${existing} already exists.`);
    return 2;
  }

  const pkg = join(root, 'package.json');
  const deps = existsSync(pkg) ? JSON.stringify(JSON.parse(readFileSync(pkg, 'utf8'))) : '';
  if (deps && !/launchdarkly/.test(deps)) {
    console.error('Note: no LaunchDarkly SDK in package.json. Add a custom preset to "presets" for your flag SDK.');
  }

  const config = {
    base: defaultBase(root),
    presets: ['launchdarkly'],
    policy: {},
    hooks: { postEdit: 'on', stop: 'warn', requireNewFlag: true },
  };
  const path = join(root, 'gatecheck.config.json');
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${path}. With the Claude Code plugin installed, its hooks now run in this repo.`);
  return 0;
}
