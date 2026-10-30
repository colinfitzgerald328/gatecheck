import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import type { LanguageAdapter, TopLevelItem } from '../adapter.ts';
import type { ClassifyInsertion } from '../compare.ts';
import { bagOff, canonicalKey, isFlagBag, matchRead } from '../flags.ts';
import { child, clone, fromTreeSitter, leaf, namedChildren, parentMap, removeNode, ser, walk, withField, type Comment, type N, type RawTag } from '../tree.ts';

let parserPromise: Promise<{ parser: Parser; language: Language }> | undefined;

function getParser(): Promise<{ parser: Parser; language: Language }> {
  parserPromise ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const language = await Language.load(require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'));
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
      throw new Error(`Invalid tsx query in preset "${vendor}": ${(err as Error).message}`);
    }
    queryCache.set(source, query);
  }
  return query;
}

function keyText(node: { type: string; text: string }): string {
  return node.type === 'string' ? node.text.slice(1, -1) : node.text;
}

// ---------------------------------------------------------------------------
// Flag aliases
// ---------------------------------------------------------------------------

type Alias =
  | { kind: 'scalar'; scope: N; name: string; key: string; off: N; declarator: N; patternProp?: N }
  | { kind: 'bag'; scope: N; name: string; declarator: N };

const SCOPES = new Set(['program', 'statement_block']);

function collectAliases(tree: N): Alias[] {
  const aliases: Alias[] = [];
  const visit = (n: N, scope: N) => {
    const inner = SCOPES.has(n.type) ? n : scope;
    if (n.type === 'variable_declarator') {
      const name = child(n, 'name');
      const value = child(n, 'value');
      if (name && value) {
        if (isFlagBag(value)) {
          if (name.type === 'identifier') {
            aliases.push({ kind: 'bag', scope, name: name.text!, declarator: n });
          } else if (name.type === 'object_pattern') {
            for (const prop of namedChildren(name)) {
              const a = destructuredAlias(prop);
              if (a) aliases.push({ kind: 'scalar', scope, declarator: n, patternProp: prop, ...a });
            }
          }
        } else if (name.type === 'identifier') {
          const read = matchRead(value);
          if (read) aliases.push({ kind: 'scalar', scope, name: name.text!, key: read.key, off: read.off, declarator: n });
        }
      }
    }
    for (const c of n.children) visit(c, inner);
  };
  visit(tree, tree);
  return aliases;
}

/** `{ a }`, `{ a: b }`, `{ a = dflt }` inside `const {...} = useFlags()`. */
function destructuredAlias(prop: N): { name: string; key: string; off: N } | null {
  if (prop.type === 'shorthand_property_identifier_pattern') {
    return { name: prop.text!, key: prop.text!, off: bagOff() };
  }
  if (prop.type === 'pair_pattern') {
    const key = child(prop, 'key');
    const value = child(prop, 'value');
    if (key && value?.type === 'identifier') return { name: value.text!, key: key.text!, off: bagOff() };
  }
  if (prop.type === 'object_assignment_pattern') {
    // A brand-new flag is missing from the bag, so the default applies.
    const left = child(prop, 'left');
    const right = child(prop, 'right');
    if (left?.type === 'shorthand_property_identifier_pattern' && right) {
      return { name: left.text!, key: left.text!, off: clone(right) };
    }
  }
  return null;
}

function bagMemberKey(n: N, bagNames: Set<string>): string | undefined {
  if (n.type !== 'member_expression') return undefined;
  const obj = child(n, 'object');
  if (obj?.type !== 'identifier' || !bagNames.has(obj.text!)) return undefined;
  return child(n, 'property')?.text;
}

function collectFlagKeys(tree: N): Set<string> {
  const keys = new Set<string>();
  const aliases = collectAliases(tree);
  const bagNames = new Set(aliases.filter((a) => a.kind === 'bag').map((a) => a.name));
  for (const a of aliases) if (a.kind === 'scalar') keys.add(canonicalKey(a.key));
  walk(tree, (n) => {
    const read = matchRead(n);
    if (read) keys.add(canonicalKey(read.key));
    const bagKey = bagMemberKey(n, bagNames);
    if (bagKey) keys.add(canonicalKey(bagKey));
  });
  return keys;
}

