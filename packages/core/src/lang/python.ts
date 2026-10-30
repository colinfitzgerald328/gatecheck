import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import type { LanguageAdapter, TopLevelItem } from '../adapter.ts';
import type { ClassifyInsertion } from '../compare.ts';
import { canonicalKey, matchRead } from '../flags.ts';
import {
  child,
  clone,
  fromTreeSitter,
  leaf,
  namedChildren,
  parentMap,
  removeNode,
  ser,
  walk,
  withField,
  type Comment,
  type N,
  type RawTag,
} from '../tree.ts';

let parserPromise: Promise<{ parser: Parser; language: Language }> | undefined;

function getParser(): Promise<{ parser: Parser; language: Language }> {
  parserPromise ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const language = await Language.load(require.resolve('tree-sitter-python/tree-sitter-python.wasm'));
    const parser = new Parser();
    parser.setLanguage(language);
    return { parser, language };
  })();
  return parserPromise;
}

const queryCache = new Map<string, Query>();

function compile(language: Language, source: string, vendor: string): Query {
  let query = queryCache.get(source);
  if (!query) {
    try {
      query = new Query(language, source);
    } catch (err) {
      throw new Error(`Invalid python query in preset "${vendor}": ${(err as Error).message}`);
    }
    queryCache.set(source, query);
  }
  return query;
}

// ---------------------------------------------------------------------------
// Flag aliases: `enabled = ld.variation("k", ctx, False)`
// ---------------------------------------------------------------------------

/** Scopes are a module or a function's body. */
const SCOPES = new Set(['module', 'block']);
const FUNCTIONS = new Set(['function_definition', 'lambda']);

interface Alias {
  scope: N;
  name: string;
  key: string;
  off: N;
  statement: N;
}

/** `x = value` or `x: T = value` as an expression statement, with its target and value. */
function simpleAssignment(stmt: N): { target: N; value: N; assignment: N } | undefined {
  if (stmt.type !== 'expression_statement') return undefined;
  const assignment = namedChildren(stmt)[0];
  if (assignment?.type !== 'assignment') return undefined;
  const target = child(assignment, 'left');
  const value = child(assignment, 'right');
  return target && value ? { target, value, assignment } : undefined;
}

function assignedNames(stmt: N): N[] {
  const a = simpleAssignment(stmt) ?? (stmt.type === 'expression_statement' && namedChildren(stmt)[0]?.type === 'assignment' ? { target: child(namedChildren(stmt)[0], 'left')! } : undefined);
  if (!a?.target) return [];
  const out: N[] = [];
  walk(a.target, (n) => {
    if (n.type === 'identifier') out.push(n);
  });
  return out;
}

/** How many times each name is assigned in a scope, not counting nested functions. */
function assignmentCounts(scope: N): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (n: N) => {
    if (n !== scope && FUNCTIONS.has(n.type)) return;
    if (n.type === 'assignment' || n.type === 'augmented_assignment') {
      walk(child(n, 'left') ?? n, (t) => {
        if (t.type === 'identifier') counts.set(t.text!, (counts.get(t.text!) ?? 0) + 1);
      });
    }
    for (const c of n.children) visit(c);
  };
  visit(scope);
  return counts;
}

function collectAliases(tree: N): Alias[] {
  const aliases: Alias[] = [];
  walk(tree, (scope) => {
    if (!SCOPES.has(scope.type)) return;
    const counts = assignmentCounts(scope);
    for (const stmt of scope.children) {
      const a = simpleAssignment(stmt);
      if (a?.target.type !== 'identifier' || counts.get(a.target.text!) !== 1) continue;
      const read = matchRead(a.value);
      if (read) aliases.push({ scope, name: a.target.text!, key: read.key, off: read.off, statement: stmt });
    }
  });
  return aliases;
}

function collectFlagKeys(tree: N): Set<string> {
  const keys = new Set<string>();
  walk(tree, (n) => {
    const read = matchRead(n);
    if (read) keys.add(canonicalKey(read.key));
  });
  return keys;
}

