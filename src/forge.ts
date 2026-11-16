// The forge's data: users, repositories and everything in them (refs, issues, pull requests,
// labels, comments), held in memory on top of the git object store. Every id and timestamp is
// a counter over the trial's fixed clock, so two runs of the same request sequence produce
// the same bytes — the replay rule.
import { Store, parseCommit } from './gitobj.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

/** The scenario's people: fixed by the contest's own generator, the same in every trial. */
export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
export const TEAMMATE: User = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' };
export const ORG: User = { id: 1003, login: 'faint-meadow-org', name: 'faint meadow org', email: 'faint-meadow-org@example.invalid', type: 'Organization' };
export const USERS: User[] = [VIEWER, TEAMMATE, STRANGER, ORG];

export function userByLogin(login: string): User | undefined {
  return USERS.find((u) => u.login === login);
}

/** The author line the forge writes on commits it makes itself (contents, merges). */
export function forgeAuthor(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${Forge.clock.epochSeconds()} +0000`;
}

// ---------------------------------------------------------------------------
// The deterministic clock
// ---------------------------------------------------------------------------

class Clock {
  private baseMs: number;
  private tick = 0;

  constructor() {
    const env = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = env !== undefined ? Date.parse(env) : Number.NaN;
    this.baseMs = Number.isNaN(parsed) ? Date.parse('2026-11-01T00:00:00.000Z') : parsed;
  }

  /** The next timestamp: the trial's now plus one second per call, so order is visible. */
  iso(): string {
    const ms = this.baseMs + this.tick * 1000;
    this.tick += 1;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  epochSeconds(): number {
    return Math.floor(this.baseMs / 1000) + this.tick;
  }
}

// ---------------------------------------------------------------------------
// Repository data
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  assignees: User[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: User;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  draft: boolean;
}

export interface Repo {
  id: number;
  owner: User;
  name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  refs: Map<string, string>; // full ref name (refs/heads/..., refs/tags/...) -> object sha
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // issues and pull requests share one sequence, as on GitHub
}

export class Forge {
  static clock = new Clock();

  readonly store = new Store();
  readonly repos = new Map<string, Repo>(); // "owner/name" -> repo
  private repoSeq = 5000;
  private issueSeq = 9000;
  private labelSeq = 3000;
  private commentSeq = 7000;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: User, name: string, opts: { description?: string | null; private?: boolean; defaultBranch?: string }): Repo {
    const now = Forge.clock.iso();
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      description: opts.description ?? null,
      private: opts.private ?? false,
      default_branch: opts.defaultBranch ?? 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repoSeq += 1;
    this.repos.set(Forge.key(owner.login, name), repo);
    return repo;
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Forge.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.key(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner.login === VIEWER.login);
  }

  nextIssueId(): number {
    const id = this.issueSeq;
    this.issueSeq += 1;
    return id;
  }

  nextLabelId(): number {
    const id = this.labelSeq;
    this.labelSeq += 1;
    return id;
  }

  nextCommentId(): number {
    const id = this.commentSeq;
    this.commentSeq += 1;
    return id;
  }

  /** The sha a full ref points at, or undefined. */
  ref(repo: Repo, fullRef: string): string | undefined {
    return repo.refs.get(fullRef);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  setBranch(repo: Repo, branch: string, sha: string): void {
    repo.refs.set(`refs/heads/${branch}`, sha);
  }

  /** The tree sha at a branch tip, or null when the branch (or its commit) is absent. */
  tipTree(repo: Repo, branch: string): string | null {
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return null;
    const obj = this.store.get(sha);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }
}

// ---------------------------------------------------------------------------
// JSON shapes (GitHub's field spellings)
// ---------------------------------------------------------------------------

export function userJson(u: User): Record<string, unknown> {
  return {
    login: u.login,
    id: u.id,
    node_id: `U_${u.id}`,
    avatar_url: `https://forge.invalid/avatars/${u.login}`,
    url: `/api/v3/users/${u.login}`,
    html_url: `/${u.login}`,
    type: u.type,
    site_admin: false,
    name: u.name,
    email: u.email,
  };
}

export function repoJson(r: Repo): Record<string, unknown> {
  const full = `${r.owner.login}/${r.name}`;
  return {
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: full,
    private: r.private,
    owner: userJson(r.owner),
    html_url: `/${full}`,
    description: r.description,
    fork: false,
    url: `/api/v3/repos/${full}`,
    git_url: `git://forge.invalid/${full}.git`,
    ssh_url: `git@forge.invalid:${full}.git`,
    clone_url: `/${full}.git`,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: r.private ? 'private' : 'public',
    default_branch: r.default_branch,
  };
}

export function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, node_id: `L_${l.id}`, name: l.name, color: l.color, default: false, description: l.description };
}

export function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  const full = `${r.owner.login}/${r.name}`;
  const out: Record<string, unknown> = {
    id: i.id,
    node_id: `I_${i.id}`,
    url: `/api/v3/repos/${full}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${full}`,
    labels_url: `/api/v3/repos/${full}/issues/${i.number}/labels`,
    comments_url: `/api/v3/repos/${full}/issues/${i.number}/comments`,
    html_url: `/${full}/issues/${i.number}`,
    number: i.number,
    state: i.state,
    title: i.title,
    body: i.body,
    user: userJson(i.user),
    labels: i.labels.map((name) => {
      const l = r.labels.get(name);
      return l !== undefined ? labelJson(l) : { name };
    }),
    assignee: i.assignees[0] !== undefined ? userJson(i.assignees[0]) : null,
    assignees: i.assignees.map(userJson),
    comments: i.comments.length,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
  };
  if (i.pull_request !== undefined) out.pull_request = i.pull_request;
  return out;
}

export function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  const full = `${r.owner.login}/${r.name}`;
  const ref = (name: string, sha: string): Record<string, unknown> => ({
    label: `${r.owner.login}:${name}`,
    ref: name,
    sha,
    user: userJson(r.owner),
    repo: repoJson(r),
  });
  return {
    id: p.id,
    node_id: `PR_${p.id}`,
    url: `/api/v3/repos/${full}/pulls/${p.number}`,
    html_url: `/${full}/pull/${p.number}`,
    issue_url: `/api/v3/repos/${full}/issues/${p.number}`,
    number: p.number,
    state: p.state,
    title: p.title,
    body: p.body,
    user: userJson(p.user),
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.merged || p.state === 'closed' ? p.updated_at : null,
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    head: ref(p.headRef, p.headSha),
    base: ref(p.baseRef, p.baseSha),
    merged: p.merged,
    draft: p.draft,
  };
}

export function commentJson(r: Repo, issueNumber: number, c: Comment): Record<string, unknown> {
  const full = `${r.owner.login}/${r.name}`;
  return {
    id: c.id,
    node_id: `C_${c.id}`,
    url: `/api/v3/repos/${full}/issues/comments/${c.id}`,
    issue_url: `/api/v3/repos/${full}/issues/${issueNumber}`,
    html_url: `/${full}/issues/${issueNumber}#issuecomment-${c.id}`,
    body: c.body,
    user: userJson(c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}
