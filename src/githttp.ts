// Git smart HTTP, implemented from the protocol documents: info/refs advertisements (v0 and
// v2), the v2 ls-refs and fetch commands, a v0 fetch fallback, and v0 receive-pack with
// report-status in side-band-64k frames. Objects move as whole-object packs (no deltas out);
// packs in are read with full delta resolution.
import { Forge, type Repo } from './forge.ts';
import { closure, isAncestor, parseCommit } from './gitobj.ts';
import { PKT_DELIM, PKT_FLUSH, parsePkts, pktLine, readPack, writePack } from './pack.ts';
import type { Ctx, Reply } from './rest.ts';

const ZERO = '0'.repeat(40);

function repoFromPath(forge: Forge, path: string): { repo: Repo; rest: string } | null {
  const m = /^\/(.+?)\/(.+?)\.git(\/.*)?$/.exec(path);
  if (m === null) return null;
  const repo = forge.repo(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
  if (repo === undefined) return null;
  return { repo, rest: m[3] ?? '' };
}

/** Every advertised ref: HEAD first, then heads and tags in name order. */
function refList(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  const head = repo.refs.get(`refs/heads/${repo.default_branch}`) ?? ZERO;
  out.push({ name: 'HEAD', sha: head });
  for (const name of [...repo.refs.keys()].sort()) out.push({ name, sha: repo.refs.get(name)! });
  return out;
}

/** The commit an annotated tag object peels to, or null for a lightweight tag. */
function peel(forge: Forge, sha: string): string | null {
  let obj = forge.store.get(sha);
  if (obj === undefined || obj.type !== 'tag') return null;
  for (let hops = 0; hops < 8; hops += 1) {
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (m === null) return null;
    const next = forge.store.get(m[1]!);
    if (next === undefined) return null;
    if (next.type === 'commit') return m[1]!;
    if (next.type !== 'tag') return null;
    obj = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function advertise(ctx: Ctx, repo: Repo, service: string, version2: boolean): Reply {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && version2) {
    const lines = [
      'version 2',
      'agent=emberforge/1.0',
      'ls-refs=unborn',
      'fetch=filter shallow wait-for-done',
      'server-option',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
    return { status: 200, raw: body, contentType };
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k ofs-delta object-format=sha1 symref=HEAD:refs/heads/${repo.default_branch}`
      : 'report-status delete-refs side-band-64k ofs-delta quiet object-format=sha1';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refList(repo);
  if (refs.length === 1 && refs[0]!.sha === ZERO) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((r, i) => {
      parts.push(pktLine(i === 0 ? `${r.sha} ${r.name}\0${caps}\n` : `${r.sha} ${r.name}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, raw: Buffer.concat(parts), contentType };
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function lsRefs(ctx: Ctx, repo: Repo, args: string[]): Reply {
  const prefixes: string[] = [];
  let symrefs = false;
  let peelWanted = false;
  let unborn = false;
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'peel') peelWanted = true;
    else if (a === 'unborn') unborn = true;
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  for (const r of refList(repo)) {
    if (!matches(r.name)) continue;
    let line = `${r.sha} ${r.name}`;
    if (r.name === 'HEAD') {
      if (symrefs) line += ` symref-target:refs/heads/${repo.default_branch}`;
      if (r.sha === ZERO && unborn) line += ' unborn';
    }
    if (peelWanted && r.name.startsWith('refs/tags/')) {
      const peeled = peel(ctx.forge, r.sha);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------------------
// Fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  wantRefs: { ref: string; oid: string }[];
  haves: string[];
  done: boolean;
  deepen: number | null;
  shallow: string[];
  sidebandAll: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], wantRefs: [], haves: [], done: false, deepen: null, shallow: [], sidebandAll: false };
  for (const a of args) {
    if (a.startsWith('want ')) out.wants.push(a.slice(5).trim());
    else if (a.startsWith('want-ref ')) {
      const parts = a.slice('want-ref '.length).split(' ');
      out.wantRefs.push({ ref: parts[0]!, oid: parts[1] ?? '' });
    } else if (a.startsWith('have ')) out.haves.push(a.slice(5).trim());
    else if (a === 'done') out.done = true;
    else if (a.startsWith('deepen ')) out.deepen = parseInt(a.slice(7), 10);
    else if (a.startsWith('shallow ')) out.shallow.push(a.slice(8).trim());
    else if (a === 'sideband-all') out.sidebandAll = true;
  }
  return out;
}

/** The boundary commits `depth` generations below the bases, walking parents. */
function depthBoundary(forge: Forge, bases: string[], depth: number): Set<string> {
  const boundary = new Set<string>();
  let frontier = [...bases];
  const seen = new Set<string>();
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = forge.store.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (d === depth - 1) {
        if (parents.length > 0) boundary.add(sha);
      } else next.push(...parents);
    }
    frontier = next;
  }
  return boundary;
}

function planPack(forge: Forge, repo: Repo, args: FetchArgs): { objects: string[]; shallowInfo: string[] } {
  const tips = [...args.wants];
  for (const wr of args.wantRefs) {
    const sha = repo.refs.get(wr.ref);
    if (sha !== undefined) tips.push(sha);
  }
  const haves = new Set(args.haves.filter((h) => forge.store.has(h)));
  const shallowInfo: string[] = [];
  let shallowAt = new Set<string>();
  if (args.deepen !== null && args.deepen > 0) {
    // Deepen is anchored at the wants: the new boundary sits `deepen` generations below the
    // wanted tips; commits the client held shallowly that are no longer the boundary unshallow.
    shallowAt = depthBoundary(forge, tips, args.deepen);
    for (const b of shallowAt) shallowInfo.push(`shallow ${b}`);
    for (const s of args.shallow) {
      if (!shallowAt.has(s)) shallowInfo.push(`unshallow ${s}`);
    }
  }
  const objs = closure(forge.store, tips, haves, shallowAt, new Set(args.shallow));
  return { objects: [...objs], shallowInfo };
}

/** Frame pack bytes into pkt-lines, band-1 prefixed when sideband framing applies. */
function framePack(pack: Buffer, sideband: boolean): Buffer[] {
  const parts: Buffer[] = [];
  const chunk = sideband ? 65515 : 65516;
  for (let at = 0; at < pack.length; at += chunk) {
    const slice = pack.subarray(at, at + chunk);
    parts.push(sideband ? pktLine(Buffer.concat([Buffer.from([1]), slice])) : pktLine(slice));
  }
  return parts;
}

function fetchV2(ctx: Ctx, repo: Repo, args: string[]): Reply {
  const parsed = parseFetchArgs(args);
  if (!parsed.done) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    let anyAck = false;
    for (const h of parsed.haves) {
      if (ctx.forge.store.get(h)?.type === 'commit') {
        parts.push(pktLine(`ACK ${h}\n`));
        anyAck = true;
      }
    }
    if (!anyAck) parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
    return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
  }
  const { objects, shallowInfo } = planPack(ctx.forge, repo, parsed);
  const parts: Buffer[] = [];
  if (shallowInfo.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowInfo) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  if (parsed.wantRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const wr of parsed.wantRefs) {
      const sha = repo.refs.get(wr.ref);
      if (sha !== undefined) parts.push(pktLine(`${sha} ${wr.ref}\n`));
    }
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(ctx.forge.store, objects);
  // In protocol v2 the packfile section is always sideband-framed: one band byte per packet.
  parts.push(...framePack(pack, true));
  parts.push(PKT_FLUSH);
  return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------------------
// Fetch (protocol v0)
// ---------------------------------------------------------------------------

function fetchV0(ctx: Ctx, repo: Repo, body: Buffer): Reply {
  const packets = parsePkts(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.data.toString('utf8').trimEnd());
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let sideband = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      wants.push(line.slice(5, 45));
      if (line.slice(45).includes('side-band-64k')) sideband = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7), 10);
  }
  const args: FetchArgs = { wants, wantRefs: [], haves, done: true, deepen, shallow, sidebandAll: false };
  const { objects, shallowInfo } = planPack(ctx.forge, repo, args);
  const parts: Buffer[] = [];
  for (const line of shallowInfo) parts.push(pktLine(`${line}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = writePack(ctx.forge.store, objects);
  if (sideband) parts.push(...framePack(pack, true));
  else parts.push(pack);
  parts.push(PKT_FLUSH);
  return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------------------
// Receive-pack (protocol v0)
// ---------------------------------------------------------------------------

async function receivePack(ctx: Ctx, repo: Repo, body: Buffer): Promise<Reply> {
  let at = 0;
  const commands: string[] = [];
  let caps = '';
  while (at + 4 <= body.length) {
    const len = parseInt(body.subarray(at, at + 4).toString('utf8'), 16);
    if (Number.isNaN(len) || len === 0) {
      at += 4;
      break;
    }
    const payload = body.subarray(at + 4, at + len).toString('utf8');
    if (commands.length === 0) {
      const nul = payload.indexOf('\0');
      if (nul >= 0) {
        caps = payload.slice(nul + 1);
        commands.push(payload.slice(0, nul).trimEnd());
      } else commands.push(payload.trimEnd());
    } else commands.push(payload.trimEnd());
    at += len;
  }
  const packBytes = body.subarray(at);
  if (packBytes.length >= 12) {
    try {
      await readPack(ctx.forge.store, packBytes);
    } catch {
      // A broken pack surfaces below as missing objects on the refs it tried to move.
    }
  }
  const results: string[] = [];
  for (const cmd of commands) {
    if (cmd === '') continue;
    const [oldSha, newSha, ref] = cmd.split(' ') as [string, string, string];
    results.push(applyUpdate(ctx, repo, oldSha, newSha, ref));
  }
  if (!caps.includes('report-status')) {
    return { status: 200, raw: Buffer.alloc(0), contentType: 'application/x-git-receive-pack-result' };
  }
  const report: Buffer[] = [pktLine('unpack ok\n')];
  for (const r of results) report.push(pktLine(`${r}\n`));
  report.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(report);
  if (caps.includes('side-band-64k')) {
    const framed = framePack(reportBytes, true);
    framed.push(PKT_FLUSH);
    return { status: 200, raw: Buffer.concat(framed), contentType: 'application/x-git-receive-pack-result' };
  }
  return { status: 200, raw: reportBytes, contentType: 'application/x-git-receive-pack-result' };
}

/** One ref update, git's rules: create, delete, or fast-forward only. Returns the report line. */
function applyUpdate(ctx: Ctx, repo: Repo, oldSha: string, newSha: string, ref: string): string {
  const store = ctx.forge.store;
  if (newSha === ZERO) {
    if (!repo.refs.has(ref)) return `ng ${ref} ref does not exist`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const obj = store.get(newSha);
  if (obj === undefined) return `ng ${ref} missing object`;
  if (oldSha === ZERO) {
    if (repo.refs.has(ref)) return `ng ${ref} ref already exists`;
    repo.refs.set(ref, newSha);
    return `ok ${ref}`;
  }
  const current = repo.refs.get(ref);
  if (current !== oldSha) return `ng ${ref} stale ref`;
  if (obj.type === 'commit' && store.get(oldSha)?.type === 'commit' && !isAncestor(store, oldSha, newSha)) {
    return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newSha);
  repo.pushed_at = Forge.clock.iso();
  return `ok ${ref}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleGit(ctx: Ctx, url: URL): Promise<Reply> {
  const found = repoFromPath(ctx.forge, ctx.path);
  if (found === null) return { status: 404, body: { message: 'Not Found' } };
  const { repo, rest } = found;

  if (rest === '/info/refs' && ctx.method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 403, body: { message: 'Forbidden' } };
    }
    const wantsV2 = (ctx as Ctx & { gitProtocol?: string }).gitProtocol === 'version=2';
    return advertise(ctx, repo, service, wantsV2);
  }
  if (rest === '/git-upload-pack' && ctx.method === 'POST') {
    const packets = parsePkts(ctx.rawBody);
    const firstData = packets.find((p) => p.kind === 'data');
    const firstLine = firstData?.data.toString('utf8').trimEnd() ?? '';
    if (firstLine.startsWith('command=')) {
      const command = firstLine.slice('command='.length);
      const delimAt = packets.findIndex((p) => p.kind === 'delim');
      const argPackets = delimAt >= 0 ? packets.slice(delimAt + 1) : packets.slice(1);
      const args = argPackets.filter((p) => p.kind === 'data').map((p) => p.data.toString('utf8').trimEnd());
      if (command === 'ls-refs') return lsRefs(ctx, repo, args);
      if (command === 'fetch') return fetchV2(ctx, repo, args);
      return { status: 200, raw: Buffer.concat([pktLine('ERR unknown command\n'), PKT_FLUSH]), contentType: 'application/x-git-upload-pack-result' };
    }
    return fetchV0(ctx, repo, ctx.rawBody);
  }
  if (rest === '/git-receive-pack' && ctx.method === 'POST') {
    return receivePack(ctx, repo, ctx.rawBody);
  }
  return { status: 404, body: { message: 'Not Found' } };
}
