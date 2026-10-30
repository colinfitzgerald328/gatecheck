import type { Config } from '@gatecheck/core';

// Copy to gatecheck.config.ts. Each setting is 'error' (fails the check), 'warn' or 'allow'.
export default {
  preset: 'launchdarkly',
  policy: {
    // Changes that can't break an existing caller. Allowed by default.
    'optional-field': 'allow', // new `field?: T` on an interface or object type
    'response-field': 'allow', // new key in res.json({...}) / Response.json({...})
    'optional-param': 'allow', // new trailing parameter with `?` or a default
    'new-endpoint': 'allow', // app.get('/new/path', ...) on a path main doesn't serve, plus helpers only it uses

    // Everything else that runs with the flag off.
    'ungated-modification': 'error',
    'ungated-deletion': 'error',
    'reachable-addition': 'error',
  },
} satisfies Config;
