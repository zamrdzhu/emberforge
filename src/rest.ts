// The REST v3 surface: repositories, branches, commits, contents, labels, issues, comments
// and pull requests, with GitHub's status codes and JSON shapes. Handlers work on the Forge
// store; every error is a JSON {"message": ...} body, never HTML.
import {
  Forge, VIEWER, userByLogin, userJson, repoJson, labelJson, issueJson, pullJson, commentJson, forgeAuthor,
  type Repo, type Issue, type Pull,
} from './forge.ts';
import { buildTree, flattenTree, makeCommit, parseCommit, updateTree, walkCommits } from './gitobj.ts';

export interface Ctx {
  forge: Forge;
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  rawBody: Buffer;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: Buffer;
  contentType?: string;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({ status, body, headers });
const fail = (status: number, message: string): Reply => json(status, { message });

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function paginate<T>(ctx: Ctx, items: T[]): Reply {
  const perPage = Math.min(100, Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const base = ctx.path;
    const next = new URLSearchParams(ctx.query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const last = new URLSearchParams(ctx.query);
    last.set('page', String(Math.ceil(items.length / perPage)));
    last.set('per_page', String(perPage));
    headers.link = `<${base}?${next.toString()}>; rel="next", <${base}?${last.toString()}>; rel="last"`;
  }
  return json(200, slice, headers);
}

// ---------------------------------------------------------------------------
// Contents helpers
// ---------------------------------------------------------------------------

interface CommitResult {
  sha: string;
}

/** Commit a new tree onto a branch (or start the branch), returning the commit sha. */
function commitOnto(ctx: Ctx, repo: Repo, branch: string, treeSha: string, message: string): CommitResult {
  const parent = repo.refs.get(branch);
  const commit = makeCommit(ctx.forge.store, {
    tree: treeSha,
    parents: parent !== undefined ? [parent] : [],
    author: forgeAuthor(),
    committer: forgeAuthor(),
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  repo.refs.set(branch, commit);
  repo.pushed_at = Forge.clock.iso();
  repo.updated_at = repo.pushed_at;
  return { sha: commit };
}

function contentsPut(ctx: Ctx, repo: Repo): Reply {
  const body = ctx.body ?? {};
  const path = ctx.path.split('/contents/')[1] ?? '';
  const decodedPath = decodeURIComponent(path);
  const message = str(body.message) ?? 'Update file';
  const contentB64 = str(body.content);
  if (contentB64 === undefined) return fail(422, 'content is required');
  const branch = str(body.branch) ?? repo.default_branch;
  const bytes = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
  const store = ctx.forge.store;
  const tipTree = ctx.forge.tipTree(repo, branch);
  const existing = tipTree !== null ? flattenTree(store, tipTree).get(decodedPath) : undefined;
  const givenSha = str(body.sha);
  if (existing !== undefined) {
    if (givenSha === undefined) return fail(422, 'sha is required when updating a file');
    if (givenSha !== existing.sha) return fail(409, `${decodedPath} does not match ${givenSha}`);
  }
  const blobSha = store.blob(bytes);
  const newTree = updateTree(store, tipTree, decodedPath.split('/'), blobSha);
  const { sha } = commitOnto(ctx, repo, branch, newTree, message);
  const status = existing !== undefined ? 200 : 201;
  return json(status, {
    content: {
      name: decodedPath.split('/').pop(),
      path: decodedPath,
      sha: blobSha,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      url: `/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${decodedPath}`,
    },
    commit: { sha, message, author: { name: VIEWER.name, email: VIEWER.email } },
  });
}

function contentsGet(ctx: Ctx, repo: Repo): Reply {
  const rawPath = ctx.path.split('/contents')[1] ?? '';
  const decodedPath = decodeURIComponent(rawPath.replace(/^\//, ''));
  const ref = ctx.query.get('ref') ?? repo.default_branch;
  const tipTree = ctx.forge.tipTree(repo, ref);
  if (tipTree === null) return fail(404, 'Not Found');
  const store = ctx.forge.store;
  if (decodedPath === '') {
    const entries = [...flattenTree(store, tipTree).keys()];
    return json(200, dirListing(store, tipTree, ''));
    void entries;
  }
  const flat = flattenTree(store, tipTree);
  const file = flat.get(decodedPath);
  if (file !== undefined) {
    const bytes = store.blobBytes(file.sha);
    if (bytes === undefined) return fail(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: bytes.length,
      name: decodedPath.split('/').pop(),
      path: decodedPath,
      sha: file.sha,
      content: bytes.toString('base64'),
      url: `/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${decodedPath}`,
    });
  }
  // A directory? Rebuild its immediate listing from the flat map.
  const prefix = `${decodedPath}/`;
  if ([...flat.keys()].some((k) => k.startsWith(prefix))) {
    return json(200, dirListing(store, tipTree, decodedPath));
  }
  return fail(404, 'Not Found');
}

function dirListing(store: Forge['store'], treeSha: string, dir: string): Record<string, unknown>[] {
  const flat = flattenTree(store, treeSha);
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, Record<string, unknown>>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { type: 'file', name: rest, path, sha: entry.sha, size: store.blobBytes(entry.sha)?.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: '', size: 0 });
    }
  }
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function contentsDelete(ctx: Ctx, repo: Repo): Reply {
  const body = ctx.body ?? {};
  const path = decodeURIComponent(ctx.path.split('/contents/')[1] ?? '');
  const branch = str(body.branch) ?? repo.default_branch;
  const store = ctx.forge.store;
  const tipTree = ctx.forge.tipTree(repo, branch);
  if (tipTree === null) return fail(404, 'Not Found');
  const existing = flattenTree(store, tipTree).get(path);
  if (existing === undefined) return fail(404, 'Not Found');
  const givenSha = str(body.sha);
  if (givenSha !== undefined && givenSha !== existing.sha) return fail(409, `${path} does not match ${givenSha}`);
  const newTree = updateTree(store, tipTree, path.split('/'), null);
  const { sha } = commitOnto(ctx, repo, branch, newTree, str(body.message) ?? 'Delete file');
  return json(200, { content: null, commit: { sha } });
}

// ---------------------------------------------------------------------------
// Pull request diff / merge
// ---------------------------------------------------------------------------

/** Line counts of a text diff by longest-common-subsequence over lines. */
function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  // LCS via dynamic programming on a rolling row; files in the suite are small.
  let prev = new Array<number>(bl.length + 1).fill(0);
  for (let i = 1; i <= al.length; i += 1) {
    const cur = new Array<number>(bl.length + 1).fill(0);
    for (let j = 1; j <= bl.length; j += 1) {
      cur[j] = al[i - 1] === bl[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  const common = prev[bl.length]!;
  return { additions: bl.length - common, deletions: al.length - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  before?: string;
  after?: string;
}

export function diffTrees(ctx: Ctx, baseTree: string | null, headTree: string | null): FileChange[] {
  const store = ctx.forge.store;
  const base = baseTree !== null ? flattenTree(store, baseTree) : new Map();
  const head = headTree !== null ? flattenTree(store, headTree) : new Map();
  const out: FileChange[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b !== undefined && h === undefined) {
      const text = store.blobBytes(b.sha)?.toString('utf8') ?? '';
      out.push({ filename: name, status: 'removed', additions: 0, deletions: text === '' ? 0 : text.split('\n').length, before: b.sha });
    } else if (b === undefined && h !== undefined) {
      const text = store.blobBytes(h.sha)?.toString('utf8') ?? '';
      out.push({ filename: name, status: 'added', additions: text === '' ? 0 : text.split('\n').length, deletions: 0, after: h.sha });
    } else if (b !== undefined && h !== undefined && b.sha !== h.sha) {
      const d = lineDiff(store.blobBytes(b.sha)?.toString('utf8') ?? '', store.blobBytes(h.sha)?.toString('utf8') ?? '');
      out.push({ filename: name, status: 'modified', ...d, before: b.sha, after: h.sha });
    }
  }
  return out;
}

/** The best common ancestor of two commits (first shared commit in breadth order). */
export function mergeBase(ctx: Ctx, a: string, b: string): string | null {
  const store = ctx.forge.store;
  const ancestorsOfA = new Set(walkCommits(store, a));
  for (const c of walkCommits(store, b)) if (ancestorsOfA.has(c)) return c;
  return null;
}

/** Would merging head into base conflict? Same path changed on both sides since the base. */
export function mergeConflicts(ctx: Ctx, repo: Repo, pull: Pull): boolean {
  const store = ctx.forge.store;
  const baseTip = repo.refs.get(pull.baseRef);
  const headTip = repo.refs.get(pull.headRef);
  if (baseTip === undefined || headTip === undefined) return true;
  if (baseTip === pull.baseSha) return false; // the base never moved
  const mb = mergeBase(ctx, baseTip, headTip);
  const mbTree = mb !== null ? parseCommit(store.get(mb)!.data).tree : null;
  const baseChanges = new Map(diffTrees(ctx, mbTree, ctx.forge.tipTree(repo, pull.baseRef)).map((f) => [f.filename, f]));
  const headChanges = diffTrees(ctx, mbTree, ctx.forge.tipTree(repo, pull.headRef));
  for (const f of headChanges) {
    const other = baseChanges.get(f.filename);
    if (other === undefined) continue;
    if (other.after !== f.after) return true;
  }
  return false;
}

/** Three-way tree merge: head's changes laid over the base tip's tree. */
function mergedTree(ctx: Ctx, repo: Repo, pull: Pull): string {
  const store = ctx.forge.store;
  const baseTip = repo.refs.get(pull.baseRef)!;
  const mb = mergeBase(ctx, baseTip, repo.refs.get(pull.headRef)!);
  const mbTree = mb !== null ? parseCommit(store.get(mb)!.data).tree : null;
  const files = new Map<string, string>();
  const baseFlat = flattenTree(store, parseCommit(store.get(baseTip)!.data).tree);
  for (const [path, e] of baseFlat) files.set(path, e.sha);
  for (const f of diffTrees(ctx, mbTree, ctx.forge.tipTree(repo, pull.headRef))) {
    if (f.status === 'removed') files.delete(f.filename);
    else if (f.after !== undefined) files.set(f.filename, f.after);
  }
  return buildTree(store, files);
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function handleRest(ctx: Ctx): Reply | null {
  const { forge, method, path } = ctx;
  const seg = path.split('/').filter((s) => s !== '');

  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return json(200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (path === '/api/v3/meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0-forge', hooks: [], verifiable_password_authentication: false });
  }
  if (path === '/api/v3/user' && method === 'GET') return json(200, userJson(VIEWER));
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') return paginate(ctx, forge.viewerRepos().map(repoJson));
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const name = str(body.name);
      if (name === undefined || name === '') return fail(422, 'name is required');
      if (forge.repo(VIEWER.login, name) !== undefined) return fail(422, 'name already exists on this account');
      const repo = forge.createRepo(VIEWER, name, {
        description: str(body.description) ?? null,
        private: bool(body.private) ?? false,
        defaultBranch: str(body.default_branch) ?? 'main',
      });
      return json(201, repoJson(repo));
    }
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos' && seg.length >= 5) {
    const owner = decodeURIComponent(seg[3]!);
    const name = decodeURIComponent(seg[4]!);
    const repo = forge.repo(owner, name);
    const rest = seg.slice(5);

    if (rest.length === 0) {
      if (repo === undefined) return fail(404, 'Not Found');
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = ctx.body ?? {};
        if (str(body.description) !== undefined) repo.description = str(body.description)!;
        if (bool(body.private) !== undefined) repo.private = bool(body.private)!;
        if (str(body.default_branch) !== undefined) repo.default_branch = str(body.default_branch)!;
        if (str(body.name) !== undefined && str(body.name) !== repo.name) {
          forge.deleteRepo(owner, repo.name);
          repo.name = str(body.name)!;
          forge.repos.set(Forge.key(owner, repo.name), repo);
        }
        repo.updated_at = Forge.clock.iso();
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204 };
      }
      return fail(404, 'Not Found');
    }
    if (repo === undefined) return fail(404, 'Not Found');
    return handleRepoScoped(ctx, repo, rest);
  }

  if (seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'users' && seg.length === 4 && method === 'GET') {
    const user = userByLogin(decodeURIComponent(seg[3]!));
    return user !== undefined ? json(200, userJson(user)) : fail(404, 'Not Found');
  }
  return null;
}

function handleRepoScoped(ctx: Ctx, repo: Repo, rest: string[]): Reply {
  const { forge, method } = ctx;
  const store = forge.store;
  const head = rest[0];

  if (head === 'contents') {
    if (method === 'PUT') return contentsPut(ctx, repo);
    if (method === 'GET') return contentsGet(ctx, repo);
    if (method === 'DELETE') return contentsDelete(ctx, repo);
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const ref = str(body.ref) ?? '';
      const sha = str(body.sha) ?? '';
      const branch = ref.replace(/^refs\/heads\//, '').replace(/^refs\//, '');
      if (store.get(sha)?.type !== 'commit') return fail(422, 'Object is not a commit');
      repo.refs.set(branch, sha);
      return json(201, {
        ref: `refs/heads/${branch}`,
        node_id: `REF_${repo.id}_${branch}`,
        url: `/api/v3/repos/${repo.owner.login}/${repo.name}/git/refs/heads/${branch}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner.login}/${repo.name}/git/commits/${sha}` },
      });
    }
    if (method === 'GET') {
      const out = [...repo.refs.entries()].map(([branch, sha]) => ({
        ref: `refs/heads/${branch}`,
        object: { sha, type: 'commit' },
      }));
      return json(200, out);
    }
  }

  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.refs.entries()].map(([branch, sha]) => ({
        name: branch,
        commit: { sha, url: `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}` },
        protected: false,
      })));
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1]!);
      const sha = repo.refs.get(branch);
      if (sha === undefined) return fail(404, 'Not Found');
      return json(200, { name: branch, commit: { sha, url: `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}` }, protected: false });
    }
  }

  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = ctx.query.get('sha') ?? repo.default_branch;
      const tip = repo.refs.get(ref) ?? (store.get(ref)?.type === 'commit' ? ref : undefined);
      if (tip === undefined) return json(200, []);
      const items = walkCommits(store, tip).map((sha) => {
        const c = parseCommit(store.get(sha)!.data);
        const person = (line: string): Record<string, unknown> => {
          const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
          return m !== null
            ? { name: m[1], email: m[2], date: new Date(parseInt(m[3]!, 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }
            : { name: line, email: '', date: Forge.clock.iso() };
        };
        return {
          sha,
          node_id: `C_${sha}`,
          commit: {
            author: person(c.author),
            committer: person(c.committer),
            message: c.message,
            tree: { sha: c.tree },
            comment_count: 0,
          },
          author: null,
          committer: null,
          parents: c.parents.map((p) => ({ sha: p })),
        };
      });
      return paginate(ctx, items);
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = rest[1]!;
      const obj = store.get(sha);
      if (obj === undefined || obj.type !== 'commit') return fail(404, 'Not Found');
      const c = parseCommit(obj.data);
      return json(200, { sha, commit: { message: c.message, tree: { sha: c.tree } }, parents: c.parents.map((p) => ({ sha: p })) });
    }
  }

  if (head === 'labels') {
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const name = str(body.name);
      if (name === undefined || name === '') return fail(422, 'name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: label already exists');
      const label = { id: forge.nextLabelId(), name, color: str(body.color) ?? 'ededed', description: str(body.description) ?? null };
      repo.labels.set(name, label);
      return json(201, labelJson(label));
    }
    if (method === 'GET' && rest.length === 1) return json(200, [...repo.labels.values()].map(labelJson));
    if (method === 'GET' && rest.length === 2) {
      const label = repo.labels.get(decodeURIComponent(rest[1]!));
      return label !== undefined ? json(200, labelJson(label)) : fail(404, 'Not Found');
    }
  }

  if (head === 'issues') return handleIssues(ctx, repo, rest);
  if (head === 'pulls') return handlePulls(ctx, repo, rest);
  return fail(404, 'Not Found');
}