function substituteFlags(tree: N, newKeys: Set<string>, removed: string[]): void {
  const isNew = (key: string) => newKeys.has(canonicalKey(key));
  const parents = parentMap(tree);
  const aliases = collectAliases(tree).filter((a) => isNew(a.key));
  for (const a of aliases) {
    removeNode(a.statement, parents);
    removed.push(`flag alias ${a.name}`);
  }
  const replaceIn = (n: N, name: string, off: N) => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (c.type === 'identifier' && c.text === name && c.field !== 'attribute' && c.field !== 'name') {
        n.children[i] = withField(clone(off), c.field);
      } else {
        replaceIn(c, name, off);
      }
    }
  };
  for (const a of aliases) replaceIn(a.scope, a.name, a.off);

  const replaceReads = (n: N) => {
    for (let i = 0; i < n.children.length; i++) {
      const read = matchRead(n.children[i]);
      if (read && isNew(read.key)) n.children[i] = withField(clone(read.off), n.children[i].field);
      else replaceReads(n.children[i]);
    }
  };
  replaceReads(tree);
}

// ---------------------------------------------------------------------------
// Simplifier
// ---------------------------------------------------------------------------

const LIST_PARENTS = new Set(['module', 'block']);

function known(n: N | undefined): boolean | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'true':
      return true;
    case 'false':
    case 'none':
      return false;
    case 'integer':
    case 'float':
      return Number(n.text?.replace(/_/g, '')) !== 0;
    case 'string':
      return n.text !== '';
  }
  return undefined;
}

function pure(n: N): boolean {
  if (known(n) !== undefined) return true;
  if (n.type === 'identifier') return true;
  if (n.type === 'attribute') return pure(child(n, 'object')!);
  return false;
}

function pureValue(n: N): boolean {
  if (pure(n)) return true;
  if (n.type === 'dictionary') return namedChildren(n).every((p) => p.type === 'pair' && pureValue(child(p, 'value')!) && pureValue(child(p, 'key')!));
  if (n.type === 'list' || n.type === 'tuple' || n.type === 'set') return namedChildren(n).every(pureValue);
  if (n.type === 'lambda') return true;
  return false;
}

function operator(n: N): string | undefined {
  return child(n, 'operator')?.text ?? n.children.find((c) => !c.named)?.text;
}

/** Truthiness as a condition, where `x and False` is falsy no matter what `x` is. */
function testKnown(n: N | undefined): boolean | undefined {
  if (!n) return undefined;
  const k = known(n);
  if (k !== undefined) return k;
  if (n.type === 'not_operator') {
    const inner = testKnown(child(n, 'argument'));
    return inner === undefined ? undefined : !inner;
  }
  if (n.type === 'boolean_operator') {
    const left = child(n, 'left')!;
    const l = testKnown(left);
    const r = testKnown(child(n, 'right'));
    if (operator(n) === 'and') {
      if (l === false || (r === false && pure(left))) return false;
      if (l === true) return r;
    } else {
      if (l === true || (r === true && pure(left))) return true;
      if (l === false) return r;
    }
  }
  return undefined;
}

function bool(value: boolean): N {
  return value ? leaf('true', 'True') : leaf('false', 'False');
}

function block(statements: N[]): N {
  return { type: 'block', named: true, children: statements.length ? statements : [passStatement()] };
}

function passStatement(): N {
  return { type: 'pass_statement', named: true, children: [leaf('pass', 'pass', false)] };
}

function statementsOf(n: N | undefined): N[] {
  return (n?.children ?? []).filter((c) => c.named);
}

/** `if` / `elif` / `else` as a list of branches; `condition` undefined for `else`. */
function branches(n: N): { condition?: N; body: N }[] {
  const out: { condition?: N; body: N }[] = [{ condition: child(n, 'condition'), body: child(n, 'consequence')! }];
  for (const alt of n.children.filter((c) => c.field === 'alternative')) {
    if (alt.type === 'elif_clause') out.push({ condition: child(alt, 'condition'), body: child(alt, 'consequence')! });
    else out.push({ body: child(alt, 'body')! });
  }
  return out;
}

function buildIf(list: { condition?: N; body: N }[]): N[] {
  if (list.length === 0) return [];
  if (!list[0].condition) return statementsOf(list[0].body);
  const [first, ...rest] = list;
  const children: N[] = [leaf('if', 'if', false), withField(first.condition!, 'condition'), leaf(':', ':', false), withField(first.body, 'consequence')];
  for (const b of rest) {
    if (b.condition) {
      children.push(withField({ type: 'elif_clause', named: true, children: [leaf('elif', 'elif', false), withField(b.condition, 'condition'), leaf(':', ':', false), withField(b.body, 'consequence')] }, 'alternative'));
    } else if (!statementsOf(b.body).every((s) => s.type === 'pass_statement')) {
      children.push(withField({ type: 'else_clause', named: true, children: [leaf('else', 'else', false), leaf(':', ':', false), withField(b.body, 'body')] }, 'alternative'));
    }
  }
  return [{ type: 'if_statement', named: true, children }];
}

