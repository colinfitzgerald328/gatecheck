import type { Node as TSNode } from 'web-tree-sitter';

export interface Pos {
  row: number;
  column: number;
}

/**
 * A mutable copy of the tree-sitter tree. Projection rewrites this tree in place;
 * nodes that survive keep their original positions so leaks map back to real lines.
 * Synthesized nodes (e.g. a substituted `false`) have no position.
 */
export interface N {
  type: string;
  named: boolean;
  field?: string;
  text?: string; // leaves only
  children: N[];
  start?: Pos;
  end?: Pos;
}

export interface Comment {
  row: number;
  text: string;
}

export function fromTreeSitter(root: TSNode, comments: Comment[]): N {
  const convert = (node: TSNode, field: string | undefined): N => {
    const n: N = {
      type: node.type,
      named: node.isNamed,
      field,
      children: [],
      start: node.startPosition,
      end: node.endPosition,
    };
    if (node.type === 'string') {
      // Quote style is formatting: keep only the contents.
      n.text = node.text.slice(1, -1);
      return n;
    }
    if (node.childCount === 0) {
      n.text = node.text;
      return n;
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === 'comment') {
        comments.push({ row: child.startPosition.row, text: child.text });
        continue;
      }
      n.children.push(convert(child, node.fieldNameForChild(i) ?? undefined));
    }
    return n;
  };
  return convert(root, undefined);
}

export function leaf(type: string, text: string, named = true): N {
  return { type, named, text, children: [] };
}

export function clone(n: N): N {
  return { ...n, children: n.children.map(clone) };
}

export function child(n: N, field: string): N | undefined {
  return n.children.find((c) => c.field === field);
}

export function namedChildren(n: N): N[] {
  return n.children.filter((c) => c.named);
}

export function walk(n: N, visit: (n: N, parent: N | undefined) => void, parent?: N): void {
  visit(n, parent);
  for (const c of n.children) walk(c, visit, n);
}

const DROPPED_TOKENS = new Set([',', ';']);

/** Structural fingerprint used for equality. Formatting, commas and semicolons don't count. */
export function ser(n: N): string {
  if (n.children.length === 0) {
    if (!n.named) return DROPPED_TOKENS.has(n.text ?? '') ? '' : (n.text ?? '');
    return `${n.type}:${n.text ?? ''}`;
  }
  const parts = n.children.map(ser).filter(Boolean);
  return `(${n.type} ${parts.join(' ')})`;
}

/** First positioned node in a subtree, for reporting synthesized nodes. */
export function firstPos(n: N): Pos | undefined {
  if (n.start) return n.start;
  for (const c of n.children) {
    const p = firstPos(c);
    if (p) return p;
  }
  return undefined;
}

export function lastPos(n: N): Pos | undefined {
  if (n.end) return n.end;
  for (let i = n.children.length - 1; i >= 0; i--) {
    const p = lastPos(n.children[i]);
    if (p) return p;
  }
  return undefined;
}
