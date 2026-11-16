// Packfiles and pkt-lines: the two wire formats of git smart HTTP. The writer emits whole
// objects only (no deltas — legal, just less dense); the reader resolves both delta kinds,
// because a pushing client may send them.
import { createInflate, deflateSync } from 'node:zlib';
import { CODE_TYPES, TYPE_CODES, objectId, sha1Hex, type GitObject, type ObjType, type Store } from './gitobj.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

/** One pkt-line payload framed with its 4-hex length; null is the flush packet. */
export function pktLine(payload: Buffer | string | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'utf8');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');
export const PKT_RESPONSE_END = Buffer.from('0002', 'utf8');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  data: Buffer;
}

/** Split a buffer of pkt-lines into packets. */
export function parsePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = parseInt(buf.subarray(at, at + 4).toString('utf8'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
      at += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
      at += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', data: Buffer.alloc(0) });
      at += 4;
    } else {
      out.push({ kind: 'data', data: buf.subarray(at + 4, at + len) });
      at += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pack writing
// ---------------------------------------------------------------------------

function objectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** A complete pack holding the given objects, whole, in the order given. */
export function writePack(store: Store, shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) continue;
    parts.push(objectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ---------------------------------------------------------------------------
// Pack reading (with delta resolution)
// ---------------------------------------------------------------------------

/** Inflate one zlib stream starting at `offset`; resolves with the bytes and the offset past it. */
function inflateAt(buf: Buffer, offset: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), next: offset + stream.bytesRead }));
    stream.end(buf.subarray(offset));
  });
}

function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const b = buf[pos]!;
    pos += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const src = readVarint(delta, at);
  at = src.next;
  const dst = readVarint(delta, at);
  at = dst.next;
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at]!;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset = offset | (delta[at]! << (8 * i));
          at += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size = size | (delta[at]! << (8 * i));
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      parts.push(delta.subarray(at, at + op));
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (written !== dst.value) throw new Error('delta result size mismatch');
  return out;
}

interface PendingDelta {
  baseSha?: string;
  baseOffset?: number; // absolute offset of the base object's header in the pack
  delta: Buffer;
  headerAt: number;
}

/**
 * Read a pack stream into the store. Returns the new objects' shas. Bases for REF deltas may
 * live in the store already (a thin pack); OFS deltas point inside this pack.
 */
export async function readPack(store: Store, buf: Buffer): Promise<string[]> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('not a pack');
  const count = buf.readUInt32BE(8);
  let at = 12;
  const byOffset = new Map<number, string>(); // pack offset of an object header -> its sha
  const added: string[] = [];
  const deltas: PendingDelta[] = [];

  const materialise = (type: ObjType, data: Buffer, headerAt: number): string => {
    const sha = objectId(type, data);
    store.putExisting(sha, type, data);
    byOffset.set(headerAt, sha);
    added.push(sha);
    return sha;
  };

  for (let i = 0; i < count; i += 1) {
    const headerAt = at;
    const first = buf[at]!;
    at += 1;
    const code = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let b = first;
    while (b & 0x80) {
      b = buf[at]!;
      at += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    void size;
    if (code === 6) {
      // OFS_DELTA: a varint-ish negative offset to the base's header.
      let offsetByte = buf[at]!;
      at += 1;
      let offset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = buf[at]!;
        at += 1;
        offset = ((offset + 1) << 7) | (offsetByte & 0x7f);
      }
      const { data, next } = await inflateAt(buf, at);
      at = next;
      deltas.push({ baseOffset: headerAt - offset, delta: data, headerAt });
    } else if (code === 7) {
      const baseSha = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      const { data, next } = await inflateAt(buf, at);
      at = next;
      deltas.push({ baseSha, delta: data, headerAt });
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`pack object code ${code}`);
      const { data, next } = await inflateAt(buf, at);
      at = next;
      materialise(type, data, headerAt);
    }
  }

  // Resolve deltas, possibly chained, once every base is known.
  let pending = deltas;
  while (pending.length > 0) {
    const nextPending: PendingDelta[] = [];
    let progressed = false;
    for (const d of pending) {
      const baseSha = d.baseSha ?? (d.baseOffset !== undefined ? byOffset.get(d.baseOffset) : undefined);
      const base: GitObject | undefined = baseSha !== undefined ? store.get(baseSha) : undefined;
      if (base === undefined || baseSha === undefined) {
        nextPending.push(d);
        continue;
      }
      const data = applyDelta(base.data, d.delta);
      materialise(base.type, data, d.headerAt);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base missing');
    pending = nextPending;
  }
  return added;
}
