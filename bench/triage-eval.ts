// Scores Claude's triage verdicts against hand labels. Costs real API money (about $1 on
// claude-opus-5-5 at medium effort): run it when changing the triage prompt or model.
//
//   node bench/triage-eval.ts --repo ../fixture-shop [--model claude-opus-5-5] [--effort medium]
//   node bench/triage-eval.ts --repo ../fixture-shop --dry-run   # check the labels, no API calls
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkBranch, checkFiles, repoRoot, triageLeaks, type ReportedLeak, type Verdict } from '@gatecheck/core';

const { values } = parseArgs({
  options: { repo: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, 'dry-run': { type: 'boolean' } },
});
if (!values.repo) {
  console.error('Usage: node bench/triage-eval.ts --repo <path to fixture-shop>');
  process.exit(2);
}

const ANY_BUT_EQUIVALENT: Verdict[] = ['behavior-change', 'unclear'];

/** Each case: where the leaks come from, and the acceptable verdicts by `file:line`. */
const cases: { name: string; fixture?: string; branch?: string; expect: Record<string, Verdict[]> }[] = [
  { name: 'tax added to every total', fixture: '01-express-pay-leak', expect: { 16: ['behavior-change'] } },
  { name: 'old JSX branch gets a new prop', fixture: '06-ternary-old-branch-edited', expect: { 5: ['behavior-change'] } },
  { name: 'refund condition widened', fixture: '19-condition-widened', expect: { 5: ['behavior-change'] } },
  { name: 'required field added to a type', fixture: '22-api-required-field', expect: { 4: ['behavior-change'] } },
  { name: 'unread network call', fixture: '29-unread-call-still-reported', expect: { 5: ['behavior-change'] } },
  {
    name: 'inline guards',
    fixture: '31-inline-guards',
    // used twice: same values; reordered around an unknown call; a closure instead of the value
    expect: { 2: ['equivalent'], 8: ANY_BUT_EQUIVALENT, 14: ['behavior-change'] },
  },
  { name: 'non-handler now returns a value', fixture: '33-handler-return', expect: { 15: ['behavior-change'] } },
  { name: 'extracted helper', fixture: '36-extracted-helper', expect: { 2: ['equivalent'], 5: ['equivalent'] } },
  { name: 'renamed local', fixture: '37-renamed-local', expect: { 2: ['equivalent'] } },
  { name: 'python tax', fixture: 'py-01-tax-leak', expect: { 5: ['behavior-change'] } },
  { name: 'python inline guards', fixture: 'py-22-inline-guards', expect: { 2: ['equivalent'], 8: ['behavior-change'] } },
  { name: 'status upper-cased', branch: 'leak/order-status-shape', expect: { 'api/src/routes/orders.ts:26': ['behavior-change'] } },
  { name: 'order notes stripped (deliberate)', branch: 'ai/order-notes', expect: { 'api/src/routes/orders.ts:20': ['behavior-change'] } },
  { name: "'cancelled' added to the status union", branch: 'ai/order-cancel', expect: { 'api/src/routes/orders.ts:8': ['behavior-change'] } },
  { name: 'python service fee', branch: 'leak/py-service-fee', expect: { 'py/app/routes/orders.py:22': ['behavior-change'] } },
  { name: 'shipping threshold off by one', branch: 'leak/dyn-threshold', expect: { 'api/src/pricing.ts:13': ['behavior-change'] } },
  {
    name: 'existing flag reused',
    branch: 'edge/existing-flag-elsewhere',
    // reading a flag does nothing; the gated UI shows wherever search-bar is already on
    expect: { 'web/src/components/Checkout.tsx:6': ['equivalent'], 'web/src/components/Checkout.tsx:12': ['behavior-change'] },
  },
];

const root = repoRoot(values.repo);
const fixtures = new URL('../packages/core/test/fixtures/', import.meta.url);
const rows: { name: string; at: string; expected: Verdict[]; got?: Verdict; reason?: string }[] = [];
const usage = { input: 0, output: 0, cacheRead: 0 };

for (const c of cases) {
  let leaks: ReportedLeak[];
  let sources: Map<string, { base: string | null; head: string | null }>;
  let newFlags: string[];
  if (c.fixture) {
    const ext = c.fixture.startsWith('py-') ? '.py' : '.tsx';
    const read = (f: string) => readFileSync(new URL(`${c.fixture}/${f}${ext}`, fixtures), 'utf8');
    const path = `${c.fixture}${ext}`;
    const change = { path, base: read('base'), head: read('head') };
    const result = await checkFiles([change]);
    ({ leaks, newFlags } = result);
    sources = new Map([[path, change]]);
  } else {
    const { result, changes } = await checkBranch(root, 'main', c.branch);
    ({ leaks, newFlags } = result);
    sources = new Map(changes.map((ch) => [ch.path, ch]));
  }

  if (values['dry-run']) {
    for (const where of Object.keys(c.expect)) {
      const found = leaks.some((l) => (c.fixture ? String(l.head.line) === where : `${l.file}:${l.head.line}` === where) && l.severity === 'error');
      console.log(`${found ? '✓' : '✗'} ${c.name} (${where}): ${found ? 'error-level leak found' : 'NO error-level leak here'}`);
    }
    continue;
  }
  const run = await triageLeaks(leaks, { newFlags, sources, model: values.model, effort: values.effort as 'medium' | undefined });
  if (run.skipped) {
    console.error(`Triage skipped: ${run.skipped}`);
    process.exit(2);
  }
  for (const e of run.errors) console.error(`  error: ${e}`);
  usage.input += run.usage.input;
  usage.output += run.usage.output;
  usage.cacheRead += run.usage.cacheRead;

  for (const [where, expected] of Object.entries(c.expect)) {
    const leak = leaks.find((l) => (c.fixture ? String(l.head.line) === where : `${l.file}:${l.head.line}` === where));
    rows.push({ name: c.name, at: where, expected, got: leak?.triage?.verdict, reason: leak ? leak.triage?.reason : 'gatecheck reported no leak here' });
  }
}

if (values['dry-run']) process.exit(0);

const ok = (r: (typeof rows)[number]) => r.got !== undefined && r.expected.includes(r.got);
for (const r of rows) {
  console.log(`${ok(r) ? '✓' : '✗'} ${r.name} (${r.at}): expected ${r.expected.join(' or ')}, got ${r.got ?? 'nothing'}`);
  if (!ok(r)) console.log(`    ${r.reason}`);
}
const saidEquivalent = rows.filter((r) => r.got === 'equivalent');
const wrongEquivalent = saidEquivalent.filter((r) => !r.expected.includes('equivalent'));
const shouldEquivalent = rows.filter((r) => r.expected.length === 1 && r.expected[0] === 'equivalent');
console.log(`\nagreement: ${rows.filter(ok).length}/${rows.length}`);
console.log(`"equivalent" said wrongly (would hide a real leak if downgraded): ${wrongEquivalent.length}/${saidEquivalent.length}`);
console.log(`equivalent rewrites recognized: ${shouldEquivalent.filter((r) => r.got === 'equivalent').length}/${shouldEquivalent.length}`);
// Claude Opus 5.5 list prices: $4 / $20 per million input / output tokens; cache reads $0.20.
const cost = (usage.input * 4 + usage.output * 20 + usage.cacheRead * 0.2) / 1e6;
console.log(`tokens: ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache reads (about $${cost.toFixed(2)} at Opus 5.5 list prices)`);