function handleIssues(ctx: Ctx, repo: Repo, rest: string[]): Reply {
  const { forge, method } = ctx;
  if (rest.length === 1) {
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const title = str(body.title);
      if (title === undefined || title === '') return fail(422, 'title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const l of labelNames) {
        if (!repo.labels.has(l)) return fail(422, `Validation Failed: label '${l}' does not exist`);
      }
      const now = Forge.clock.iso();
      const issue: Issue = {
        id: forge.nextIssueId(),
        number: repo.nextNumber,
        title,
        body: str(body.body) ?? null,
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
      return json(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      const labels = ctx.query.get('labels');
      if (labels !== null) {
        const wanted = labels.split(',');
        items = items.filter((i) => wanted.every((w) => i.labels.includes(w)));
      }
      const sort = ctx.query.get('sort') ?? 'created';
      const dir = (ctx.query.get('direction') ?? 'desc') === 'asc' ? 1 : -1;
      items.sort((a, b) => {
        const ka = sort === 'updated' ? a.updated_at : a.created_at;
        const kb = sort === 'updated' ? b.updated_at : b.created_at;
        return ka === kb ? (a.number - b.number) * dir : (ka < kb ? -1 : 1) * dir;
      });
      return paginate(ctx, items.map((i) => issueJson(repo, i)));
    }
  }
  const number = parseInt(rest[1] ?? '', 10);
  const issue = Number.isNaN(number) ? undefined : repo.issues.get(number);
  if (rest.length === 2) {
    if (issue === undefined) return fail(404, 'Not Found');
    if (method === 'GET') return json(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = ctx.body ?? {};
      if (str(body.title) !== undefined) issue.title = str(body.title)!;
      if (str(body.body) !== undefined) issue.body = str(body.body)!;
      if (str(body.state) === 'closed' || str(body.state) === 'open') {
        issue.state = str(body.state) as 'open' | 'closed';
        issue.closed_at = issue.state === 'closed' ? Forge.clock.iso() : null;
      }
      if (Array.isArray(body.labels)) {
        const names = body.labels.filter((l): l is string => typeof l === 'string');
        for (const l of names) if (!repo.labels.has(l)) return fail(422, `Validation Failed: label '${l}' does not exist`);
        issue.labels = names;
      }
      issue.updated_at = Forge.clock.iso();
      return json(200, issueJson(repo, issue));
    }
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    if (issue === undefined) return fail(404, 'Not Found');
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const text = str(body.body);
      if (text === undefined) return fail(422, 'body is required');
      const now = Forge.clock.iso();
      const comment = { id: forge.nextCommentId(), body: text, user: VIEWER, created_at: now, updated_at: now };
      issue.comments.push(comment);
      issue.updated_at = now;
      return json(201, commentJson(repo, issue.number, comment));
    }
    if (method === 'GET') return paginate(ctx, issue.comments.map((c) => commentJson(repo, issue.number, c)));
  }
  if (rest.length === 3 && rest[2] === 'labels') {
    if (issue === undefined) return fail(404, 'Not Found');
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const names = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const l of names) if (!repo.labels.has(l)) return fail(404, 'Label does not exist');
      for (const l of names) if (!issue.labels.includes(l)) issue.labels.push(l);
      return json(200, issue.labels.map((n) => labelJson(repo.labels.get(n)!)));
    }
    if (method === 'GET') return json(200, issue.labels.map((n) => labelJson(repo.labels.get(n)!)));
  }
  return fail(404, 'Not Found');
}

