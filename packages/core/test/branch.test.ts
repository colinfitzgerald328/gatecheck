import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFiles, type FileChange } from '../src/index.ts';

const summarize = (leaks: { file: string; head: { line: number }; kind: string; additive?: string }[]) =>
  leaks.map((l) => `${l.file}:${l.head.line} ${l.additive ?? l.kind}`);

const checkout = (body: string) => `import { useFlags } from 'launchdarkly-react-client-sdk';
import { Express } from './Express';

export function Checkout() {
  const { express } = useFlags();
  ${body}
}
`;

test('a new file imported only inside the gate is unreached', async () => {
  const changes: FileChange[] = [
    { path: 'src/Checkout.tsx', base: 'export function Checkout() {\n  return <Pay />;\n}\n', head: checkout('return express ? <Express /> : <Pay />;') },
    { path: 'src/Express.tsx', base: null, head: 'export function Express() {\n  return <button />;\n}\n' },
  ];
  const result = await checkFiles(changes);
  assert.deepEqual(summarize(result.leaks), []);
  assert.ok(result.removed.some((r) => r.file === 'src/Express.tsx' && r.what === 'unreached new file'));
});

test('a new export used ungated from another changed file is a leak', async () => {
  const changes: FileChange[] = [
    { path: 'src/total.ts', base: 'export function total(c) {\n  return c.sum;\n}\n', head: "import { round } from './money.js';\n\nexport function total(c) {\n  return round(c.sum);\n}\n" },
    { path: 'src/money.ts', base: 'export const CURRENCY = "USD";\n', head: 'export const CURRENCY = "USD";\n\nexport function round(n) {\n  return Math.round(n);\n}\n' },
  ];
  assert.deepEqual(summarize((await checkFiles(changes)).leaks), ['src/money.ts:3 reachable-addition', 'src/total.ts:4 ungated-modification']);
});

test('a new file an untouched file may import keeps its exports', async () => {
  const changes: FileChange[] = [{ path: 'src/Summary.tsx', base: null, head: 'export function Summary() {\n  return <div />;\n}\n' }];
  assert.deepEqual(summarize((await checkFiles(changes)).leaks), []);
  const result = await checkFiles(changes, { importedElsewhere: () => true });
  assert.deepEqual(summarize(result.leaks), ['src/Summary.tsx:1 reachable-addition']);
});

test('a rename alone does not change its importers', async () => {
  const changes: FileChange[] = [
    { path: 'src/SiteHeader.tsx', basePath: 'src/Header.tsx', base: 'export function Header() {\n  return <header />;\n}\n', head: 'export function Header() {\n  return <header />;\n}\n' },
    { path: 'src/App.tsx', base: "import { Header } from './Header';\n\nexport const App = () => <Header />;\n", head: "import { Header } from './SiteHeader';\n\nexport const App = () => <Header />;\n" },
  ];
  assert.deepEqual(summarize((await checkFiles(changes)).leaks), []);
});

test('files without an adapter are outside the projection', async () => {
  const result = await checkFiles([{ path: 'migrations/002.sql', base: null, head: 'ALTER TABLE orders ADD x TEXT;' }]);
  assert.deepEqual(summarize(result.leaks), ['migrations/002.sql:1 outside-projection']);
  assert.equal(result.leaks[0].severity, 'warn');
});

test('a flag main reads in an untouched file is not new', async () => {
  const changes: FileChange[] = [
    { path: 'src/a.ts', base: 'export function a() {\n  return 1;\n}\n', head: "export function a() {\n  if (ld.variation('search-bar', false)) return 2;\n  return 1;\n}\n" },
  ];
  assert.equal((await checkFiles(changes)).leaks.length, 0);
  assert.equal((await checkFiles(changes, { existsOnBase: (k) => k === 'searchBar' })).leaks.length, 1);
});

test('a custom query preset finds its own flag calls', async () => {
  const acme = {
    vendor: 'acme',
    queries: {
      tsx: `((call_expression function: (identifier) @_fn arguments: (arguments . (string) @key)) @read (#eq? @_fn "isOn"))`,
    },
  };
  const changes: FileChange[] = [
    { path: 'src/a.ts', base: 'export function a() {\n  return 1;\n}\n', head: "export function a() {\n  if (isOn('beta')) return 2;\n  return 1;\n}\n" },
  ];
  assert.equal((await checkFiles(changes, { presets: [] })).leaks.length, 1);
  const result = await checkFiles(changes, { presets: [acme] });
  assert.deepEqual(result.newFlags, ['beta']);
  assert.equal(result.leaks.length, 0);
});
