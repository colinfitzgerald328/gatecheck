# gatecheck

Checks that code written by an AI agent is fully behind its feature flags.

gatecheck turns every **new** flag off in the branch's code, simplifies what's left
(folds `if (false)`, picks the `else` branch, cuts code after early returns, drops
imports and helpers nothing reaches), and compares the result to `main`. Anything
that still differs runs with the flag off. That's a leak.

```
$ gatecheck file web/src/components/Checkout.tsx --base main
new flags: expressCheckout

✗ 1 leak
  web/src/components/Checkout.tsx:19  ungated-modification  in sumCart
    - return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
    + return cart.items.reduce((sum, item) => sum + item.price * item.qty, 0) + cart.tax;
```

## Status: M0

- TS/TSX via tree-sitter (WASM), LaunchDarkly preset (`useFlags()` with destructuring and
  camelCase keys, `variation` / `boolVariation` / `variationDetail().value`, `await`)
- Single-file check: `gatecheck file <path> --base <ref>` or `gatecheck file <base> <head>`
- Additive API policy (see below)
- 27 golden fixtures in `packages/core/test/fixtures`

Requires Node 23.6+ (runs TypeScript directly, no build step).

```
npm install
npm test
npx gatecheck file <path> --base main
```

## Policy

Some ungated changes can't break an existing caller. These are classified and allowed
by default; every other leak is an error. Change any of them in `gatecheck.config.ts`
(see `gatecheck.config.example.ts`):

| Category | What it matches | Default |
|---|---|---|
| `optional-field` | New `field?: T` on an interface or object type | allow |
| `response-field` | New key in `res.json({...})`, `Response.json({...})` | allow |
| `optional-param` | New trailing parameter with `?` or a default | allow |
| `new-endpoint` | `app.get('/path', …)` on a path `main` doesn't serve, plus helpers only it uses | allow |
| `ungated-modification` | Existing code that differs with the flag off | error |
| `ungated-deletion` | Code on `main` that's gone with the flag off | error |
| `reachable-addition` | New code that still runs with the flag off | error |

A single leak can be allowed in place with `// gatecheck-allow: <reason>` on the line
before it.

## Layout

- `packages/core`: projection, comparison, policy. `src/lang/tsx.ts` is the TSX adapter,
  `src/presets/launchdarkly.ts` the LaunchDarkly preset.
- `packages/cli`: the `gatecheck` command.
- Test codebase: `../fixture-shop`, one branch per test PR.
