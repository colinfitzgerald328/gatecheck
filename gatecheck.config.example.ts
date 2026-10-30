import type { Config } from '@gatecheck/core';

// Copy to gatecheck.config.ts. Each setting is 'error' (fails the check), 'warn' or 'allow'.
export default {
  // Built-in names, or your own: { vendor: 'acme', queries: { tsx: './acme.tsx.scm' } }.
  // Query captures are documented in packages/core/src/presets/types.ts.
  presets: ['launchdarkly'],
  // Optional: ask Claude whether each leak is a real behavior change (needs ANTHROPIC_API_KEY).
  // triage: { enabled: true, model: 'claude-opus-5-5', effort: 'medium', downgradeEquivalent: false },
  // Optional: also run the tests on the base and the branch with the new flags off.
  // test: { command: "node --test 'test/**/*.test.ts'" },
  policy: {
    // Changes that can't break an existing caller. Allowed by default.
    'optional-field': 'allow', // new `field?: T` on an interface or object type
    'response-field': 'allow', // new key in res.json({...}) / Response.json({...})
    'optional-param': 'allow', // new trailing parameter with `?` or a default
    'new-endpoint': 'allow', // app.get('/new/path', ...) on a path main doesn't serve, plus helpers only it uses

    // Changed files gatecheck can't parse: migrations, package.json, config.
    'outside-projection': 'warn',
    // With a test command:
    'test-regression': 'error',
    'test-removed': 'warn',

    // Everything else that runs with the flag off.
    'ungated-modification': 'error',
    'ungated-deletion': 'error',
    'reachable-addition': 'error',
  },
} satisfies Config;