const TERMINATORS = new Set(['return_statement', 'raise_statement', 'continue_statement', 'break_statement']);

function rewrite(n: N, parentType: string | undefined): N[] {
  const kids: N[] = [];
  for (const c of n.children) {
    const out = rewrite(c, n.type);
    for (const o of out) o.field = c.field;
    if (out.length === 1 || LIST_PARENTS.has(n.type)) kids.push(...out);
    else kids.push(withField(block(out), c.field));
  }
  n.children = kids;
  return rules(n, parentType);
}

function rules(n: N, parentType: string | undefined): N[] {
  switch (n.type) {
    case 'parenthesized_expression': {
      const inner = namedChildren(n);
      return inner.length === 1 ? [inner[0]] : [n];
    }
    case 'not_operator': {
      const k = known(child(n, 'argument'));
      return k !== undefined ? [bool(!k)] : [n];
    }
    case 'boolean_operator': {
      const left = child(n, 'left')!;
      const right = child(n, 'right')!;
      const l = known(left);
      if (l === undefined) return [n];
      if (operator(n) === 'and') return [l ? right : left];
      return [l ? left : right];
    }
    case 'conditional_expression': {
      // `a if cond else b` has no field names: consequence, condition, alternative.
      const [consequence, condition, alternative] = namedChildren(n);
      const k = testKnown(condition);
      return k === undefined ? [n] : [k ? consequence : alternative];
    }
    case 'if_statement': {
      const kept: { condition?: N; body: N }[] = [];
      for (const b of branches(n)) {
        const k = b.condition ? testKnown(b.condition) : true;
        if (k === false) continue;
        if (k === true) {
          kept.push({ body: b.body }); // first branch known to run: it's the last one
          break;
        }
        kept.push(b);
      }
      const out = buildIf(kept);
      if (out.length === 1 && out[0].type === 'if_statement') return out;
      return LIST_PARENTS.has(parentType ?? '') ? out : [block(out)];
    }
    case 'expression_statement': {
      // `False and track()` folds to `False`, which does nothing.
      const expr = namedChildren(n)[0];
      return expr && known(expr) !== undefined && expr.children.length === 0 ? [] : [n];
    }
    case 'block': {
      let statements = statementsOf(n);
      const cut = statements.findIndex((c) => TERMINATORS.has(c.type));
      if (cut >= 0) statements = statements.slice(0, cut + 1);
      const real = statements.filter((s) => s.type !== 'pass_statement');
      n.children = real.length ? real : [passStatement()];
      return [n];
    }
  }
  return [n];
}

// React-style "quiet" calls have no Python equivalent; only pure values count.
function dropUnreadLocals(tree: N): void {
  for (let changed = true; changed; ) {
    changed = false;
    const parents = parentMap(tree);
    walk(tree, (scope) => {
      // Function bodies only: in a class body an assignment is a field (Pydantic, dataclass).
      if (scope.type !== 'block' || parents.get(scope)?.type !== 'function_definition' || changed) return;
      for (const stmt of statementsOf(scope)) {
        const a = simpleAssignment(stmt);
        if (!a || !pureValue(a.value)) continue;
        const names = new Set(assignedNames(stmt).map((n) => n.text!));
        const targets = new Set(assignedNames(stmt));
        let read = false;
        walk(scope, (n) => {
          if (n.type === 'identifier' && names.has(n.text!) && !targets.has(n)) read = true;
        });
        if (read) continue;
        scope.children = scope.children.filter((c) => c !== stmt);
        if (!statementsOf(scope).length) scope.children = [passStatement()];
        changed = true;
        return;
      }
    });
  }
}

