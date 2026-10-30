import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkSource } from '../src/index.ts';

const root = new URL('./fixtures/', import.meta.url);

for (const name of readdirSync(root).sort()) {
  test(name, async () => {
    const read = (file: string) => readFileSync(new URL(`${name}/${file}`, root), 'utf8');
    const ext = readdirSync(new URL(`${name}/`, root)).find((f) => f.startsWith('base.'))!.slice('base'.length);
    const result = await checkSource({ path: `input${ext}`, base: read(`base${ext}`), head: read(`head${ext}`) });
    const actual = result.leaks.map((l) => ({
      kind: l.kind,
      ...(l.additive ? { additive: l.additive } : {}),
      line: l.head.line,
      severity: l.severity,
    }));
    assert.deepEqual(actual, JSON.parse(read('expected.json')).leaks);
  });
}
