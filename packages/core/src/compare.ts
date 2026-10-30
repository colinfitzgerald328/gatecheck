import type { TopLevelItem } from './adapter.ts';
import { firstPos, lastPos, ser, type N, type Pos } from './tree.ts';

export type LeakKind = 'ungated-modification' | 'ungated-deletion' | 'reachable-addition';

/** Ungated changes that can't break an existing caller. Each one has its own policy setting. */
export type AdditiveKind = 'optional-field' | 'response-field' | 'optional-param' | 'new-endpoint';

export type Category = LeakKind | AdditiveKind;

/** Returns an additive kind when an inserted node can't break existing callers. */
export type ClassifyInsertion = (node: N, ancestors: N[]) => AdditiveKind | undefined;

export interface Span {
  /** 1-based, inclusive. */
  line: number;
  endLine: number;
}

export interface Leak {
  kind: LeakKind;
  /** Set when the change is additive; policy is looked up by this instead of `kind`. */
  additive?: AdditiveKind;
  /** The top-level declaration the leak is in. */
  decl: string;
  /** Where on the branch. For deletions, where the code used to be. */
  head: Span;
  /** The code on main it replaces or removes, if any. */
  base?: Span;
  /** Reason from a `gatecheck-allow:` comment. */
  allowed?: string;
}

function span(n: N, fallback: Pos | undefined): Span {
  const start = firstPos(n) ?? fallback ?? { row: 0, column: 0 };
  const end = lastPos(n) ?? start;
  return { line: start.row + 1, endLine: end.row + 1 };
}

type Op = { kind: 'eq'; b: number; h: number } | { kind: 'del'; b: number } | { kind: 'ins'; h: number };

/** Longest-common-subsequence alignment of two sibling lists by fingerprint. */
function align(b: string[], h: string[]): Op[] {
  const m = b.length;
  const n = h.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = b[i] === h[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (b[i] === h[j]) ops.push({ kind: 'eq', b: i++, h: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ kind: 'del', b: i++ });
    else ops.push({ kind: 'ins', h: j++ });
  }
  while (i < m) ops.push({ kind: 'del', b: i++ });
  while (j < n) ops.push({ kind: 'ins', h: j++ });
  return ops;
}

/** The branch-side node behind each inserted or added leak, for the reachability pass. */
const leakNodes = new WeakMap<Leak, N>();

/** Narrow a mismatch down to the smallest differing subtrees. */
function diffNodes(b: N, h: N, decl: string, at: Pos | undefined, out: Leak[], ancestors: N[], classify: ClassifyInsertion): void {
  if (ser(b) === ser(h)) return;
  const path = [...ancestors, h];
  const here = firstPos(h) ?? at;
  if (b.type !== h.type || b.children.length === 0 || h.children.length === 0) {
    out.push({ kind: 'ungated-modification', decl, head: span(h, here), base: span(b, undefined) });
    return;
  }
  const bk = b.children.filter((c) => ser(c) !== '');
  const hk = h.children.filter((c) => ser(c) !== '');
  const ops = align(bk.map(ser), hk.map(ser));

  let lastHeadEnd: Pos | undefined = here;
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op.kind === 'eq') {
      lastHeadEnd = lastPos(hk[op.h]) ?? lastHeadEnd;
      i++;
      continue;
    }
    const dels: N[] = [];
    const inss: N[] = [];
    for (; i < ops.length && ops[i].kind !== 'eq'; i++) {
      const o = ops[i];
      if (o.kind === 'del') dels.push(bk[o.b]);
      else if (o.kind === 'ins') inss.push(hk[o.h]);
    }
    const paired = Math.min(dels.length, inss.length);
    for (let k = 0; k < paired; k++) {
      if (dels[k].type === inss[k].type) diffNodes(dels[k], inss[k], decl, firstPos(inss[k]) ?? here, out, path, classify);
      else out.push({ kind: 'ungated-modification', decl, head: span(inss[k], here), base: span(dels[k], undefined) });
    }
    for (const n of inss.slice(paired)) {
      // Only pure insertions can be additive; anything that replaced old code is a modification.
      const additive = dels.length === 0 ? classify(n, path) : undefined;
      const leak: Leak = { kind: 'ungated-modification', additive, decl, head: span(n, here) };
      leakNodes.set(leak, n);
      out.push(leak);
    }
    for (const n of dels.slice(paired)) {
      out.push({ kind: 'ungated-deletion', decl, head: span({ type: '', named: true, children: [] }, lastHeadEnd), base: span(n, undefined) });
    }
  }
}

export function compareTopLevel(
  base: Map<string, TopLevelItem>,
  head: Map<string, TopLevelItem>,
  root: N,
  classify: ClassifyInsertion,
): Leak[] {
  const leaks: Leak[] = [];
  for (const [key, h] of head) {
    const b = base.get(key);
    if (b) diffNodes(b.node, h.node, h.label, undefined, leaks, [root], classify);
    else {
      const leak: Leak = { kind: 'reachable-addition', additive: classify(h.node, [root]), decl: h.label, head: span(h.node, undefined) };
      leakNodes.set(leak, h.node);
      leaks.push(leak);
    }
  }
  inheritAdditive(leaks, root);
  for (const [key, b] of base) {
    if (head.has(key)) continue;
    // Report removed code where it used to be: after the item before it on main, or before the one after.
    const keys = [...base.keys()];
    const index = keys.indexOf(key);
    const prev = keys.slice(0, index).reverse().find((k) => head.has(k));
    const next = keys.slice(index + 1).find((k) => head.has(k));
    const at = prev ? lastPos(head.get(prev)!.node) : next ? firstPos(head.get(next)!.node) : undefined;
    leaks.push({ kind: 'ungated-deletion', decl: b.label, head: span({ type: '', named: true, children: [] }, at), base: span(b.node, undefined) });
  }
  return leaks.sort((x, y) => x.head.line - y.head.line);
}

function refCounts(n: N, skip: Set<N>, counts = new Map<string, number>()): Map<string, number> {
  if (skip.has(n)) return counts;
  if (n.type === 'identifier' || n.type === 'type_identifier' || n.type === 'shorthand_property_identifier') {
    counts.set(n.text!, (counts.get(n.text!) ?? 0) + 1);
  }
  for (const c of n.children) refCounts(c, skip, counts);
  return counts;
}

/**
 * A new declaration used only by an additive change (a new endpoint's handler,
 * a helper that handler calls) is part of that change, so it takes the same kind.
 */
function inheritAdditive(leaks: Leak[], root: N): void {
  for (let changed = true; changed; ) {
    changed = false;
    const additive = leaks.filter((l) => l.additive && leakNodes.has(l));
    const pending = leaks.filter((l) => l.kind === 'reachable-addition' && !l.additive && leakNodes.has(l));
    for (const leak of pending) {
      const names = leak.decl.split(', ');
      const self = leakNodes.get(leak)!;
      const outside = refCounts(root, new Set([self, ...additive.map((l) => leakNodes.get(l)!)]));
      if (names.some((name) => outside.get(name))) continue;
      const user = additive.find((l) => names.some((name) => refCounts(leakNodes.get(l)!, new Set()).get(name)));
      if (!user) continue;
      leak.additive = user.additive;
      changed = true;
    }
  }
}