/** `total = subtotal` / `body = {...}; return body`: a name assigned once and read once. */
function inlineSingleUse(tree: N): void {
  for (let changed = true; changed; ) {
    changed = false;
    const parents = parentMap(tree);
    walk(tree, (scope) => {
      if (changed || !SCOPES.has(scope.type)) return;
      if (scope.type === 'block' && parents.get(scope)?.type !== 'function_definition') return;
      const counts = assignmentCounts(scope);
      for (const stmt of statementsOf(scope)) {
        const a = simpleAssignment(stmt);
        if (a?.target.type !== 'identifier' || counts.get(a.target.text!) !== 1) continue;
        const uses: N[] = [];
        walk(scope, (n) => {
          if (n !== a.target && n.type === 'identifier' && n.text === a.target.text && n.field !== 'attribute') uses.push(n);
        });
        if (uses.length !== 1) continue;
        const use = uses[0];
        let crosses = false;
        for (let p = parents.get(use); p && p !== scope; p = parents.get(p)) if (FUNCTIONS.has(p.type)) crosses = true;
        if (crosses) continue;
        const statements = statementsOf(scope);
        const next = statements[statements.indexOf(stmt) + 1];
        const nextValue = next ? (simpleAssignment(next)?.value ?? (next.type === 'return_statement' ? namedChildren(next)[0] : undefined)) : undefined;
        if (!pureValue(a.value) && nextValue !== use) continue;
        const holder = parents.get(use)!;
        holder.children = holder.children.map((c) => (c === use ? withField(clone(a.value), use.field) : c));
        scope.children = scope.children.filter((c) => c !== stmt);
        changed = true;
        return;
      }
    });
  }
}

