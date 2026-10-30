import { readFileSync } from 'node:fs';
import type { PresetSpec } from './types.ts';

const query = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

export const BUILTIN_PRESETS = {
  launchdarkly: { vendor: 'launchdarkly', queries: { tsx: query('./launchdarkly.tsx.scm') } },
} satisfies Record<string, PresetSpec>;

export type BuiltinPreset = keyof typeof BUILTIN_PRESETS;
