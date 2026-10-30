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

## Status: M6

- TypeScript/TSX and Python via tree-sitter (WASM). Python covers `if`/`elif`/`else`,
  `and`/`or`/`not`, conditional expressions, relative and absolute imports, FastAPI/Flask
  route decorators and Pydantic/dataclass fields.
- Presets are tree-sitter query files. LaunchDarkly is built in (`useFlags()` with
  destructuring and camelCase keys, `variation` / `boolVariation` / `variationDetail().value`,
  `await`, `props.flags.*` from `withLDConsumer`; in Python, `variation` and
  `variation_detail().value`); add your own in the config, one query per language.
- Branch-wide check: renames, new and deleted files, imports between files, and new files
  imported by files the branch didn't touch
- Additive API policy (see below)
- `gatecheck bench` scores the checker against labeled branches in
  [fixture-shop](https://github.com/colinfitzgerald328/fixture-shop)
- GitHub Action: PR comment, line annotations, failing check
- Claude Code plugin: hooks after each edit and before Claude finishes, a skill, `/gatecheck`
- Dynamic layer: `--test` runs your tests on the base and on the branch with the new flags off
  and reports tests that pass on the base but fail on the branch
- AI triage: `--triage` asks Claude whether each remaining leak is a real behavior change

Requires Node 23.6+ (runs TypeScript directly, no build step).

```
npm install
npm test
npx gatecheck check --base main                 # working tree vs main
npx gatecheck check --base main --head my-branch
npx gatecheck bench bench/expected/fixture-shop --repo ../fixture-shop
```

## Running your tests (`--test`)

Static projection can't judge everything: a changed JSON file, a SQL query, a config value.
With `--test`, gatecheck also checks out the base in a temporary git worktree, runs your test
command there and on the branch, and compares the results test by test.

```
npx gatecheck check --base main --test "node --test 'test/**/*.test.ts'"
```

- **`test-regression`** (error): passes on the base, fails on the branch. It has to fail again
  on a second run, so flaky tests don't count.
- **`test-removed`** (warn): runs on the base, missing on the branch.
- `node --test`, vitest and pytest get JUnit flags added. For anything else, put `{junit}`
  where the report path goes: `--test "npm test -- --reporter=junit --outputFile={junit}"`.
- Both runs get the new flags in `GATECHECK_FLAGS_OFF` (`expressCheckout,express-checkout`).
  Usually you need nothing: the flag doesn't exist on the base, and most flag mocks return the
  fallback for unknown keys. If your mocks turn every flag on, have them read this variable.
- The base worktree shares the checkout's `node_modules`. Install dependencies first.
- Test files (`*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`, `test_*.py`, `*_test.py`,
  `conftest.py`) are left out of the static check: test code doesn't run in production, and a
  new feature's new tests aren't leaks.

Set it once in the config with `"test": { "command": "..." }`, or pass `test-command` to the
GitHub Action.

## AI triage (`--triage`)

gatecheck compares code structure, so it also reports rewrites that behave the same: an
extracted helper, a renamed variable. With `--triage`, Claude reads each error-level code leak
with the base and branch versions of its file and labels it:

- **behavior change**: some user or caller would see a difference with the new flags off
- **likely equivalent**: a rewrite nobody could observe
- **unclear**: depends on code it can't see, such as what a called function does

```
  src/cart.ts:2  ungated-modification  in sumCart
    + return cart.items.reduce(addLine, 0);
    Claude: likely equivalent. The reducer was moved into addLine with the same arithmetic.
```

Triage only labels. Leaks stay errors unless you set `"downgradeEquivalent": true`, which
lowers "likely equivalent" leaks to warnings. It needs `ANTHROPIC_API_KEY`; without one, or if
the API fails, the check runs as usual and says triage was skipped. It uses `claude-opus-5-5` at
`medium` effort (configurable), caches the shared prompt, and has the API retry a declined
request on its recommended fallback model.

```json
{ "triage": { "enabled": true, "model": "claude-opus-5-5", "effort": "medium", "downgradeEquivalent": false } }
```

`bench/triage-eval.ts` scores the verdicts against 22 hand-labeled leaks (about $1 a run).

## Claude Code plugin

Catches leaks while Claude builds the feature, before anything reaches a PR.

```
/plugin install gatecheck --marketplace colinfitzgerald328/gatecheck
```

Then, in each repo where you want it, run `npx gatecheck init` (or add a
`gatecheck.config.json`). Repos without a config are left alone.

- **After each edit** (`Edit`, `Write`, `MultiEdit`), leaks in that file go back to Claude with
  the code and the two ways out: move it behind the flag, or keep it with
  `// gatecheck-allow: <reason>` if the user asked for it separately.
- **Before Claude finishes**, the whole branch is checked. `"stop": "warn"` (the default)
  tells you; `"stop": "block"` sends Claude back once to fix the leaks.
- **Only while building a flagged feature.** With `"requireNewFlag": true` (the default), the
  hooks stay quiet on branches that don't add a new flag, so ordinary edits aren't flagged.
- `/gatecheck` shows the branch's full report. The `gatecheck` skill gives Claude the rules
  for building behind a flag.

```json
{
  "base": "origin/main",
  "presets": ["launchdarkly"],
  "policy": {},
  "hooks": { "postEdit": "on", "stop": "warn", "requireNewFlag": true }
}
```

Needs Node 23.6+. The plugin installs its dependencies on first use; if Node is missing or
too old, the hooks do nothing.

## GitHub Action

```yaml
# .github/workflows/gatecheck.yml
name: gatecheck
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  gatecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - uses: colinfitzgerald328/gatecheck@main
        with:
          test-command: npm test -- --reporter=junit --outputFile={junit}   # optional
          triage: true                                                      # optional
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action posts one comment per PR and updates it on each push, annotates each leak on
the changed lines, and fails the check when a leak is at `error` severity.

## Policy

Some ungated changes can't break an existing caller. These are classified and allowed
by default; every other leak is an error. Change any of them in `gatecheck.config.ts`
(see `gatecheck.config.example.ts`):

| Category | What it matches | Default |
|---|---|---|
| `optional-field` | New `field?: T` on an interface or object type; a Pydantic/dataclass field with a default | allow |
| `response-field` | New key in `res.json({...})`, `Response.json({...})`; in a route handler's returned dict or `JSONResponse({...})` | allow |
| `optional-param` | New trailing parameter with `?` or a default | allow |
| `new-endpoint` | `app.get('/path', …)` or `@router.get("/path")` on a path `main` doesn't serve, plus helpers only it uses | allow |
| `outside-projection` | A changed file gatecheck can't parse: migrations, `package.json`, config | warn |
| `test-regression` | With `--test`: a test that passes on the base fails on the branch | error |
| `test-removed` | With `--test`: a test that runs on the base is missing on the branch | warn |
| `ungated-modification` | Existing code that differs with the flag off | error |
| `ungated-deletion` | Code on `main` that's gone with the flag off | error |
| `reachable-addition` | New code that still runs with the flag off | error |

A single leak can be allowed in place with `// gatecheck-allow: <reason>` (`#` in Python) on
the line before it.

## Custom presets

A preset is a tree-sitter query that tags flag reads. Captures are documented in
`packages/core/src/presets/types.ts`; `packages/core/src/presets/launchdarkly.tsx.scm` is a
full example.

```ts
// gatecheck.config.ts
export default {
  presets: ['launchdarkly', { vendor: 'acme', queries: { tsx: './acme.tsx.scm' } }],
};
```

## Layout

- `packages/core`: projection, comparison, policy, git, bench. `src/lang/` holds the language
  adapters (`tsx.ts`, `python.ts`), `src/presets/` the query presets.
- `packages/cli`: the `gatecheck` command and its output formats.
- `bench/expected/`: hand-checked results for each test branch.
- `action.yml`: the GitHub Action.
- Test codebase: `../fixture-shop`, one branch per test PR.