function removeDeclarator(declarator: N, parents: Map<N, N>): void {
  const decl = removeNode(declarator, parents);
  if (decl && !decl.children.some((c) => c.type === 'variable_declarator')) removeNode(decl, parents);
}

function substituteFlags(tree: N, newKeys: Set<string>, removed: string[]): void {
  const isNew = (key: string) => newKeys.has(canonicalKey(key));
  const aliases = collectAliases(tree);
  let parents = parentMap(tree);

  // 1. Drop alias declarations for new flags.
  const scalars = aliases.filter((a): a is Extract<Alias, { kind: 'scalar' }> => a.kind === 'scalar' && isNew(a.key));
  for (const a of scalars) {
    if (a.patternProp) {
      const pattern = removeNode(a.patternProp, parents)!;
      if (namedChildren(pattern).length === 0) removeDeclarator(a.declarator, parents);
    } else {
      removeDeclarator(a.declarator, parents);
    }
    removed.push(`flag alias ${a.name}`);
  }

  // 2. Replace references to those aliases, and reads through flag bags, within their scope.
  const bags = aliases.filter((a) => a.kind === 'bag');
  const replaceIn = (n: N, scope: N, scalarName: string | undefined, off: N | undefined, bagName: string | undefined) => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (scalarName && c.type === 'identifier' && c.text === scalarName) {
        n.children[i] = withField(clone(off!), c.field);
        continue;
      }
      if (scalarName && c.type === 'shorthand_property_identifier' && c.text === scalarName) {
        n.children[i] = {
          type: 'pair',
          named: true,
          field: c.field,
          children: [withField(leaf('property_identifier', scalarName), 'key'), leaf(':', ':', false), withField(clone(off!), 'value')],
        };
        continue;
      }
      if (bagName) {
        const key = bagMemberKey(c, new Set([bagName]));
        if (key && isNew(key)) {
          n.children[i] = withField(bagOff(), c.field);
          continue;
        }
      }
      replaceIn(c, scope, scalarName, off, bagName);
    }
  };
  for (const a of scalars) replaceIn(a.scope, a.scope, a.name, a.off, undefined);
  for (const a of bags) replaceIn(a.scope, a.scope, undefined, undefined, a.name);

  // 3. Replace direct reads like `await client.variation('k', ctx, false)`.
  const replaceReads = (n: N) => {
    for (let i = 0; i < n.children.length; i++) {
      const read = matchRead(n.children[i]);
      if (read && isNew(read.key)) {
        n.children[i] = withField(clone(read.off), n.children[i].field);
      } else {
        replaceReads(n.children[i]);
      }
    }
  };
  replaceReads(tree);

  // 4. A flag bag left with no readers was only there for the new flag.
  parents = parentMap(tree);
  for (const a of bags) {
    let refs = 0;
    walk(a.scope, (n) => {
      if (n.type === 'identifier' && n.text === a.name && n !== child(a.declarator, 'name')) refs++;
    });
    if (refs === 0 && parents.has(a.declarator)) {
      removeDeclarator(a.declarator, parents);
      removed.push(`flag bag ${a.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Simplifier
// ---------------------------------------------------------------------------

const LIST_PARENTS = new Set(['program', 'statement_block', 'switch_case', 'switch_default', 'jsx_element', 'class_body']);

function known(n: N | undefined): boolean | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'true':
      return true;
    case 'false':
    case 'null':
    case 'undefined':
      return false;
    case 'identifier':
      return n.text === 'undefined' ? false : undefined;
    case 'number':
      return Number(n.text) !== 0;
    case 'string':
      return n.text !== '';
  }
  return undefined;
}

function isNullish(n: N): boolean {
  return n.type === 'null' || n.type === 'undefined' || (n.type === 'identifier' && n.text === 'undefined');
}

function pure(n: N): boolean {
  if (known(n) !== undefined) return true;
  if (n.type === 'identifier' || n.type === 'this' || n.type === 'property_identifier') return true;
  if (n.type === 'member_expression') return n.children.filter((c) => c.named).every(pure);
  return false;
}

function operator(n: N): string | undefined {
  return child(n, 'operator')?.text ?? n.children.find((c) => !c.named)?.text;
}

/** Truthiness when used as a condition, where `x && false` is falsy no matter what `x` is. */
function testKnown(n: N | undefined): boolean | undefined {
  if (!n) return undefined;
  const k = known(n);
  if (k !== undefined) return k;
  if (n.type === 'unary_expression' && operator(n) === '!') {
    const inner = testKnown(child(n, 'argument'));
    return inner === undefined ? undefined : !inner;
  }
  if (n.type === 'binary_expression') {
    const left = child(n, 'left')!;
    const right = child(n, 'right')!;
    const l = testKnown(left);
    const r = testKnown(right);
    switch (operator(n)) {
      case '&&':
        if (l === false || (r === false && pure(left))) return false;
        if (l === true) return r;
        break;
      case '||':
        if (l === true || (r === true && pure(left))) return true;
        if (l === false) return r;
        break;
    }
  }
  return undefined;
}

function bool(value: boolean): N {
  return value ? leaf('true', 'true') : leaf('false', 'false');
}

function emptyBlock(): N {
  return { type: 'statement_block', named: true, children: [leaf('{', '{', false), leaf('}', '}', false)] };
}

function blockStatements(n: N): N[] {
  return n.type === 'statement_block' ? n.children.filter((c) => c.named) : [n];
}

function isFragment(n: N): boolean {
  const open = n.children[0];
  return n.type === 'jsx_element' && open?.type === 'jsx_opening_element' && namedChildren(open).length === 0;
}

const TERMINATORS = new Set(['return_statement', 'throw_statement']);
const HOISTED = new Set(['function_declaration', 'generator_function_declaration']);

function rewrite(n: N, parentType: string | undefined): N[] {
  const kids: N[] = [];
  for (const c of n.children) {
    const out = rewrite(c, n.type);
    for (const o of out) o.field = c.field;
    if (out.length === 1 || LIST_PARENTS.has(n.type)) {
      kids.push(...out);
    } else if (out.length === 0) {
      kids.push(withField(emptyBlock(), c.field));
    } else {
      kids.push(withField({ ...emptyBlock(), children: [leaf('{', '{', false), ...out, leaf('}', '}', false)] }, c.field));
    }
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
    case 'unary_expression': {
      const k = known(child(n, 'argument'));
      return operator(n) === '!' && k !== undefined ? [bool(!k)] : [n];
    }
    case 'binary_expression': {
      const left = child(n, 'left')!;
      const right = child(n, 'right')!;
      const l = known(left);
      const op = operator(n);
      if (op === '&&' && l !== undefined) return [l ? right : left];
      if (op === '||' && l !== undefined) return [l ? left : right];
      if (op === '??' && known(left) !== undefined) return [isNullish(left) ? right : left];
      if ((op === '===' || op === '!==') && known(left) !== undefined && known(right) !== undefined && left.children.length === 0 && right.children.length === 0) {
        const same = left.type === right.type && left.text === right.text;
        return [bool(op === '===' ? same : !same)];
      }
      return [n];
    }
    case 'ternary_expression': {
      const k = testKnown(child(n, 'condition'));
      if (k === undefined) return [n];
      return [child(n, k ? 'consequence' : 'alternative')!];
    }
    case 'if_statement': {
      const elseClause = child(n, 'alternative');
      if (elseClause) {
        const body = namedChildren(elseClause)[0];
        if (!body || (body.type === 'statement_block' && namedChildren(body).length === 0)) {
          n.children = n.children.filter((c) => c !== elseClause);
        }
      }
      const k = testKnown(child(n, 'condition'));
      if (k === undefined) return [n];
      const taken = k ? child(n, 'consequence') : namedChildren(child(n, 'alternative') ?? { type: '', named: true, children: [] })[0];
      if (!taken) return [];
      return LIST_PARENTS.has(parentType ?? '') ? blockStatements(taken) : [taken];
    }
    case 'expression_statement': {
      // `false && track()` folds to `false;`, which does nothing.
      const expr = namedChildren(n)[0];
      return expr && known(expr) !== undefined && expr.children.length === 0 ? [] : [n];
    }
    case 'empty_statement':
      return LIST_PARENTS.has(parentType ?? '') ? [] : [n];
    case 'jsx_expression': {
      if (parentType !== 'jsx_element') return [n];
      const inner = namedChildren(n);
      // React renders nothing for booleans, null and undefined.
      if (inner.length === 0) return [];
      const only = inner[0];
      if (inner.length === 1 && (only.type === 'true' || only.type === 'false' || isNullish(only))) return [];
      return [n];
    }
    case 'jsx_text': {
      if (parentType !== 'jsx_element') return [n];
      const text = (n.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return [];
      n.text = text;
      return [n];
    }
    case 'jsx_element': {
      if (!isFragment(n)) return [n];
      const content = n.children.slice(1, -1).filter((c) => c.named);
      return content.length === 1 && (content[0].type === 'jsx_element' || content[0].type === 'jsx_self_closing_element') ? [content[0]] : [n];
    }
    case 'named_imports': {
      const specs = n.children.filter((c) => c.type === 'import_specifier').sort((a, b) => ser(a).localeCompare(ser(b)));
      n.children = [leaf('{', '{', false), ...specs, leaf('}', '}', false)];
      return [n];
    }
    case 'statement_block': {
      const cut = n.children.findIndex((c) => TERMINATORS.has(c.type));
      if (cut >= 0) {
        n.children = n.children.filter((c, i) => i <= cut || !c.named || HOISTED.has(c.type));
      }
      return [n];
    }
  }
  return [n];
}

const ASSIGNMENTS = new Set(['assignment_expression', 'augmented_assignment_expression', 'update_expression']);

// React hooks with no effect of their own until their values are used.
const QUIET_HOOKS = new Set(['useState', 'useRef', 'useMemo', 'useCallback', 'useId', 'useReducer', 'useContext']);
const QUIET_INITIALIZERS = new Set(['arrow_function', 'function_expression', 'array', 'object', 'template_string', 'regex']);

function quietInitializer(n: N): boolean {
  if (pure(n) || QUIET_INITIALIZERS.has(n.type)) return true;
  if (n.type === 'call_expression') {
    const fn = child(n, 'function');
    const name = fn?.type === 'identifier' ? fn.text : fn?.type === 'member_expression' ? child(fn, 'property')?.text : undefined;
    return QUIET_HOOKS.has(name ?? '');
  }
  return false;
}

/**
 * Drops local declarations nothing reads any more, when creating them does nothing
 * observable: `const [open, setOpen] = useState(false)` that only gated code used.
 * React requires hooks to run unconditionally, so they can't move inside the gate.
 */
function dropUnreadLocals(tree: N): void {
  for (let changed = true; changed; ) {
    changed = false;
    const parents = parentMap(tree);
    walk(tree, (decl) => {
      if (decl.type !== 'lexical_declaration') return;
      const block = parents.get(decl);
      if (block?.type !== 'statement_block') return;
      const declarators = decl.children.filter((c) => c.type === 'variable_declarator');
      if (!declarators.every((d) => child(d, 'value') && quietInitializer(child(d, 'value')!))) return;
      const nameNodes = new Set(declarators.flatMap((d) => patternNames(child(d, 'name')!)));
      const names = new Set([...nameNodes].map((n) => n.text!));
      let read = false;
      walk(block, (n) => {
        if (!nameNodes.has(n) && REFERENCE_TYPES.has(n.type) && names.has(n.text!)) read = true;
      });
      if (read) return;
      block.children = block.children.filter((c) => c !== decl);
      changed = true;
    });
  }
}

/**
 * Agents often turn `const x` into `let x` so the gated branch can reassign it.
 * Once the branch is projected away nothing reassigns it, so it's a `const` again.
 */
function constifyLets(tree: N): void {
  const parents = parentMap(tree);
  walk(tree, (decl) => {
    if (decl.type !== 'lexical_declaration' || decl.children[0]?.text !== 'let') return;
    let scope = parents.get(decl);
    while (scope && !SCOPES.has(scope.type)) scope = parents.get(scope);
    if (!scope) return;
    const declarators = decl.children.filter((c) => c.type === 'variable_declarator');
    if (declarators.some((d) => !child(d, 'value'))) return;
    const names = new Set(declarators.flatMap((d) => patternNames(child(d, 'name')!).map((n) => n.text!)));
    let reassigned = false;
    walk(scope, (n) => {
      if (!ASSIGNMENTS.has(n.type)) return;
      const target = child(n, 'left') ?? child(n, 'argument');
      walk(target ?? n, (t) => {
        if (t.type === 'identifier' && names.has(t.text!)) reassigned = true;
      });
    });
    if (!reassigned) decl.children[0] = { ...decl.children[0], text: 'const' };
  });
}

const FUNCTIONS = new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration']);

/** A value whose creation has no effects: names, property reads, literals, and objects or arrays of those. */
function pureValue(n: N): boolean {
  if (pure(n)) return true;
  if (n.type === 'object') return namedChildren(n).every((c) => (c.type === 'pair' ? pureValue(child(c, 'value')!) : c.type === 'shorthand_property_identifier'));
  if (n.type === 'array') return namedChildren(n).every(pureValue);
  return false;
}

/**
 * `const total = subtotal` or `const body = { id: o.id }; res.json(body)`: a constant
 * used once reads the same as its value written in place. Inlined when the value has
 * no effects, or when the one use is the whole value of the next declaration or return.
 * Never into another function, which would read the value later.
 */
function inlineSingleUse(tree: N): void {
  for (let changed = true; changed; ) {
    changed = false;
    const parents = parentMap(tree);
    walk(tree, (decl) => {
      if (changed || decl.type !== 'lexical_declaration' || decl.children[0]?.text !== 'const') return;
      const block = parents.get(decl);
      if (block?.type !== 'statement_block' && block?.type !== 'program') return;
      const declarators = decl.children.filter((c) => c.type === 'variable_declarator');
      if (declarators.length !== 1) return;
      const nameNode = child(declarators[0], 'name');
      const value = child(declarators[0], 'value');
      if (nameNode?.type !== 'identifier' || !value) return;

      const uses: N[] = [];
      walk(block, (n) => {
        if (n !== nameNode && REFERENCE_TYPES.has(n.type) && n.text === nameNode.text) uses.push(n);
      });
      if (uses.length !== 1) return;
      const use = uses[0];
      for (let p = parents.get(use); p && p !== block; p = parents.get(p)) if (FUNCTIONS.has(p.type)) return;

      const next = block.children[block.children.indexOf(decl) + 1];
      const nextValue =
        next?.type === 'lexical_declaration'
          ? next.children.filter((c) => c.type === 'variable_declarator').map((d) => child(d, 'value'))[0]
          : next?.type === 'return_statement'
            ? namedChildren(next)[0]
            : undefined;
      if (!pureValue(value) && nextValue !== use) return;

      const holder = parents.get(use)!;
      const replacement: N =
        use.type === 'shorthand_property_identifier'
          ? { type: 'pair', named: true, field: use.field, children: [withField(leaf('property_identifier', use.text!), 'key'), leaf(':', ':', false), withField(clone(value), 'value')] }
          : withField(clone(value), use.field);
      holder.children = holder.children.map((c) => (c === use ? replacement : c));
      block.children = block.children.filter((c) => c !== decl);
      changed = true;
    });
  }
}

/**
 * A React class component's field nothing reads with `this.<name>`, set to a value with
 * no effects (`state = { sort: 'newest' }` only gated code uses). Components only: on a
 * data class a new field is part of its shape.
 */
function dropUnreadClassFields(tree: N): void {
  walk(tree, (body) => {
    if (body.type !== 'class_body') return;
    const isComponent = body.children.some((m) => m.type === 'method_definition' && child(m, 'name')?.text === 'render');
    if (!isComponent) return;
    body.children = body.children.filter((field) => {
      if (field.type !== 'public_field_definition') return true;
      const name = child(field, 'name');
      const value = child(field, 'value');
      if (name?.type !== 'property_identifier' || (value && !quietInitializer(value))) return true;
      let read = false;
      walk(body, (n) => {
        if (n.type === 'member_expression' && child(n, 'object')?.type === 'this' && child(n, 'property')?.text === name.text) read = true;
      });
      return read;
    });
  });
}

/**
 * Express, Fastify and similar ignore a route handler's return value, so a handler
 * ending in `return res.json(x)` behaves like one ending in `res.json(x)`.
 */
function normalizeHandlerReturns(tree: N): void {
  const names = new Set<string>();
  const inline = new Set<N>();
  walk(tree, (n) => {
    if (!routeKey(n) || n.type !== 'call_expression') return;
    for (const arg of namedChildren(child(n, 'arguments')!).slice(1)) {
      if (arg.type === 'identifier') names.add(arg.text!);
      if (FUNCTIONS.has(arg.type)) inline.add(arg);
    }
  });
  walk(tree, (fn) => {
    const isHandler = inline.has(fn) || (fn.type === 'function_declaration' && names.has(child(fn, 'name')?.text ?? ''));
    const body = isHandler ? child(fn, 'body') : undefined;
    if (body?.type !== 'statement_block') return;
    const statements = body.children.filter((c) => c.named);
    const last = statements.at(-1);
    const expr = last?.type === 'return_statement' ? namedChildren(last)[0] : undefined;
    if (!last || !expr) return;
    body.children = body.children.map((c) => (c === last ? { type: 'expression_statement', named: true, children: [expr, leaf(';', ';', false)] } : c));
  });
}

function simplify(tree: N): N {
  // Rules feed each other (a fold can expose a dead branch), so run to a fixpoint.
  let current = tree;
  let before = '';
  for (let i = 0; i < 20 && before !== ser(current); i++) {
    before = ser(current);
    current = rewrite(current, undefined)[0];
  }
  normalizeHandlerReturns(current);
  for (let i = 0; i < 10; i++) {
    before = ser(current);
    dropUnreadLocals(current);
    dropUnreadClassFields(current);
    constifyLets(current);
    inlineSingleUse(current);
    if (ser(current) === before) break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Top level: pruning and identity
// ---------------------------------------------------------------------------

const DECLARATIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
]);

function unwrapExport(stmt: N): N {
  return stmt.type === 'export_statement' ? (child(stmt, 'declaration') ?? stmt) : stmt;
}

function patternNames(n: N): N[] {
  const out: N[] = [];
  walk(n, (c) => {
    if (c.type === 'identifier' || c.type === 'shorthand_property_identifier_pattern') out.push(c);
  });
  return out;
}

/** Name nodes a top-level statement declares. */
function declaredNameNodes(stmt: N): N[] {
  const decl = unwrapExport(stmt);
  if (DECLARATIONS.has(decl.type)) {
    const name = child(decl, 'name');
    return name ? [name] : [];
  }
  if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
    return decl.children.filter((c) => c.type === 'variable_declarator').flatMap((d) => patternNames(child(d, 'name')!));
  }
  return [];
}

function importLocalNodes(stmt: N): { spec: N; name: N }[] {
  const out: { spec: N; name: N }[] = [];
  const clause = stmt.children.find((c) => c.type === 'import_clause');
  if (!clause) return out;
  for (const c of clause.children) {
    if (c.type === 'identifier') out.push({ spec: c, name: c });
    if (c.type === 'namespace_import') {
      const id = namedChildren(c).find((x) => x.type === 'identifier');
      if (id) out.push({ spec: c, name: id });
    }
    if (c.type === 'named_imports') {
      for (const s of c.children.filter((x) => x.type === 'import_specifier')) {
        const name = child(s, 'alias') ?? child(s, 'name');
        if (name) out.push({ spec: s, name });
      }
    }
  }
  return out;
}

const REFERENCE_TYPES = new Set(['identifier', 'type_identifier', 'shorthand_property_identifier']);

/**
 * Whether defining this does nothing until it's used. A variable's value runs at load
 * (`const off = store.subscribe(fn)`), and so does a class decorator.
 */
function quietDeclaration(stmt: N): boolean {
  const decl = unwrapExport(stmt);
  if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
    return decl.children.filter((c) => c.type === 'variable_declarator').every((d) => !child(d, 'value') || quietInitializer(child(d, 'value')!));
  }
  if (decl.type === 'class_declaration' || decl.type === 'abstract_class_declaration') return !decl.children.some((c) => c.type === 'decorator');
  return DECLARATIONS.has(decl.type);
}

function pruneAdditions(head: N, base: N, removed: string[], keep: Set<string>): void {
  const baseNames = new Set<string>();
  for (const stmt of base.children) {
    for (const n of declaredNameNodes(stmt)) baseNames.add(n.text!);
    if (stmt.type === 'import_statement') for (const { name } of importLocalNodes(stmt)) baseNames.add(name.text!);
  }

  for (let changed = true; changed; ) {
    changed = false;
    const declNames = new Set<N>();
    for (const stmt of head.children) for (const n of declaredNameNodes(stmt)) declNames.add(n);
    const refs = new Map<string, number>();
    const count = (n: N) => {
      if (n.type === 'import_statement' || declNames.has(n)) return;
      if (REFERENCE_TYPES.has(n.type)) refs.set(n.text!, (refs.get(n.text!) ?? 0) + 1);
      for (const c of n.children) count(c);
    };
    count(head);
    // `keep` holds names other files import from this one; `*` means a namespace import.
    const exported = (stmt: N) => stmt.type === 'export_statement' && keep.has('*');
    const unused = (name: N) => !baseNames.has(name.text!) && !refs.get(name.text!) && !keep.has(name.text!);

    const parents = parentMap(head);
    for (const stmt of [...head.children]) {
      if (stmt.type === 'import_statement') {
        const locals = importLocalNodes(stmt);
        if (locals.length === 0) continue; // side-effect import
        for (const { spec, name } of locals) {
          if (!unused(name)) continue;
          removeNode(spec, parents);
          removed.push(`import ${name.text}`);
          changed = true;
        }
        const clause = stmt.children.find((c) => c.type === 'import_clause')!;
        clause.children = clause.children.filter((c) => c.type !== 'named_imports' || c.children.some((s) => s.type === 'import_specifier'));
        if (!clause.children.some((c) => c.named)) removeNode(stmt, parents);
        continue;
      }
      const names = declaredNameNodes(stmt);
      if (names.length > 0 && !exported(stmt) && names.every(unused) && quietDeclaration(stmt)) {
        removeNode(stmt, parents);
        removed.push(`unreached ${names.map((n) => n.text).join(', ')}`);
        changed = true;
      }
    }
  }
}

function imports(tree: N): { source: string; names: string[] }[] {
  const out: { source: string; names: string[] }[] = [];
  for (const stmt of tree.children) {
    if (stmt.type !== 'import_statement' && stmt.type !== 'export_statement') continue;
    const source = child(stmt, 'source')?.text;
    if (!source) continue;
    const names: string[] = [];
    const clause = stmt.children.find((c) => c.type === 'import_clause');
    for (const c of clause?.children ?? []) {
      if (c.type === 'identifier') names.push('default');
      if (c.type === 'namespace_import') names.push('*');
      if (c.type === 'named_imports') {
        for (const spec of c.children.filter((x) => x.type === 'import_specifier')) names.push(child(spec, 'name')!.text!);
      }
    }
    // `export * from './x'` and `export { a } from './x'`
    if (stmt.type === 'export_statement') {
      const exportClause = stmt.children.find((c) => c.type === 'export_clause');
      if (exportClause) for (const spec of namedChildren(exportClause)) names.push(child(spec, 'name')?.text ?? '*');
      else names.push('*');
    }
    out.push({ source, names });
  }
  return out;
}

function mapImportSources(tree: N, map: (source: string) => string): void {
  for (const stmt of tree.children) {
    if (stmt.type !== 'import_statement' && stmt.type !== 'export_statement') continue;
    const source = child(stmt, 'source');
    if (source?.text !== undefined) source.text = map(source.text);
  }
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
    if (stmt.type === 'import_statement') {
      const source = child(stmt, 'source')?.text ?? '';
      const importOnly = stmt.children.some((c) => c.type === 'import_clause');
      add(`import ${source}`, { node: stmt, label: `import '${source}'`, isDeclaration: true, importOnly });
      continue;
    }
    const names = declaredNameNodes(stmt).map((n) => n.text!);
    if (names.length > 0) {
      add(`decl ${names.join(',')}`, { node: stmt, label: names.join(', '), isDeclaration: true });
    } else {
      add(`stmt ${ser(stmt)}`, { node: stmt, label: 'top-level statement', isDeclaration: false });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Additive API changes
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options']);
// res.json / res.send (Express), reply.send (Fastify), c.json (Hono), Response.json / NextResponse.json
const RESPONSE_METHODS = new Set(['json', 'send']);

function memberCallee(call: N): string | undefined {
  const fn = child(call, 'function');
  return fn?.type === 'member_expression' ? child(fn, 'property')?.text : undefined;
}

/** `app.get('/path', ...)` style registration, as `GET /path`. */
function routeKey(n: N): string | undefined {
  const call = n.type === 'expression_statement' ? namedChildren(n)[0] : n;
  if (call?.type !== 'call_expression') return undefined;
  const method = memberCallee(call);
  if (!method || !HTTP_METHODS.has(method)) return undefined;
  const path = namedChildren(child(call, 'arguments') ?? { type: '', named: true, children: [] })[0];
  return path?.type === 'string' ? `${method.toUpperCase()} ${path.text}` : undefined;
}

function hasDefault(param: N): boolean {
  return param.type === 'optional_parameter' || child(param, 'value') !== undefined;
}

function insertionClassifier(base: N): ClassifyInsertion {
  const baseRoutes = new Set<string>();
  walk(base, (n) => {
    const key = routeKey(n);
    if (key) baseRoutes.add(key);
  });
  return (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (
      node.type === 'property_signature' &&
      node.children.some((c) => !c.named && c.text === '?') &&
      (parent?.type === 'interface_body' || parent?.type === 'object_type')
    ) {
      return 'optional-field';
    }
    if ((node.type === 'pair' || node.type === 'shorthand_property_identifier') && parent?.type === 'object') {
      const args = ancestors.at(-2);
      const call = ancestors.at(-3);
      if (args?.type === 'arguments' && call?.type === 'call_expression' && RESPONSE_METHODS.has(memberCallee(call) ?? '')) {
        return 'response-field';
      }
    }
    if (parent?.type === 'formal_parameters' && hasDefault(node)) {
      // Trailing only: a new optional parameter before a required one shifts every call.
      const params = namedChildren(parent);
      if (params.slice(params.indexOf(node) + 1).every(hasDefault)) return 'optional-param';
    }
    // A path main already serves is a behavior change, not an addition.
    const route = routeKey(node);
    if (route && !baseRoutes.has(route)) return 'new-endpoint';
    return undefined;
  };
}

function moduleStem(path: string): string {
  return path.replace(/\.(m|c)?[jt]sx?$/, '').replace(/\/index$/, '');
}

/** `./x.js` imported from `src/a.ts` is `src/x`. */
function resolveImport(from: string, source: string): string {
  if (!source.startsWith('.')) return source;
  return moduleStem(posix.normalize(posix.join(posix.dirname(from), source)));
}

function importerPattern(path: string): string {
  const base = path.split('/').pop()!.replace(/\.(m|c)?[jt]sx?$/, '');
  const name = base === 'index' ? path.split('/').at(-2)! : base;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(from|import|require\\()[[:space:]]*\\(?['"][^'"]*/${escaped}(\\.[a-z]+)?['"]`;
}

export const tsx: LanguageAdapter = {
  id: 'tsx',
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  async parse(source, presets) {
    const { parser, language } = await getParser();
    const parsed = parser.parse(source)!;
    const tags = new Map<number, RawTag>();
    for (const preset of presets) {
      const text = preset.queries.tsx;
      if (!text) continue;
      for (const match of compile(language, text, preset.vendor).matches(parsed.rootNode)) {
        const get = (name: string) => match.captures.find((c) => c.name === name)?.node;
        const bag = get('bag');
        const read = get('read');
        const key = get('key');
        if (bag) tags.set(bag.id, { kind: 'bag' });
        else if (read && key) tags.set(read.id, { kind: 'read', key: keyText(key), fallbackId: get('fallback')?.id });
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
