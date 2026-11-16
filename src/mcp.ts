// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP, speaking both protocol eras — the
// 2026-07-28 revision through server/discover (no handshake, no session) and the legacy
// handshake revisions through initialize + notifications/initialized. The tools act on the
// same store as REST, so an object made here reads back there unchanged.
import { Forge, VIEWER, issueJson, pullJson, repoJson, type Repo } from './forge.ts';
import { mergePullRequest } from './rest.ts';
import type { Ctx, Reply } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'emberforge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
  run: (ctx: Ctx, repo: Repo | null, args: Record<string, unknown>) => unknown;
}

function needRepo(ctx: Ctx, args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = ctx.forge.repo(owner, name);
  if (repo === undefined) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    run: (ctx, _repo, args) => {
      const name = String(args.name);
      if (ctx.forge.repo(VIEWER.login, name) !== undefined) throw new Error(`repository ${name} already exists`);
      const repo = ctx.forge.createRepo(VIEWER, name, {
        description: typeof args.description === 'string' ? args.description : null,
        private: args.private === true,
      });
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    run: (_ctx, repo) => repoJson(repo!),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    run: (ctx, repo, args) => {
      const r = repo!;
      const stamp = Forge.clock.iso();
      const issue = {
        id: ctx.forge.nextIssueId(),
        number: r.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open' as const,
        labels: [] as string[],
        user: VIEWER,
        assignees: [],
        comments: [],
        created_at: stamp,
        updated_at: stamp,
        closed_at: null,
      };
      r.nextNumber += 1;
      r.issues.set(issue.number, issue);
      return issueJson(r, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    run: (_ctx, repo, args) => {
      const r = repo!;
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...r.issues.values()].filter((i) => i.pull_request === undefined);
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      return items.map((i) => issueJson(r, i));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    run: (ctx, repo, args) => {
      const r = repo!;
      const headRef = String(args.head).includes(':') ? String(args.head).split(':').pop()! : String(args.head);
      const baseRef = String(args.base).includes(':') ? String(args.base).split(':').pop()! : String(args.base);
      const headSha = ctx.forge.branchTip(r, headRef);
      const baseSha = ctx.forge.branchTip(r, baseRef);
      if (headSha === undefined) throw new Error(`head ref ${headRef} does not exist`);
      if (baseSha === undefined) throw new Error(`base ref ${baseRef} does not exist`);
      const stamp = Forge.clock.iso();
      const pull = {
        id: ctx.forge.nextIssueId(),
        number: r.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open' as const,
        headRef,
        headSha,
        baseRef,
        baseSha,
        user: VIEWER,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        created_at: stamp,
        updated_at: stamp,
        draft: false,
      };
      r.nextNumber += 1;
      r.pulls.set(pull.number, pull);
      r.issues.set(pull.number, {
        id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: 'open',
        labels: [], user: VIEWER, assignees: [], comments: [], created_at: stamp, updated_at: stamp,
        closed_at: null, pull_request: { url: `/api/v3/repos/${r.owner.login}/${r.name}/pulls/${pull.number}` },
      });
      return pullJson(r, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    run: (ctx, repo, args) => {
      const r = repo!;
      const pull = r.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error(`pull request ${String(args.pull_number)} not found`);
      const result = mergePullRequest(ctx.forge, r, pull, {});
      if ('error' in result) throw new Error(result.error);
      return pullJson(r, pull);
    },
  },
];

function toolsList(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.properties).map(([k, v]) => [k, { type: v.type, description: v.description }])),
      required: t.required,
    },
  }));
}

function rpcError(id: unknown, code: number, message: string): Reply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}
function rpcResult(id: unknown, result: unknown): Reply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function callTool(ctx: Ctx, params: Record<string, unknown>): Reply {
  const id = (params as { __id?: unknown }).__id;
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  for (const req of tool.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return rpcResult(id, {
        content: [{ type: 'text', text: `missing required argument: ${req}` }],
        isError: true,
      });
    }
  }
  try {
    const repo = tool.name === 'create_repo' ? null : needRepo(ctx, args);
    const result = tool.run(ctx, repo, args);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    });
  } catch (err) {
    return rpcResult(id, {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    });
  }
}

export async function handleMcp(ctx: Ctx): Promise<Reply> {
  if (ctx.method === 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
  if (ctx.method === 'DELETE') return { status: 405, body: { message: 'Method Not Allowed' } };
  const body = ctx.body as Record<string, unknown> | null;
  if (body === null) return rpcError(null, -32700, 'Parse error');

  // A batch is not part of either era's contract here; answer each request in order if one comes.
  const requests = Array.isArray((body as { __array?: unknown }).__array)
    ? ((body as { __array: Record<string, unknown>[] }).__array as Record<string, unknown>[])
    : [body];
  const replies: unknown[] = [];
  for (const request of requests) {
    const method = typeof request.method === 'string' ? request.method : '';
    const id = request.id;
    const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
    if (id === undefined) {
      // A notification (initialized, cancelled, ...): accepted, no reply.
      continue;
    }
    switch (method) {
      case 'server/discover':
        replies.push({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SUPPORTED_VERSIONS[0],
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: CAPABILITIES,
            serverInfo: SERVER_INFO,
          },
        });
        break;
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const version = SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
        replies.push({
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO },
        });
        break;
      }
      case 'ping':
        replies.push({ jsonrpc: '2.0', id, result: {} });
        break;
      case 'tools/list':
        replies.push({ jsonrpc: '2.0', id, result: { tools: toolsList() } });
        break;
      case 'tools/call': {
        const reply = callTool(ctx, { ...params, __id: id });
        replies.push(reply.body);
        break;
      }
      default:
        replies.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
  if (replies.length === 0) return { status: 202 };
  if (Array.isArray((body as { __array?: unknown }).__array)) return { status: 200, body: replies };
  return { status: 200, body: replies[0] };
}
