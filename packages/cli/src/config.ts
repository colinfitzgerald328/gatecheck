import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_PRESETS, type Config, type PresetSpec } from '@gatecheck/core';

const CONFIG_NAMES = ['gatecheck.config.ts', 'gatecheck.config.mjs', 'gatecheck.config.js', 'gatecheck.config.json'];

export function findConfig(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of CONFIG_NAMES) if (existsSync(join(dir, name))) return join(dir, name);
    if (dirname(dir) === dir) return undefined;
  }
}

export interface LoadedConfig {
  presets: PresetSpec[];
  policy: Config['policy'];
  base?: string;
  hooks: Required<NonNullable<Config['hooks']>>;
  test?: Config['test'];
}

export async function loadConfig(path: string | undefined): Promise<LoadedConfig> {
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
  return {
    presets,
    policy: config.policy,
    base: config.base,
    hooks: { postEdit: 'on', stop: 'warn', requireNewFlag: true, ...config.hooks },
    test: config.test,
  };
}