function handlePulls(ctx: Ctx, repo: Repo, rest: string[]): Reply {
  const { forge, method } = ctx;
  if (rest.length === 1) {
    if (method === 'POST') {
      const body = ctx.body ?? {};
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base);
      if (title === undefined || headRaw === undefined || baseRaw === undefined) return fail(422, 'title, head and base are required');
      const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      const baseRef = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
      const headSha = repo.refs.get(headRef);
      const baseSha = repo.refs.get(baseRef);
      if (headSha === undefined) return fail(422, `Head ref ${headRef} does not exist`);
      if (baseSha === undefined) return fail(422, `Base ref ${baseRef} does not exist`);
      if (headSha === baseSha) return fail(422, 'No commits between base and head');
      const now = Forge.clock.iso();
      const pull: Pull = {
        id: forge.nextIssueId(),
        number: repo.nextNumber,
        title,
        body: str(body.body) ?? null,
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
        draft: body.draft === true,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      // The pull also lives in the issue list, as on GitHub.
      const shadow: Issue = {
        id: pull.id,
        number: pull.number,
        title,
        body: pull.body,
        state: 'open',
        labels: [],
        user: VIEWER,
        assignees: [],
        comments: [],
        created_at: now,
        updated_at: now,
        closed_at: null,
        pull_request: { url: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${pull.number}` },
      };
      repo.issues.set(pull.number, shadow);
      return json(201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      return paginate(ctx, items.map((p) => pullJson(repo, p)));
    }
  }
  const number = parseInt(rest[1] ?? '', 10);
  const pull = Number.isNaN(number) ? undefined : repo.pulls.get(number);
  if (rest.length === 2) {
    if (pull === undefined) return fail(404, 'Not Found');
    if (method === 'GET') {
      // Refresh the ref tips: a pull's head/base follow their branches.
      pull.headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
      return json(200, pullJson(repo, pull));
    }
    if (method === 'PATCH') {
      const body = ctx.body ?? {};
      if (str(body.title) !== undefined) pull.title = str(body.title)!;
      if (str(body.body) !== undefined) pull.body = str(body.body)!;
      if (str(body.state) === 'closed' || str(body.state) === 'open') {
        pull.state = str(body.state) as 'open' | 'closed';
        const shadow = repo.issues.get(pull.number);
        if (shadow !== undefined) shadow.state = pull.state;
      }
      pull.updated_at = Forge.clock.iso();
      return json(200, pullJson(repo, pull));
    }
  }
  if (pull === undefined) return fail(404, 'Not Found');
  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    const baseTree = forge.tipTree(repo, pull.baseRef);
    const headTree = forge.tipTree(repo, pull.headRef);
    const files = diffTrees(ctx, baseTree, headTree).map((f) => ({
      sha: f.after ?? f.before ?? '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
    }));
    return paginate(ctx, files);
  }
  if (rest.length === 3 && rest[2] === 'merge' && (method === 'PUT' || method === 'POST')) {
    if (pull.state !== 'open' || pull.merged) return fail(405, 'Pull Request is not mergeable');
    if (mergeConflicts(ctx, repo, pull)) return fail(405, 'Pull Request is not mergeable: conflicts must be resolved');
    const body = ctx.body ?? {};
    const tree = mergedTree(ctx, repo, pull);
    const title = str(body.commit_title) ?? `${pull.title} (#${pull.number})`;
    const message = `${title}\n\n${str(body.commit_message) ?? pull.body ?? ''}`.trimEnd() + '\n';
    const { sha } = commitOnto(ctx, repo, pull.baseRef, tree, message);
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
    return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return fail(404, 'Not Found');
}
