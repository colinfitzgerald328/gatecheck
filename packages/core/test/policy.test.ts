import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSource } from '../src/index.ts';

const base = `export interface Order {\n  id: string;\n}\n`;
const head = `export interface Order {\n  id: string;\n  giftNote?: string;\n}\n`;

test('additive changes are allowed by default', async () => {
  const { leaks } = await checkSource({ base, head });
  assert.equal(leaks[0].severity, 'allow');
});

test('policy can tighten an additive kind', async () => {
  const { leaks } = await checkSource({ base, head, policy: { 'optional-field': 'error' } });
  assert.equal(leaks[0].severity, 'error');
});

test('--flag projects an existing flag', async () => {
  const b = `export function f() {\n  return 1;\n}\n`;
  const h = `export function f() {\n  if (ldClient.variation('old-flag', false)) return 2;\n  return 1;\n}\n`;
  assert.equal((await checkSource({ base: b, head: h })).leaks.length, 0);
  const withOldFlagOnBase = `export function g() { return ldClient.variation('old-flag', false); }\n` + b;
  const headToo = `export function g() { return ldClient.variation('old-flag', false); }\n` + h;
  assert.equal((await checkSource({ base: withOldFlagOnBase, head: headToo })).leaks.length, 1);
  assert.equal((await checkSource({ base: withOldFlagOnBase, head: headToo, flags: ['old-flag'] })).leaks.length, 0);
});
