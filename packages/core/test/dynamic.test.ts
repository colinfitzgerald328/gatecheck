import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJUnit, withJUnit } from '../src/index.ts';

test('reads node --test JUnit, with absolute file paths made relative', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="adds shipping under 50" time="0.0008" classname="test" file="/repo/api/test/pricing.test.ts"/>
  <testcase name="free shipping at 50" time="0.0007" classname="test" file="/repo/api/test/pricing.test.ts" failure="expected 0&#10;&#10;5 !== 0&#10;">
    <failure type="testCodeFailure" message="expected 0&#10;&#10;5 !== 0">[Error]</failure>
  </testcase>
  <testcase name="later" classname="test" file="/repo/api/test/pricing.test.ts"><skipped type="skipped"/></testcase>
</testsuites>`;
  assert.deepEqual(parseJUnit(xml, '/repo'), [
    { id: 'api/test/pricing.test.ts::adds shipping under 50', file: 'api/test/pricing.test.ts', name: 'adds shipping under 50', line: undefined, status: 'pass', message: undefined },
    { id: 'api/test/pricing.test.ts::free shipping at 50', file: 'api/test/pricing.test.ts', name: 'free shipping at 50', line: undefined, status: 'fail', message: 'expected 0 5 !== 0' },
    { id: 'api/test/pricing.test.ts::later', file: 'api/test/pricing.test.ts', name: 'later', line: undefined, status: 'skip', message: undefined },
  ]);
});

test('reads pytest JUnit, including line numbers and errors', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="0" skipped="0" tests="2">
<testcase classname="tests.test_pricing" name="test_total" file="tests/test_pricing.py" line="3" time="0.001" />
<testcase classname="tests.test_pricing" name="test_rounding" file="tests/test_pricing.py" line="9" time="0.001"><error message="ZeroDivisionError: division by zero">trace</error></testcase>
</testsuite></testsuites>`;
  const [ok, broken] = parseJUnit(xml, '/repo');
  assert.equal(ok.status, 'pass');
  assert.equal(broken.status, 'fail');
  assert.equal(broken.line, 9);
  assert.equal(broken.message, 'ZeroDivisionError: division by zero');
});

test('adds JUnit flags for known runners and fills {junit}', () => {
  assert.equal(withJUnit("node --test 'test/**/*.test.ts'", '/t/r.xml'), "node --test --test-reporter=junit --test-reporter-destination=/t/r.xml 'test/**/*.test.ts'");
  assert.equal(withJUnit('npx vitest run', '/t/r.xml'), 'npx vitest run --reporter=junit --outputFile=/t/r.xml');
  assert.equal(withJUnit('python -m pytest -q', '/t/r.xml'), 'python -m pytest -q --junitxml=/t/r.xml');
  assert.equal(withJUnit('npm test -- --junit={junit}', '/t/r.xml'), 'npm test -- --junit=/t/r.xml');
  assert.throws(() => withJUnit('npm test', '/t/r.xml'), /\{junit\}/);
});
