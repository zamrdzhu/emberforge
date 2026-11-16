// GraphQL v4: a small but real executor — lexer, parser (operations, fragments, variables,
// directives), a programmatic schema, field resolution over the forge store, Relay-style
// connections with cursors, and introspection rich enough for gh's feature probes. Unknown
// fields answer HTTP 200 with an errors array naming them, as GitHub does.
import { Forge, VIEWER, type Issue, type Pull, type Repo, type User } from './forge.ts';
import { diffTrees, mergeConflicts } from './rest.ts';
import type { Ctx, Reply } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer + parser
// ---------------------------------------------------------------------------

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'eof'; value: string };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: src.slice(i + 3, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1]!;
          if (esc === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; }
          else { out += escapeChar(esc); j += 2; }
        } else { out += src[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

function escapeChar(c: string): string {
  return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' } as Record<string, string>)[c] ?? c;
}

export type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string' | 'number' | 'boolean' | 'enum' | 'null'; value: string | number | boolean | null }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, Value>;
  directives: { name: string; args: Record<string, Value> }[];
  selection?: SelectionSet;
}
export type Selection =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selection: SelectionSet };
export type SelectionSet = Selection[];
export interface Operation {
  op: 'query' | 'mutation';
  name?: string;
  selection: SelectionSet;
  varDefs: Record<string, Value | undefined>;
}
interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selection: SelectionSet }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;
  constructor(src: string) {
    this.tokens = lex(src);
  }
  private peek(): Token { return this.tokens[this.at]!; }
  private next(): Token { return this.tokens[this.at++]!; }
  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }
  private skip(value: string): boolean {
    if (this.peek().value === value) { this.at += 1; return true; }
    return false;
  }

  parseDocument(): Document {
    const doc: Document = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.value === '{') {
        doc.operations.push({ op: 'query', selection: this.parseSelectionSet(), varDefs: {} });
      } else if (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription') {
        this.next();
        const op = t.value === 'mutation' ? 'mutation' : 'query';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs: Record<string, Value | undefined> = {};
        if (this.skip('(')) {
          while (!this.skip(')')) {
            this.expect('$');
            const varName = this.next().value;
            this.expect(':');
            this.parseTypeRef();
            let def: Value | undefined;
            if (this.skip('=')) def = this.parseValue();
            varDefs[varName] = def;
            this.parseDirectives();
          }
        }
        this.parseDirectives();
        doc.operations.push({ op, name, selection: this.parseSelectionSet(), varDefs });
      } else if (t.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        this.parseDirectives();
        doc.fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${t.value}`);
      }
    }
    return doc;
  }

  private parseTypeRef(): void {
    if (this.skip('[')) {
      this.parseTypeRef();
      this.expect(']');
    } else this.next();
    this.skip('!');
  }

  private parseDirectives(): { name: string; args: Record<string, Value> }[] {
    const out: { name: string; args: Record<string, Value> }[] = [];
    while (this.skip('@')) {
      const name = this.next().value;
      const args = this.peek().value === '(' ? this.parseArgs() : {};
      out.push({ name, args });
    }
    return out;
  }

  private parseArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    this.expect('(');
    while (!this.skip(')')) {
      const name = this.next().value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.value === '$') return { kind: 'var', name: this.next().value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'number') return { kind: 'number', value: Number(t.value) };
    if (t.value === '[') {
      const items: Value[] = [];
      while (!this.skip(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (t.value === '{') {
      const fields: Record<string, Value> = {};
      while (!this.skip('}')) {
        const name = this.next().value;
        this.expect(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (t.value === 'true') return { kind: 'boolean', value: true };
    if (t.value === 'false') return { kind: 'boolean', value: false };
    if (t.value === 'null') return { kind: 'null', value: null };
    return { kind: 'enum', value: t.value };
  }

  private parseSelectionSet(): SelectionSet {
    this.expect('{');
    const out: SelectionSet = [];
    while (!this.skip('}')) {
      if (this.skip('...')) {
        if (this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.parseDirectives();
          out.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          this.parseDirectives();
          out.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      let name = this.next().value;
      let alias: string | undefined;
      if (this.skip(':')) {
        alias = name;
        name = this.next().value;
      }
      const args = this.peek().value === '(' ? this.parseArgs() : {};
      const directives = this.parseDirectives();
      const selection = this.peek().value === '{' ? this.parseSelectionSet() : undefined;
      out.push({ alias, name, args, directives, selection });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

type Resolver = (source: any, args: Record<string, unknown>, ctx: ExecCtx) => unknown;
interface FieldDef {
  type: string;
  args?: Record<string, string>;
  resolve: Resolver;
}
interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
  description?: string;
}

interface ExecCtx {
  forge: Forge;
  vars: Record<string, unknown>;
  doc: Document;
  errors: { message: string }[];
}

const SCHEMA = new Map<string, TypeDef>();
function defType(name: string, def: TypeDef): void {
  SCHEMA.set(name, def);
}
['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'Base64String', 'HTML'].forEach((name) =>
  defType(name, { kind: 'SCALAR' }),
);

function parseTypeRefStr(ref: string): Record<string, unknown> {
  const trimmed = ref.trim();
  if (trimmed.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: parseTypeRefStr(trimmed.slice(0, -1)) };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return { kind: 'LIST', name: null, ofType: parseTypeRefStr(trimmed.slice(1, -1)) };
  const def = SCHEMA.get(trimmed);
  return { kind: def?.kind ?? 'OBJECT', name: trimmed, ofType: null };
}

function namedType(ref: string): string {
  return ref.replace(/[\[\]!]/g, '');
}

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, and decodable by node(id:)
// ---------------------------------------------------------------------------

export function globalId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}
function parseGlobalId(id: string): { type: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    return m !== null ? { type: m[1]!, dbId: parseInt(m[2]!, 10) } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Value coercion + connections
// ---------------------------------------------------------------------------

function coerce(value: Value | undefined, ctx: ExecCtx): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'var': return ctx.vars[value.name];
    case 'string': case 'number': case 'boolean': case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((i) => coerce(i, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) out[k] = coerce(v, ctx);
      return out;
    }
  }
}

function coerceArgs(node: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.args)) out[k] = coerce(v, ctx);
  return out;
}

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const m = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return m !== null ? parseInt(m[1]!, 10) : -1;
}

interface Conn<T> {
  nodes: T[];
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function connect<T>(items: T[], args: Record<string, unknown>): Conn<T> {
  let start = 0;
  if (typeof args.after === 'string') start = cursorIndex(args.after) + 1;
  let slice = items.slice(start);
  if (typeof args.first === 'number') slice = slice.slice(0, Math.max(0, args.first));
  return {
    nodes: slice,
    edges: slice.map((node, i) => ({ node, cursor: cursorOf(start + i) })),
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
    },
    totalCount: items.length,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function directivesAllow(node: FieldNode, ctx: ExecCtx): boolean {
  for (const d of node.directives) {
    const ifArg = d.args.if !== undefined ? coerce(d.args.if, ctx) : undefined;
    if (d.name === 'skip' && ifArg === true) return false;
    if (d.name === 'include' && ifArg === false) return false;
  }
  return true;
}

function executeSelectionSet(source: any, typeName: string, selection: SelectionSet, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA.get(typeName);
  const expand = (sel: SelectionSet): void => {
    for (const item of sel) {
      if ('kind' in item && item.kind === 'fragmentSpread') {
        const frag = ctx.doc.fragments.get(item.name);
        if (frag !== undefined && (frag.typeCondition === undefined || frag.typeCondition === typeName)) expand(frag.selection);
        continue;
      }
      if ('kind' in item && item.kind === 'inlineFragment') {
        if (item.typeCondition === undefined || item.typeCondition === typeName) expand(item.selection);
        continue;
      }
      const node = item as FieldNode;
      if (!directivesAllow(node, ctx)) continue;
      const key = node.alias ?? node.name;
      out[key] = executeField(source, typeName, typeDef, node, ctx);
    }
  };
  expand(selection);
  return out;
}

function executeField(source: any, typeName: string, typeDef: TypeDef | undefined, node: FieldNode, ctx: ExecCtx): unknown {
  if (node.name === '__typename') return typeName;
  if (node.name === '__type' && typeName === 'Query') {
    const name = coerce(node.args.name, ctx);
    const value = typeof name === 'string' ? typeValue(name) : null;
    return value === null ? null : completeValue(value, '__Type', node, ctx);
  }
  if (node.name === '__schema' && typeName === 'Query') return completeValue(schemaValue(), '__Schema', node, ctx);
  const field = typeDef?.fields?.[node.name];
  if (field === undefined) {
    ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  const args = coerceArgs(node, ctx);
  let value: unknown;
  try {
    value = field.resolve(source, args, ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  return completeValue(value, field.type, node, ctx);
}

function completeValue(value: unknown, typeRef: string, node: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  const trimmed = typeRef.trim();
  if (trimmed.endsWith('!')) return completeValue(value, trimmed.slice(0, -1), node, ctx);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    return (value as unknown[]).map((v) => completeValue(v, inner, node, ctx));
  }
  const target = namedType(trimmed);
  const def = SCHEMA.get(target);
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  if (node.selection === undefined) return value;
  const actualType = typeof (value as { __type?: string }).__type === 'string' ? (value as { __type: string }).__type : target;
  return executeSelectionSet(value, actualType, node.selection, ctx);
}

// ---------------------------------------------------------------------------
// Introspection values
// ---------------------------------------------------------------------------

function typeValue(name: string): Record<string, unknown> | null {
  const def = SCHEMA.get(name);
  if (def === undefined) return null;
  return { __type: '__Type', name, def };
}
function schemaValue(): Record<string, unknown> {
  return { __type: '__Schema' };
}

function introspectionTypes(): void {
  const typeField = (type: string, resolve: Resolver, args?: Record<string, string>): FieldDef => ({ type, args, resolve });
  defType('__Type', {
    kind: 'OBJECT',
    fields: {
      name: typeField('String', (s) => s.name),
      kind: typeField('String!', (s) => s.def.kind),
      description: typeField('String', (s) => s.def.description ?? null),
      fields: typeField('[__Field]', (s, args) => {
        if (s.def.fields === undefined) return null;
        void args;
        return Object.entries(s.def.fields).map(([fname, fdef]) => ({ __type: '__Field', name: fname, def: fdef }));
      }, { includeDeprecated: 'Boolean' }),
      enumValues: typeField('[__EnumValue]', (s) => {
        if (s.def.enumValues === undefined) return null;
        return s.def.enumValues.map((v) => ({ __type: '__EnumValue', name: v }));
      }, { includeDeprecated: 'Boolean' }),
      inputFields: typeField('[__InputValue]', (s) => {
        if (s.def.inputFields === undefined) return null;
        return Object.entries(s.def.inputFields).map(([n, t]) => ({ __type: '__InputValue', name: n, typeRef: t }));
      }),
      possibleTypes: typeField('[__Type]', () => null),
      interfaces: typeField('[__Type]', () => []),
      ofType: typeField('__Type', () => null),
      specifiedByURL: typeField('String', () => null),
    },
  });
  defType('__Field', {
    kind: 'OBJECT',
    fields: {
      name: typeField('String!', (s) => s.name),
      description: typeField('String', () => null),
      args: typeField('[__InputValue!]!', (s) =>
        Object.entries(s.def.args ?? {}).map(([n, t]) => ({ __type: '__InputValue', name: n, typeRef: t })),
      ),
      type: typeField('__Type!', (s) => ({ __type: '__TypeRef', ref: s.def.type })),
      isDeprecated: typeField('Boolean!', () => false),
      deprecationReason: typeField('String', () => null),
    },
  });
  defType('__EnumValue', {
    kind: 'OBJECT',
    fields: {
      name: typeField('String!', (s) => s.name),
      description: typeField('String', () => null),
      isDeprecated: typeField('Boolean!', () => false),
      deprecationReason: typeField('String', () => null),
    },
  });
  defType('__InputValue', {
    kind: 'OBJECT',
    fields: {
      name: typeField('String!', (s) => s.name),
      description: typeField('String', () => null),
      type: typeField('__Type!', (s) => ({ __type: '__TypeRef', ref: s.typeRef })),
      defaultValue: typeField('String', () => null),
      isDeprecated: typeField('Boolean!', () => false),
      deprecationReason: typeField('String', () => null),
    },
  });
  defType('__TypeRef', {
    kind: 'OBJECT',
    fields: {
      name: typeField('String', (s) => parseTypeRefStr(s.ref).name),
      kind: typeField('String!', (s) => parseTypeRefStr(s.ref).kind),
      ofType: typeField('__Type', (s) => {
        const parsed = parseTypeRefStr(s.ref);
        const of = parsed.ofType as Record<string, unknown> | null;
        if (of === null) return null;
        if (typeof of.name === 'string') return typeValue(of.name);
        return { __type: '__TypeRef', ref: typeRefToString(of) };
      }),
    },
  });
  defType('__Schema', {
    kind: 'OBJECT',
    fields: {
      types: typeField('[__Type!]!', () => [...SCHEMA.keys()].map((n) => typeValue(n))),
      queryType: typeField('__Type!', () => typeValue('Query')),
      mutationType: typeField('__Type', () => typeValue('Mutation')),
      subscriptionType: typeField('__Type', () => null),
      directives: typeField('[__Directive!]!', () => []),
      description: typeField('String', () => null),
    },
  });
}

function typeRefToString(ref: Record<string, unknown>): string {
  if (ref.kind === 'NON_NULL') return `${typeRefToString(ref.ofType as Record<string, unknown>)}!`;
  if (ref.kind === 'LIST') return `[${typeRefToString(ref.ofType as Record<string, unknown>)}]`;
  return String(ref.name);
}

// ---------------------------------------------------------------------------
// The forge schema
// ---------------------------------------------------------------------------

type Wrapped<T> = { __type: string; value: T };
const wrap = <T>(type: string, value: T): Wrapped<T> => ({ __type: type, value });

function f(type: string, resolve: Resolver, args?: Record<string, string>): FieldDef {
  return { type, args, resolve };
}

function userFields(): Record<string, FieldDef> {
  return {
    id: f('ID!', (s: Wrapped<User>) => globalId('User', s.value.id)),
    databaseId: f('Int', (s: Wrapped<User>) => s.value.id),
    login: f('String!', (s: Wrapped<User>) => s.value.login),
    name: f('String', (s: Wrapped<User>) => s.value.name),
    email: f('String', (s: Wrapped<User>) => s.value.email),
    avatarUrl: f('URI!', () => 'https://forge.invalid/avatar'),
    url: f('URI!', (s: Wrapped<User>) => `/${s.value.login}`),
    isViewer: f('Boolean!', (s: Wrapped<User>) => s.value.login === VIEWER.login),
  };
}

function buildSchema(): void {
  introspectionTypes();

  defType('OrderDirection', { kind: 'ENUM', enumValues: ['ASC', 'DESC'] });
  defType('IssueOrderField', { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] });
  defType('PullRequestOrderField', { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT'] });
  defType('IssueState', { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] });
  defType('PullRequestState', { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] });
  defType('MergeableState', { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] });
  defType('SearchType', { kind: 'ENUM', enumValues: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'] });
  defType('RepositoryPermission', { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] });
  defType('MergeMethod', { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] });
  defType('FileChangeType', { kind: 'ENUM', enumValues: ['ADDED', 'REMOVED', 'MODIFIED', 'RENAMED', 'COPIED'] });
  defType('IssueOrder', { kind: 'INPUT_OBJECT', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } });
  defType('PullRequestOrder', { kind: 'INPUT_OBJECT', inputFields: { field: 'PullRequestOrderField!', direction: 'OrderDirection!' } });

  defType('User', { kind: 'OBJECT', fields: userFields() });
  defType('Organization', { kind: 'OBJECT', fields: userFields() });
  defType('PageInfo', {
    kind: 'OBJECT',
    fields: {
      hasNextPage: f('Boolean!', (s) => s.hasNextPage),
      hasPreviousPage: f('Boolean!', (s) => s.hasPreviousPage),
      startCursor: f('String', (s) => s.startCursor),
      endCursor: f('String', (s) => s.endCursor),
    },
  });
  defType('Label', {
    kind: 'OBJECT',
    fields: {
      id: f('ID!', (s) => globalId('Label', s.value.id)),
      name: f('String!', (s) => s.value.name),
      color: f('String!', (s) => s.value.color),
      description: f('String', (s) => s.value.description),
    },
  });
  const connFields = (nodeType: string): Record<string, FieldDef> => ({
    nodes: f(`[${nodeType}]`, (s: Conn<unknown>) => s.nodes),
    edges: f('[Edge]', (s: Conn<unknown>) => s.edges),
    pageInfo: f('PageInfo!', (s: Conn<unknown>) => s.pageInfo),
    totalCount: f('Int!', (s: Conn<unknown>) => s.totalCount),
  });
  defType('Edge', {
    kind: 'OBJECT',
    fields: {
      cursor: f('String!', (s) => s.cursor),
      node: f('Node', (s) => s.node),
    },
  });
  defType('Node', { kind: 'INTERFACE', fields: { id: f('ID!', () => null) } });

  defType('Ref', {
    kind: 'OBJECT',
    fields: {
      id: f('ID!', (s) => globalId('Ref', s.repo.id * 1000 + s.name.length)),
      name: f('String!', (s) => s.name),
      prefix: f('String!', () => 'refs/heads/'),
      target: f('GitObject', (s) => wrap('Commit', { sha: s.sha, repo: s.repo })),
    },
  });
  defType('Commit', {
    kind: 'OBJECT',
    fields: {
      id: f('ID!', (s) => globalId('Commit', parseInt(s.value.sha.slice(0, 8), 16))),
      oid: f('GitObjectID!', (s) => s.value.sha),
      abbreviatedOid: f('String!', (s) => s.value.sha.slice(0, 7)),
      message: f('String!', (s, _a, ctx) => ctx.forge.store.get(s.value.sha)?.data.toString('utf8') ?? ''),
      committedDate: f('DateTime!', () => Forge.clock.iso()),
      treeOid: f('GitObjectID!', (s, _a, ctx) => {
        const obj = ctx.forge.store.get(s.value.sha);
        const m = obj !== undefined ? /^tree ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8')) : null;
        return m !== null ? m[1] : '';
      }),
    },
  });
  defType('GitObject', { kind: 'INTERFACE', fields: { id: f('ID!', () => null), oid: f('GitObjectID!', () => '') } });

  defType('IssueComment', {
    kind: 'OBJECT',
    fields: {
      id: f('ID!', (s) => globalId('IssueComment', s.value.id)),
      databaseId: f('Int', (s) => s.value.id),
      body: f('String!', (s) => s.value.body),
      author: f('User', (s) => wrap('User', s.value.user)),
      createdAt: f('DateTime!', (s) => s.value.created_at),
      updatedAt: f('DateTime!', (s) => s.value.updated_at),
      url: f('URI!', (s) => `/issues#comment-${s.value.id}`),
    },
  });
  defType('IssueCommentConnection', { kind: 'OBJECT', fields: connFields('IssueComment') });
  defType('IssueCommentEdge', {
    kind: 'OBJECT',
    fields: { cursor: f('String!', (s) => s.cursor), node: f('IssueComment', (s) => s.node) },
  });
  defType('LabelConnection', { kind: 'OBJECT', fields: connFields('Label') });

  const issueState = (i: Issue): string => i.state.toUpperCase();
  defType('Issue', {
    kind: 'OBJECT',
    fields: {
      id: f('ID!', (s) => globalId('Issue', s.value.id)),
      databaseId: f('Int', (s) => s.value.id),
      number: f('Int!', (s) => s.value.number),
      title: f('String!', (s) => s.value.title),
      body: f('String', (s) => s.value.body),
      bodyText: f('String', (s) => s.value.body ?? ''),
      state: f('IssueState!', (s) => issueState(s.value)),
      author: f('User', (s) => wrap('User', s.value.user)),
      editor: f('User', (s) => wrap('User', s.value.user)),
      repository: f('Repository!', (s) => wrap('Repository', s.repo)),
      labels: f('LabelConnection', (s, args) => connect(
        s.value.labels.map((name: string) => wrap('Label', s.repo.labels.get(name) ?? { id: 0, name, color: 'ededed', description: null })),
        args,
      ), { first: 'Int', after: 'String' }),
      comments: f('IssueCommentConnection', (s, args) => connect(
        s.value.comments.map((c: unknown) => wrap('IssueComment', c)),
        args,
      ), { first: 'Int', after: 'String' }),
      createdAt: f('DateTime!', (s) => s.value.created_at),
      updatedAt: f('DateTime!', (s) => s.value.updated_at),
      closedAt: f('DateTime', (s) => s.value.closed_at),
      url: f('URI!', (s) => `/${s.repo.owner.login}/${s.repo.name}/issues/${s.value.number}`),
      viewerCanUpdate: f('Boolean!', () => true),
    },
  });
  defType('IssueConnection', { kind: 'OBJECT', fields: connFields('Issue') });
  defType('IssueEdge', { kind: 'OBJECT', fields: { cursor: f('String!', (s) => s.cursor), node: f('Issue', (s) => s.node) } });

  defType('PullRequestChangedFile', {
    kind: 'OBJECT',
    fields: {
      path: f('String!', (s) => s.value.filename),
      additions: f('Int!', (s) => s.value.additions),
      deletions: f('Int!', (s) => s.value.deletions),
      changeType: f('FileChangeType!', (s) => s.value.status.toUpperCase()),
    },
  });
  defType('PullRequestChangedFileConnection', { kind: 'OBJECT', fields: connFields('PullRequestChangedFile') });

  const pullState = (p: Pull): string => (p.merged ? 'MERGED' : p.state.toUpperCase());
  defType('PullRequest', {
    kind: 'OBJECT',
    fields: {
      id: f('ID!', (s) => globalId('PullRequest', s.value.id)),
      databaseId: f('Int', (s) => s.value.id),
      number: f('Int!', (s) => s.value.number),
      title: f('String!', (s) => s.value.title),
      body: f('String', (s) => s.value.body),
      state: f('PullRequestState!', (s) => pullState(s.value)),
      merged: f('Boolean!', (s) => s.value.merged),
      mergedAt: f('DateTime', (s) => s.value.merged_at),
      mergeable: f('MergeableState!', (s, _a, ctx) => {
        if (s.value.state !== 'open') return 'UNKNOWN';
        return mergeConflicts({ forge: ctx.forge } as never, s.repo, s.value) ? 'CONFLICTING' : 'MERGEABLE';
      }),
      headRefName: f('String!', (s) => s.value.headRef),
      baseRefName: f('String!', (s) => s.value.baseRef),
      headRefOid: f('GitObjectID!', (s, _a, ctx) => ctx.forge.branchTip(s.repo, s.value.headRef) ?? s.value.headSha),
      baseRefOid: f('GitObjectID!', (s, _a, ctx) => ctx.forge.branchTip(s.repo, s.value.baseRef) ?? s.value.baseSha),
      author: f('User', (s) => wrap('User', s.value.user)),
      repository: f('Repository!', (s) => wrap('Repository', s.repo)),
      files: f('PullRequestChangedFileConnection', (s, args, ctx) => {
        const baseTree = ctx.forge.tipTree(s.repo, s.value.baseRef);
        const headTree = ctx.forge.tipTree(s.repo, s.value.headRef);
        const files = diffTrees({ forge: ctx.forge } as never, baseTree, headTree);
        return connect(files.map((file) => ({ __type: 'PullRequestChangedFile', value: file })), args);
      }, { first: 'Int', after: 'String' }),
      mergeCommit: f('Commit', (s) => (s.value.merge_commit_sha !== null ? wrap('Commit', { sha: s.value.merge_commit_sha, repo: s.repo }) : null)),
      createdAt: f('DateTime!', (s) => s.value.created_at),
      updatedAt: f('DateTime!', (s) => s.value.updated_at),
      closedAt: f('DateTime', (s) => (s.value.state === 'closed' ? s.value.updated_at : null)),
      url: f('URI!', (s) => `/${s.repo.owner.login}/${s.repo.name}/pull/${s.value.number}`),
      viewerCanUpdate: f('Boolean!', () => true),
    },
  });
  defType('PullRequestConnection', { kind: 'OBJECT', fields: connFields('PullRequest') });
  defType('PullRequestEdge', { kind: 'OBJECT', fields: { cursor: f('String!', (s) => s.cursor), node: f('PullRequest', (s) => s.node) } });

  defType('Repository', {
    kind: 'OBJECT',
    fields: {
      id: f('ID!', (s: Wrapped<Repo>) => globalId('Repository', s.value.id)),
      databaseId: f('Int!', (s: Wrapped<Repo>) => s.value.id),
      name: f('String!', (s: Wrapped<Repo>) => s.value.name),
      nameWithOwner: f('String!', (s: Wrapped<Repo>) => `${s.value.owner.login}/${s.value.name}`),
      description: f('String', (s: Wrapped<Repo>) => s.value.description),
      isPrivate: f('Boolean!', (s: Wrapped<Repo>) => s.value.private),
      visibility: f('String!', (s: Wrapped<Repo>) => (s.value.private ? 'PRIVATE' : 'PUBLIC')),
      owner: f('User!', (s: Wrapped<Repo>) => wrap(s.value.owner.type === 'Organization' ? 'Organization' : 'User', s.value.owner)),
      viewerPermission: f('RepositoryPermission', () => 'ADMIN'),
      hasIssuesEnabled: f('Boolean!', () => true),
      hasProjectsEnabled: f('Boolean!', () => true),
      hasWikiEnabled: f('Boolean!', () => true),
      defaultBranchRef: f('Ref', (s: Wrapped<Repo>, _a, ctx) => {
        const sha = ctx.forge.branchTip(s.value, s.value.default_branch);
        return sha === undefined ? null : { __type: 'Ref', name: s.value.default_branch, sha, repo: s.value };
      }),
      createdAt: f('DateTime!', (s: Wrapped<Repo>) => s.value.created_at),
      updatedAt: f('DateTime!', (s: Wrapped<Repo>) => s.value.updated_at),
      pushedAt: f('DateTime', (s: Wrapped<Repo>) => s.value.pushed_at),
      url: f('URI!', (s: Wrapped<Repo>) => `/${s.value.owner.login}/${s.value.name}`),
      sshUrl: f('String!', (s: Wrapped<Repo>) => `git@forge.invalid:${s.value.owner.login}/${s.value.name}.git`),
      isFork: f('Boolean!', () => false),
      isArchived: f('Boolean!', () => false),
      stargazerCount: f('Int!', () => 0),
      forkCount: f('Int!', () => 0),
      issue: f('Issue', (s: Wrapped<Repo>, args) => {
        const issue = s.value.issues.get(Number(args.number));
        return issue !== undefined && issue.pull_request === undefined ? { __type: 'Issue', value: issue, repo: s.value } : null;
      }, { number: 'Int!' }),
      issues: f('IssueConnection!', (s: Wrapped<Repo>, args) => {
        let items = [...s.value.issues.values()].filter((i) => i.pull_request === undefined);
        const states = args.states as string[] | undefined;
        if (states !== undefined) items = items.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? { field: 'CREATED_AT', direction: 'DESC' };
        const dir = orderBy.direction === 'ASC' ? 1 : -1;
        items.sort((a, b) => {
          const ka = orderBy.field === 'UPDATED_AT' ? a.updated_at : a.created_at;
          const kb = orderBy.field === 'UPDATED_AT' ? b.updated_at : b.created_at;
          if (ka !== kb) return (ka < kb ? -1 : 1) * dir;
          return (a.number - b.number) * dir;
        });
        const labels = args.labels as string[] | undefined;
        if (labels !== undefined) items = items.filter((i) => labels.every((l) => i.labels.includes(l)));
        return connect(items.map((i) => ({ __type: 'Issue', value: i, repo: s.value })), args);
      }, { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]' }),
      pullRequest: f('PullRequest', (s: Wrapped<Repo>, args) => {
        const pull = s.value.pulls.get(Number(args.number));
        return pull !== undefined ? { __type: 'PullRequest', value: pull, repo: s.value } : null;
      }, { number: 'Int!' }),
      pullRequests: f('PullRequestConnection!', (s: Wrapped<Repo>, args) => {
        let items = [...s.value.pulls.values()];
        const states = args.states as string[] | undefined;
        if (states !== undefined) items = items.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
        items.sort((a, b) => b.number - a.number);
        return connect(items.map((p) => ({ __type: 'PullRequest', value: p, repo: s.value })), args);
      }, { first: 'Int', after: 'String', states: '[PullRequestState!]', orderBy: 'PullRequestOrder' }),
      labels: f('LabelConnection', (s: Wrapped<Repo>, args) => connect(
        [...s.value.labels.values()].map((l) => wrap('Label', l)),
        args,
      ), { first: 'Int', after: 'String' }),
    },
  });

  defType('SearchResultItemConnection', {
    kind: 'OBJECT',
    fields: {
      issueCount: f('Int!', () => 0),
      userCount: f('Int!', () => 0),
      repositoryCount: f('Int!', () => 0),
      nodes: f('[Node]', () => []),
      edges: f('[Edge]', () => []),
      pageInfo: f('PageInfo!', () => ({ hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null })),
    },
  });

  defType('Query', {
    kind: 'OBJECT',
    fields: {
      viewer: f('User!', () => wrap('User', VIEWER)),
      repository: f('Repository', (_s, args, ctx) => {
        const repo = ctx.forge.repo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo !== undefined ? wrap('Repository', repo) : null;
      }, { owner: 'String!', name: 'String!' }),
      node: f('Node', (_s, args, ctx) => nodeById(ctx.forge, String(args.id ?? ''))),
      nodes: f('[Node]!', (_s, args, ctx) => ((args.ids as string[]) ?? []).map((id) => nodeById(ctx.forge, id))),
      search: f('SearchResultItemConnection!', () => ({ __type: 'SearchResultItemConnection' }), { query: 'String!', type: 'SearchType!', first: 'Int', after: 'String' }),
      rateLimit: f('RateLimit', () => ({ __type: 'RateLimit' })),
      user: f('User', (_s, args) => {
        const u = [VIEWER].find((x) => x.login === String(args.login ?? ''));
        return u !== undefined ? wrap('User', u) : null;
      }, { login: 'String!' }),
    },
  });
  defType('RateLimit', {
    kind: 'OBJECT',
    fields: {
      limit: f('Int!', () => 5000),
      cost: f('Int!', () => 1),
      remaining: f('Int!', () => 4999),
      used: f('Int!', () => 1),
      resetAt: f('DateTime!', () => Forge.clock.iso()),
      nodeCount: f('Int!', () => 0),
    },
  });

  // Mutations ----------------------------------------------------------------
  defType('CreateIssueInput', { kind: 'INPUT_OBJECT', inputFields: { clientMutationId: 'String', repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]' } });
  defType('CreateIssuePayload', { kind: 'OBJECT', fields: { clientMutationId: f('String', (s) => s.input?.clientMutationId ?? null), issue: f('Issue', (s) => s.issue) } });
  defType('CloseIssueInput', { kind: 'INPUT_OBJECT', inputFields: { clientMutationId: 'String', issueId: 'ID!' } });
  defType('CloseIssuePayload', { kind: 'OBJECT', fields: { clientMutationId: f('String', (s) => s.input?.clientMutationId ?? null), issue: f('Issue', (s) => s.issue) } });
  defType('ReopenIssueInput', { kind: 'INPUT_OBJECT', inputFields: { clientMutationId: 'String', issueId: 'ID!' } });
  defType('ReopenIssuePayload', { kind: 'OBJECT', fields: { clientMutationId: f('String', (s) => s.input?.clientMutationId ?? null), issue: f('Issue', (s) => s.issue) } });
  defType('CreatePullRequestInput', { kind: 'INPUT_OBJECT', inputFields: { clientMutationId: 'String', repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean' } });
  defType('CreatePullRequestPayload', { kind: 'OBJECT', fields: { clientMutationId: f('String', (s) => s.input?.clientMutationId ?? null), pullRequest: f('PullRequest', (s) => s.pullRequest) } });
  defType('MergePullRequestInput', { kind: 'INPUT_OBJECT', inputFields: { clientMutationId: 'String', pullRequestId: 'ID!', mergeMethod: 'MergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID' } });
  defType('MergePullRequestPayload', { kind: 'OBJECT', fields: { clientMutationId: f('String', (s) => s.input?.clientMutationId ?? null), pullRequest: f('PullRequest', (s) => s.pullRequest) } });
  defType('AddCommentInput', { kind: 'INPUT_OBJECT', inputFields: { clientMutationId: 'String', subjectId: 'ID!', body: 'String!' } });
  defType('AddCommentPayload', {
    kind: 'OBJECT',
    fields: {
      clientMutationId: f('String', (s) => s.input?.clientMutationId ?? null),
      commentEdge: f('IssueCommentEdge!', (s) => ({ cursor: cursorOf(0), node: s.comment })),
      subject: f('Node', (s) => s.subject),
    },
  });

  defType('Mutation', {
    kind: 'OBJECT',
    fields: {
      createIssue: f('CreateIssuePayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
        if (repo === undefined) throw new Error('repository not found');
        const labelNames: string[] = [];
        for (const lid of (input.labelIds as string[] | undefined) ?? []) {
          const parsed = parseGlobalId(lid);
          const label = parsed !== null ? [...repo.labels.values()].find((l) => l.id === parsed.dbId) : undefined;
          if (label !== undefined) labelNames.push(label.name);
        }
        const now = Forge.clock.iso();
        const issue: Issue = {
          id: ctx.forge.nextIssueId(),
          number: repo.nextNumber,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : null,
          state: 'open',
          labels: labelNames,
          user: VIEWER,
          assignees: [],
          comments: [],
          created_at: now,
          updated_at: now,
          closed_at: null,
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return { __type: 'CreateIssuePayload', input, issue: { __type: 'Issue', value: issue, repo } };
      }, { input: 'CreateIssueInput!' }),
      closeIssue: f('CloseIssuePayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx.forge, String(input.issueId ?? ''));
        if (found === undefined) throw new Error('issue not found');
        found.issue.state = 'closed';
        found.issue.closed_at = Forge.clock.iso();
        found.issue.updated_at = found.issue.closed_at;
        return { __type: 'CloseIssuePayload', input, issue: { __type: 'Issue', value: found.issue, repo: found.repo } };
      }, { input: 'CloseIssueInput!' }),
      reopenIssue: f('ReopenIssuePayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx.forge, String(input.issueId ?? ''));
        if (found === undefined) throw new Error('issue not found');
        found.issue.state = 'open';
        found.issue.closed_at = null;
        found.issue.updated_at = Forge.clock.iso();
        return { __type: 'ReopenIssuePayload', input, issue: { __type: 'Issue', value: found.issue, repo: found.repo } };
      }, { input: 'ReopenIssueInput!' }),
      createPullRequest: f('CreatePullRequestPayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
        if (repo === undefined) throw new Error('repository not found');
        const headRef = String(input.headRefName ?? '').replace(/^refs\/heads\//, '');
        const baseRef = String(input.baseRefName ?? '').replace(/^refs\/heads\//, '');
        const headSha = ctx.forge.branchTip(repo, headRef);
        const baseSha = ctx.forge.branchTip(repo, baseRef);
        if (headSha === undefined) throw new Error(`head ref ${headRef} does not exist`);
        if (baseSha === undefined) throw new Error(`base ref ${baseRef} does not exist`);
        const now = Forge.clock.iso();
        const pull: Pull = {
          id: ctx.forge.nextIssueId(),
          number: repo.nextNumber,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : null,
          state: 'open',
          headRef,
          headSha,
          baseRef,
          baseSha,
          user: VIEWER,
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          created_at: now,
          updated_at: now,
          draft: input.draft === true,
        };
        repo.nextNumber += 1;
        repo.pulls.set(pull.number, pull);
        repo.issues.set(pull.number, {
          id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: 'open',
          labels: [], user: VIEWER, assignees: [], comments: [], created_at: now, updated_at: now,
          closed_at: null, pull_request: { url: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${pull.number}` },
        });
        return { __type: 'CreatePullRequestPayload', input, pullRequest: { __type: 'PullRequest', value: pull, repo } };
      }, { input: 'CreatePullRequestInput!' }),
      mergePullRequest: f('MergePullRequestPayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullByGlobalId(ctx.forge, String(input.pullRequestId ?? ''));
        if (found === undefined) throw new Error('pull request not found');
        const { repo, pull } = found;
        if (pull.state !== 'open' || pull.merged) throw new Error('pull request is not open');
        // Delegate to the REST merge by simulating its context pieces.
        const restCtx = { forge: ctx.forge } as never;
        if (mergeConflicts(restCtx, repo, pull)) throw new Error('pull request has conflicts');
        const tree = mergedTreeViaRest(ctx, repo, pull);
        const sha = commitSquash(ctx, repo, pull, tree, input);
        pull.merged = true;
        pull.state = 'closed';
        pull.merged_at = Forge.clock.iso();
        pull.merge_commit_sha = sha;
        pull.updated_at = pull.merged_at;
        const shadow = repo.issues.get(pull.number);
        if (shadow !== undefined) {
          shadow.state = 'closed';
          shadow.closed_at = pull.merged_at;
        }
        return { __type: 'MergePullRequestPayload', input, pullRequest: { __type: 'PullRequest', value: pull, repo } };
      }, { input: 'MergePullRequestInput!' }),
      addComment: f('AddCommentPayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx.forge, String(input.subjectId ?? '')) ?? pullAsIssue(ctx.forge, String(input.subjectId ?? ''));
        if (found === undefined) throw new Error('subject not found');
        const now = Forge.clock.iso();
        const comment = { id: ctx.forge.nextCommentId(), body: String(input.body ?? ''), user: VIEWER, created_at: now, updated_at: now };
        found.issue.comments.push(comment);
        found.issue.updated_at = now;
        return {
          __type: 'AddCommentPayload',
          input,
          comment: wrap('IssueComment', comment),
          subject: { __type: 'Issue', value: found.issue, repo: found.repo },
        };
      }, { input: 'AddCommentInput!' }),
    },
  });
}

function repoByGlobalId(forge: Forge, id: string): Repo | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return undefined;
  return [...forge.repos.values()].find((r) => r.id === parsed.dbId);
}
function issueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return undefined;
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === parsed.dbId && issue.pull_request === undefined) return { repo, issue };
    }
  }
  return undefined;
}
function pullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return undefined;
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === parsed.dbId) return { repo, pull };
    }
  }
  return undefined;
}
function pullAsIssue(forge: Forge, id: string): { repo: Repo; issue: Issue } | undefined {
  const found = pullByGlobalId(forge, id);
  if (found === undefined) return undefined;
  const shadow = found.repo.issues.get(found.pull.number);
  return shadow !== undefined ? { repo: found.repo, issue: shadow } : undefined;
}

function nodeById(forge: Forge, id: string): unknown {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = [...forge.repos.values()].find((r) => r.id === parsed.dbId);
    return repo !== undefined ? wrap('Repository', repo) : null;
  }
  if (parsed.type === 'Issue') {
    const found = issueByGlobalId(forge, id);
    return found !== undefined ? { __type: 'Issue', value: found.issue, repo: found.repo } : null;
  }
  if (parsed.type === 'PullRequest') {
    const found = pullByGlobalId(forge, id);
    return found !== undefined ? { __type: 'PullRequest', value: found.pull, repo: found.repo } : null;
  }
  if (parsed.type === 'User') {
    return parsed.dbId === VIEWER.id ? wrap('User', VIEWER) : null;
  }
  return null;
}

// The squash merge reuses the REST module's tree machinery through its exported helpers.
import { buildTree, flattenTree, makeCommit, parseCommit, walkCommits } from './gitobj.ts';
import { forgeAuthor } from './forge.ts';

function mergedTreeViaRest(ctx: ExecCtx, repo: Repo, pull: Pull): string {
  const store = ctx.forge.store;
  const baseTip = ctx.forge.branchTip(repo, pull.baseRef)!;
  const headTree = ctx.forge.tipTree(repo, pull.headRef);
  void headTree;
  const files = new Map<string, string>();
  for (const [path, e] of flattenTree(store, parseCommit(store.get(baseTip)!.data).tree)) files.set(path, e.sha);
  const mb = mergeBaseSha(ctx, repo, pull);
  const mbTree = mb !== null ? parseCommit(store.get(mb)!.data).tree : null;
  for (const change of diffTrees({ forge: ctx.forge } as never, mbTree, ctx.forge.tipTree(repo, pull.headRef))) {
    if (change.status === 'removed') files.delete(change.filename);
    else if (change.after !== undefined) files.set(change.filename, change.after);
  }
  return buildTree(store, files);
}

function mergeBaseSha(ctx: ExecCtx, repo: Repo, pull: Pull): string | null {
  const store = ctx.forge.store;
  const a = ctx.forge.branchTip(repo, pull.baseRef);
  const b = ctx.forge.branchTip(repo, pull.headRef);
  if (a === undefined || b === undefined) return null;
  const ancestors = new Set(walkCommits(store, a));
  for (const c of walkCommits(store, b)) if (ancestors.has(c)) return c;
  return null;
}


function commitSquash(ctx: ExecCtx, repo: Repo, pull: Pull, tree: string, input: Record<string, unknown>): string {
  const parent = ctx.forge.branchTip(repo, pull.baseRef);
  const headline = typeof input.commitHeadline === 'string' ? input.commitHeadline : `${pull.title} (#${pull.number})`;
  const body = typeof input.commitBody === 'string' ? input.commitBody : (pull.body ?? '');
  const sha = makeCommit(ctx.forge.store, {
    tree,
    parents: parent !== undefined ? [parent] : [],
    author: forgeAuthor(),
    committer: forgeAuthor(),
    message: `${headline}\n\n${body}`.trimEnd() + '\n',
  });
  ctx.forge.setBranch(repo, pull.baseRef, sha);
  repo.pushed_at = Forge.clock.iso();
  return sha;
}

buildSchema();

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function runOperation(forge: Forge, body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let doc: Document;
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const op = doc.operations.find((o) => operationName === undefined || o.name === operationName) ?? doc.operations[0];
  if (op === undefined) return { errors: [{ message: 'no operation in document' }] };
  const vars: Record<string, unknown> = { ...variables };
  const varCtx: ExecCtx = { forge, vars, doc, errors: [] };
  for (const [name, def] of Object.entries(op.varDefs)) {
    if (vars[name] === undefined && def !== undefined) vars[name] = coerce(def, varCtx);
  }
  const ctx: ExecCtx = { forge, vars, doc, errors: [] };
  const rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(null, rootType, op.selection, ctx);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export async function handleGraphql(ctx: Ctx): Promise<Reply> {
  if (ctx.method !== 'POST') return { status: 200, body: { errors: [{ message: 'GraphQL only answers POST' }] } };
  const raw = ctx.body as Record<string, unknown> | null;
  if (raw !== null && Array.isArray((raw as { __array?: unknown }).__array)) {
    const items = (raw as { __array: Record<string, unknown>[] }).__array;
    return { status: 200, body: items.map((item) => runOperation(ctx.forge, item)) };
  }
  if (raw === null) return { status: 200, body: { errors: [{ message: 'missing body' }] } };
  return { status: 200, body: runOperation(ctx.forge, raw) };
}
