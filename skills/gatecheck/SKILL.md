---
name: gatecheck
description: Rules for building a feature behind a feature flag (LaunchDarkly or similar) so nothing changes for users while the flag is off. Use when adding code gated by a new flag, when asked to build something "behind a flag" or "dark", or when gatecheck reports a leak.
---

# Building behind a flag

With the new flag off, the branch has to behave exactly like the base branch. gatecheck
checks this by turning the new flag off in the code and comparing the result to the base.
Anything that still differs is a leak.

## While you build

- Put every behavior change for the feature behind the new flag: new UI, changed logic,
  changed responses, new side effects like analytics events.
- Leave the flag-off path byte-for-byte as it was. Add the new path next to it
  (`flag ? next : current`, `if (flag) { … } else { current }`) instead of editing the old one.
- New files, components and helpers are fine ungated, as long as they're only used from
  inside the gate.
- Keep refactors out of a flagged change. If the feature needs one, say so and suggest doing
  it separately.
- Allowed without a flag (additive API changes): a new optional field on a type (or a Pydantic
  field with a default), a new key in a JSON response, a new trailing optional parameter, a
  new endpoint on a new path.

## When gatecheck reports a leak

The report names the file, line and code. Then:

1. If the change is part of the feature, move it behind the flag.
2. If the user asked for it as its own change, keep it and add
   `// gatecheck-allow: <reason>` (`# gatecheck-allow: <reason>` in Python) on the line
   before it, with the user's reason.
3. Never revert work the user asked for just to clear the check, and never remove or
   rename the flag to get around it.

Run `/gatecheck` to see the whole branch's report.
