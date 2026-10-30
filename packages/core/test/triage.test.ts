import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { triageLeaks, type ReportedLeak } from '../src/index.ts';

const leak = (over: Partial<ReportedLeak> = {}): ReportedLeak => ({
  kind: 'ungated-modification',
  file: 'src/cart.ts',
  decl: 'sumCart',
  head: { line: 2, endLine: 2 },
  base: { line: 2, endLine: 2 },
  severity: 'error',
  ...over,
});

const sources = new Map([['src/cart.ts', { base: 'function sumCart(c) {\n  return c.total;\n}\n', head: 'function sumCart(c) {\n  return c.total + c.tax;\n}\n' }]]);

/** A stand-in for the SDK client: records requests and answers from a script. */
function fakeClient(answer: (n: number) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          const a = answer(requests.length);
          if (a instanceof Error) throw a;
          return a;
        },
      },
    },
  } as unknown as Pick<Anthropic, 'beta'>;
  return { client, requests };
}

const reply = (verdict: string, reason: string) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ verdict, reason }) }],
  usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 400 },
});

test('labels code leaks only, and leaves severity alone', async () => {
  const { client, requests } = fakeClient(() => reply('behavior-change', 'Adds tax to every total.'));
  const leaks = [
    leak(),
    leak({ kind: 'test-regression', decl: 'ships free' }),
    leak({ additive: 'optional-field', severity: 'allow' }),
    leak({ allowed: 'approved', severity: 'allow' }),
  ];
  const run = await triageLeaks(leaks, { newFlags: ['expressCheckout'], sources, client });
  assert.equal(run.triaged, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(leaks[0].triage, { verdict: 'behavior-change', reason: 'Adds tax to every total.', model: 'claude-opus-5-5' });
  assert.equal(leaks[0].severity, 'error');
  assert.equal(leaks[1].triage, undefined);
  assert.deepEqual(run.usage, { input: 900, output: 120, cacheRead: 400 });
});

test('sends a cached system prompt, a JSON schema, refusal fallbacks and the marked code', async () => {
  const { client, requests } = fakeClient(() => reply('equivalent', 'Same value.'));
  await triageLeaks([leak()], { newFlags: ['expressCheckout'], sources, client, effort: 'low', model: 'claude-sonnet-5-5' });
  const r = requests[0] as {
    model: string;
    system: { cache_control: unknown }[];
    output_config: { effort: string; format: { type: string } };
    fallbacks: unknown;
    betas: string[];
    messages: { content: string }[];
  };
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(r.output_config.effort, 'low');
  assert.equal(r.output_config.format.type, 'json_schema');
  assert.equal(r.fallbacks, 'default');
  assert.deepEqual(r.betas, ['server-side-fallback-2026-07-01']);
  assert.match(r.messages[0].content, />> {4}2 \|   return c.total \+ c.tax;/);
  assert.match(r.messages[0].content, /New flags \(all off\): expressCheckout/);
});

test('a refusal becomes unclear, an API error is recorded, nothing throws', async () => {
  const { client } = fakeClient((n) =>
    n === 1
      ? { model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } }
      : new Anthropic.InternalServerError(500, undefined, 'overloaded', new Headers()),
  );
  const leaks = [leak(), leak({ head: { line: 9, endLine: 9 } })];
  const run = await triageLeaks(leaks, { newFlags: [], sources, client, concurrency: 1 });
  assert.equal(leaks[0].triage?.verdict, 'unclear');
  assert.equal(leaks[1].triage, undefined);
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0], /src\/cart\.ts:9: API error 500/);
});

test('rejected credentials skip triage instead of failing', async () => {
  const { client } = fakeClient(() => new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()));
  const run = await triageLeaks([leak(), leak()], { newFlags: [], sources, client });
  assert.match(run.skipped ?? '', /rejected the credentials/);
});

test('a client setup error, like missing credentials, skips triage once', async () => {
  // The SDK throws a plain Error when it finds no credentials.
  const { client, requests } = fakeClient(() => new Error('Could not resolve authentication method. Expected one of apiKey'));
  const run = await triageLeaks([leak(), leak(), leak()], { newFlags: [], sources, client });
  assert.equal(requests.length, 1);
  assert.equal(run.errors.length, 0);
  assert.equal(run.skipped, 'Could not resolve authentication method. Set ANTHROPIC_API_KEY.');
});

test('an answer that is not JSON is recorded for that leak only', async () => {
  const { client } = fakeClient((n) => (n === 1 ? { ...reply('x', 'y'), content: [{ type: 'text', text: 'Sure! Here is my verdict' }] } : reply('equivalent', 'Same.')));
  const leaks = [leak(), leak({ head: { line: 7, endLine: 7 } })];
  const run = await triageLeaks(leaks, { newFlags: [], sources, client });
  assert.equal(run.triaged, 1);
  assert.match(run.errors[0], /wasn't JSON/);
  assert.equal(leaks[1].triage?.verdict, 'equivalent');
});
