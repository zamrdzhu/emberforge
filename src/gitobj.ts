// The git object model, in memory: blobs, trees, commits and tags addressed by their SHA-1,
// serialised and parsed in git's own formats. Nothing here touches a disk or a git binary;
// zlib and SHA-1 come from the Node standard library.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id an object gets: sha1 of "<type> <length>\0" followed by the raw bytes. */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** The object store: one map for the whole forge, objects shared across repositories. */
export class Store {
  objects = new Map<string, GitObject>();

  put(type: ObjType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  putExisting(sha: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  /** Store a blob of file bytes; returns its sha. */
  blob(bytes: Buffer): string {
    return this.put('blob', bytes);
  }

  /** Read a blob's bytes, or undefined when the sha is not a blob here. */
  blobBytes(sha: string): Buffer | undefined {
    const obj = this.objects.get(sha);
    return obj !== undefined && obj.type === 'blob' ? obj.data : undefined;
  }
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // e.g. '100644', '100755', '40000' (git writes trees without the leading 0)
  name: string;
  sha: string; // hex
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.subarray(at, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories sorting as if their name ended in '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' || e.mode === '040000' ? `${e.name}/` : e.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function makeTree(store: Store, entries: TreeEntry[]): string {
  return store.put('tree', serializeTree(entries));
}

/** Every file under a tree, flattened to path -> entry. */
export function flattenTree(store: Store, treeSha: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000' || e.mode === '040000') flattenTree(store, e.sha, `${prefix}${e.name}/`, out);
    else out.set(`${prefix}${e.name}`, e);
  }
  return out;
}

/** Build nested trees from a flat path -> blob sha map; returns the root tree sha. */
export function buildTree(store: Store, files: Map<string, string>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, string>;
  }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: new Map() });
      node = node.dirs.get(dir)!;
    }
    node.files.set(parts[parts.length - 1]!, sha);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: write(sub) });
    return makeTree(store, entries);
  };
  return write(root);
}

/** Set (or, with blobSha null, remove) one path in a tree; returns the new root tree sha. */
export function updateTree(store: Store, treeSha: string | null, parts: string[], blobSha: string | null, mode = '100644'): string {
  const entries: TreeEntry[] = treeSha !== null && store.get(treeSha)?.type === 'tree' ? parseTree(store.get(treeSha)!.data) : [];
  const [head, ...rest] = parts as [string, ...string[]];
  const at = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobSha === null) {
      if (at >= 0) entries.splice(at, 1);
    } else if (at >= 0) entries[at] = { mode, name: head, sha: blobSha };
    else entries.push({ mode, name: head, sha: blobSha });
  } else {
    const sub = at >= 0 && (entries[at]!.mode === '40000' || entries[at]!.mode === '040000') ? entries[at]!.sha : null;
    const newSub = updateTree(store, sub, rest, blobSha, mode);
    const subObj = store.get(newSub);
    const empty = subObj !== undefined && subObj.type === 'tree' && parseTree(subObj.data).length === 0;
    if (empty) {
      if (at >= 0) entries.splice(at, 1);
    } else if (at >= 0) entries[at] = { mode: '40000', name: head, sha: newSub };
    else entries.push({ mode: '40000', name: head, sha: newSub });
  }
  return makeTree(store, entries);
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface Commit {
  tree: string;
  parents: string[];
  author: string; // the full "Name <email> ts tz" line value
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const commit: Commit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export function serializeCommit(c: Commit): Buffer {
  let head = `tree ${c.tree}\n`;
  for (const p of c.parents) head += `parent ${p}\n`;
  head += `author ${c.author}\ncommitter ${c.committer}\n`;
  return Buffer.from(`${head}\n${c.message}`, 'utf8');
}

export function makeCommit(store: Store, c: Commit): string {
  return store.put('commit', serializeCommit(c));
}

/** Every commit reachable from a tip, newest first (walk by parent links). */
export function walkCommits(store: Store, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(sha);
    order.push(sha);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return order;
}

/** Is `ancestor` reachable from `descendant`? The fast-forward test. */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** The full object closure a clone of `tips` needs, honouring `haves` and shallow cuts. */
export function closure(store: Store, tips: string[], haves: Set<string>, shallowAt = new Set<string>()): Set<string> {
  const out = new Set<string>();
  const haveCommits = new Set<string>();
  for (const h of haves) {
    for (const c of walkCommits(store, h)) haveCommits.add(c);
  }
  const visitTree = (treeSha: string): void => {
    if (out.has(treeSha) || haveCommits.has(treeSha)) return;
    const obj = store.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return;
    out.add(treeSha);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000' || e.mode === '040000') visitTree(e.sha);
      else out.add(e.sha);
    }
  };
  const queue = [...tips];
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seenCommits.has(sha) || haveCommits.has(sha)) continue;
    seenCommits.add(sha);
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.add(sha);
    const commit = parseCommit(obj.data);
    visitTree(commit.tree);
    if (shallowAt.has(sha)) continue; // a shallow boundary: its parents stay home
    for (const p of commit.parents) queue.push(p);
  }
  return out;
}

export { deflateSync, inflateSync };
