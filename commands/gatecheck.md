---
description: Check that this branch's new feature is fully behind its flags
argument-hint: "[--base <ref>] [--flag <key>]"
allowed-tools: Bash(node:*)
---

Run this from the repository root:

```
node "${CLAUDE_PLUGIN_ROOT}/packages/cli/src/main.ts" check $ARGUMENTS
```

Then report the result in a few lines: the new flags, each leak as `file:line`, and what to do
about it. For each leak, say whether it looks like part of the feature (move it behind the
flag) or a separate change (keep it with `// gatecheck-allow: <reason>`). Don't change any
code unless the user asks you to.