function simplify(tree: N): N {
  let current = tree;
  let before = '';
  for (let i = 0; i < 20 && before !== ser(current); i++) {
    before = ser(current);
    current = rewrite(current, undefined)[0];
  }
  for (let i = 0; i < 10; i++) {
    before = ser(current);
    dropUnreadLocals(current);
    inlineSingleUse(current);
    if (ser(current) === before) break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Top level: pruning and identity
// ---------------------------------------------------------------------------

function unwrapDecorated(stmt: N): N {
  return stmt.type === 'decorated_definition' ? (child(stmt, 'definition') ?? stmt) : stmt;
}

function declaredNameNodes(stmt: N): N[] {
  const decl = unwrapDecorated(stmt);
  if (decl.type === 'function_definition' || decl.type === 'class_definition') {
    const name = child(decl, 'name');
    return name ? [name] : [];
  }
  return assignedNames(stmt);
}

function importLocalNodes(stmt: N): { spec: N; name: N }[] {
  const out: { spec: N; name: N }[] = [];
  if (stmt.type === 'import_from_statement') {
    for (const c of stmt.children.filter((x) => x.field === 'name')) {
      if (c.type === 'dotted_name') out.push({ spec: c, name: namedChildren(c).at(-1)! });
      if (c.type === 'aliased_import') out.push({ spec: c, name: child(c, 'alias')! });
    }
  }
  if (stmt.type === 'import_statement') {
    for (const c of stmt.children.filter((x) => x.field === 'name')) {
      if (c.type === 'dotted_name') out.push({ spec: c, name: namedChildren(c)[0] });
      if (c.type === 'aliased_import') out.push({ spec: c, name: child(c, 'alias')! });
    }
  }
  return out;
}

const IMPORTS = new Set(['import_statement', 'import_from_statement']);

/**
 * Whether defining this at module level does nothing until it's used. Decorators run at
 * import (`@router.get` registers a route) and so does an assignment's value.
 */
function quietDeclaration(stmt: N): boolean {
  if (stmt.type === 'decorated_definition') return false;
  if (stmt.type === 'function_definition' || stmt.type === 'class_definition') return true;
  const a = simpleAssignment(stmt);
  return a ? pureValue(a.value) : false;
}

function pruneAdditions(head: N, base: N, removed: string[], keep: Set<string>): void {
  const baseNames = new Set<string>();
  for (const stmt of base.children) {
    for (const n of declaredNameNodes(stmt)) baseNames.add(n.text!);
    for (const { name } of importLocalNodes(stmt)) baseNames.add(name.text!);
  }

  for (let changed = true; changed; ) {
    changed = false;
    const declNames = new Set<N>();
    for (const stmt of head.children) for (const n of declaredNameNodes(stmt)) declNames.add(n);
    const refs = new Map<string, number>();
    const count = (n: N) => {
      if (IMPORTS.has(n.type) || declNames.has(n)) return;
      if (n.type === 'identifier' && n.field !== 'attribute') refs.set(n.text!, (refs.get(n.text!) ?? 0) + 1);
      for (const c of n.children) count(c);
    };
    count(head);
    // Python has no export list: anything at module level can be imported, so `*` keeps it all.
    const unused = (name: N) => !baseNames.has(name.text!) && !refs.get(name.text!) && !keep.has(name.text!) && !keep.has('*');

    const parents = parentMap(head);
    for (const stmt of [...head.children]) {
      if (IMPORTS.has(stmt.type)) {
        const locals = importLocalNodes(stmt);
        if (locals.length === 0) continue; // `from x import *`
        for (const { spec, name } of locals) {
          if (!baseNames.has(name.text!) && !refs.get(name.text!)) {
            removeNode(spec, parents);
            removed.push(`import ${name.text}`);
            changed = true;
          }
        }
        if (!stmt.children.some((c) => c.field === 'name')) removeNode(stmt, parents);
        continue;
      }
      const names = declaredNameNodes(stmt);
      if (names.length > 0 && names.every(unused) && quietDeclaration(stmt)) {
        removeNode(stmt, parents);
        removed.push(`unreached ${names.map((n) => n.text).join(', ')}`);
        changed = true;
      }
    }
  }
}

function moduleText(n: N): string {
  if (n.children.length === 0) return n.text ?? '';
  return n.children.map(moduleText).join('');
}

function imports(tree: N): { source: string; names: string[] }[] {
  const out: { source: string; names: string[] }[] = [];
  for (const stmt of tree.children) {
    if (stmt.type === 'import_from_statement') {
      const names = stmt.children.filter((c) => c.field === 'name').map((c) => (c.type === 'aliased_import' ? child(c, 'name')! : c)).map((c) => namedChildren(c).at(-1)?.text ?? c.text ?? '');
      const wildcard = stmt.children.some((c) => c.type === 'wildcard_import');
      out.push({ source: moduleText(child(stmt, 'module_name')!), names: wildcard ? ['*'] : names });
    }
    if (stmt.type === 'import_statement') {
      for (const c of stmt.children.filter((x) => x.field === 'name')) {
        const dotted = c.type === 'aliased_import' ? child(c, 'name')! : c;
        out.push({ source: `~/${moduleText(dotted).replace(/\./g, '/')}`, names: ['*'] });
      }
    }
  }
  return out;
}

/** Rewrites `from <module> import ...`. Plain `import a.b` binds a name, so it stays. */
function mapImportSources(tree: N, map: (source: string) => string): void {
  for (const stmt of tree.children) {
    if (stmt.type !== 'import_from_statement') continue;
    const module = child(stmt, 'module_name');
    if (!module) continue;
    stmt.children = stmt.children.map((c) => (c === module ? withField(leaf('dotted_name', map(moduleText(module))), 'module_name') : c));
  }
}

function moduleStem(path: string): string {
  return path.replace(/\.pyi?$/, '').replace(/\/__init__$/, '');
}

/** `from .services.tracking import x` in `app/routes/orders.py` is `app/routes/services/tracking`. */
function resolveImport(from: string, source: string): string {
  const dots = /^\.+/.exec(source)?.[0].length ?? 0;
  if (dots === 0) return `~/${source.replace(/\./g, '/')}`;
  let dir = posix.dirname(from);
  for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
  const rest = source.slice(dots).replace(/\./g, '/');
  return posix.normalize(rest ? `${dir}/${rest}` : dir);
}

function importerPattern(path: string): string {
  const base = path.split('/').pop()!.replace(/\.pyi?$/, '');
  const name = base === '__init__' ? path.split('/').at(-2)! : base;
  return `^[[:space:]]*(from|import)[[:space:]].*(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`;
}

function topLevel(tree: N): Map<string, TopLevelItem> {
  const items = new Map<string, TopLevelItem>();
  const add = (key: string, item: TopLevelItem) => {
    let k = key;
    for (let i = 2; items.has(k); i++) k = `${key}#${i}`;
    items.set(k, item);
  };
  for (const stmt of tree.children) {
    if (!stmt.named) continue;
    if (IMPORTS.has(stmt.type)) {
      const source = stmt.type === 'import_from_statement' ? moduleText(child(stmt, 'module_name')!) : moduleText(stmt.children.find((c) => c.field === 'name')!);
      add(`import ${source}`, { node: stmt, label: `import ${source}`, isDeclaration: true, importOnly: true });
      continue;
    }
    const names = declaredNameNodes(stmt).map((n) => n.text!);
    if (names.length > 0) add(`decl ${names.join(',')}`, { node: stmt, label: names.join(', '), isDeclaration: true });
    else add(`stmt ${ser(stmt)}`, { node: stmt, label: 'top-level statement', isDeclaration: false });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Additive API changes
// ---------------------------------------------------------------------------

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'route', 'api_route', 'head', 'options']);
const RESPONSE_CALLS = new Set(['JSONResponse', 'jsonify', 'Response', 'ORJSONResponse']);

/** `@app.get("/path")` / `@bp.route("/path")` on a definition, as `GET /path`. */
function routeKey(n: N): string | undefined {
  if (n.type !== 'decorated_definition') return undefined;
  for (const dec of n.children.filter((c) => c.type === 'decorator')) {
    const call = namedChildren(dec)[0];
    if (call?.type !== 'call') continue;
    const fn = child(call, 'function');
    const method = fn?.type === 'attribute' ? child(fn, 'attribute')?.text : undefined;
    const path = namedChildren(child(call, 'arguments') ?? { type: '', named: true, children: [] })[0];
    if (method && ROUTE_METHODS.has(method) && path?.type === 'string') return `${method.toUpperCase()} ${path.text}`;
  }
  return undefined;
}

function hasDefault(param: N): boolean {
  return ['default_parameter', 'typed_default_parameter', 'list_splat_pattern', 'dictionary_splat_pattern', 'keyword_separator'].includes(param.type);
}

function insertionClassifier(base: N): ClassifyInsertion {
  const baseRoutes = new Set<string>();
  walk(base, (n) => {
    const key = routeKey(n);
    if (key) baseRoutes.add(key);
  });
  return (node, ancestors) => {
    const parent = ancestors.at(-1);
    // Pydantic / dataclass / TypedDict field with a default: `note: str | None = None`
    const a = simpleAssignment(node);
    if (a && child(a.assignment, 'type') && parent?.type === 'block' && ancestors.at(-2)?.type === 'class_definition') return 'optional-field';
    if (node.type === 'pair' && parent?.type === 'dictionary') {
      const holder = ancestors.at(-2);
      const call = ancestors.at(-3);
      const inHandler = ancestors.some((x) => routeKey(x));
      if ((holder?.type === 'return_statement' && inHandler) || (holder?.type === 'argument_list' && call?.type === 'call' && RESPONSE_CALLS.has(child(call, 'function')?.text ?? ''))) {
        return 'response-field';
      }
    }
    if (parent?.type === 'parameters' && hasDefault(node)) {
      const params = namedChildren(parent);
      if (params.slice(params.indexOf(node) + 1).every(hasDefault)) return 'optional-param';
    }
    const route = routeKey(node);
    if (route && !baseRoutes.has(route)) return 'new-endpoint';
    return undefined;
  };
}

export const python: LanguageAdapter = {
  id: 'python',
  extensions: ['.py'],
  async parse(source, presets) {
    const { parser, language } = await getParser();
    const parsed = parser.parse(source)!;
    const tags = new Map<number, RawTag>();
    for (const preset of presets) {
      const text = preset.queries.python;
      if (!text) continue;
      for (const match of compile(language, text, preset.vendor).matches(parsed.rootNode)) {
        const get = (name: string) => match.captures.find((c) => c.name === name)?.node;
        const bag = get('bag');
        const read = get('read');
        const key = get('key');
        if (bag) tags.set(bag.id, { kind: 'bag' });
        else if (read && key) {
          const keyText = key.type === 'string' ? (key.namedChildren.find((c) => c?.type === 'string_content')?.text ?? '') : key.text;
          tags.set(read.id, { kind: 'read', key: keyText, fallbackId: get('fallback')?.id });
        }
      }
    }
    const comments: Comment[] = [];
    const tree = fromTreeSitter(parsed.rootNode, comments, tags);
    parsed.delete();
    return { tree, comments };
  },
  collectFlagKeys,
  substituteFlags,
  simplify,
  pruneAdditions,
  imports,
  mapImportSources,
  moduleStem,
  resolveImport,
  importerPattern,
  topLevel,
  insertionClassifier,
};
