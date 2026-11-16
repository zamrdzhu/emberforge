// The forge's HTTP server: one router for the four surfaces — git smart HTTP, REST v3,
// GraphQL v4 and MCP — behind the bearer-token gate the wire contract sets. Every reply is
// JSON (git protocol bytes aside) and carries an X-GitHub-Request-Id; an unknown route is a
// JSON 404 and a malformed JSON body a 400, never HTML.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/forge.ts';
import { handleRest, type Reply } from './src/rest.ts';
import { handleGit } from './src/githttp.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 96 * 1024 * 1024;

let requestSeq = 0;

function sendReply(res: ServerResponse, reply: Reply): void {
  requestSeq += 1;
  const headers: Record<string, string> = {
    'x-github-request-id': `F${requestSeq.toString(36).toUpperCase().padStart(6, '0')}`,
    ...(reply.headers ?? {}),
  };
  if (reply.raw !== undefined) {
    res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/octet-stream', 'content-length': reply.raw.length, ...headers });
    res.end(reply.raw);
    return;
  }
  if (reply.body === undefined) {
    res.writeHead(reply.status, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(reply.body)}\n`;
  res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/healthz') {
        sendReply(res, { status: 200, body: { ok: true } });
        return;
      }

      // The token gate: every other surface wants the trial's bearer token.
      if (token !== '') {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${token}`) {
          sendReply(res, { status: 401, body: { message: 'Bad credentials' } });
          return;
        }
      }

      const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      let body: Record<string, unknown> | null = null;
      const contentType = req.headers['content-type'] ?? '';
      if (rawBody.length > 0 && (contentType.includes('application/json') || path === '/api/graphql' || path === '/mcp')) {
        try {
          const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
          body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed };
          if (Array.isArray(parsed)) body = { __array: parsed } as Record<string, unknown>;
        } catch {
          if (path === '/mcp') {
            sendReply(res, { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } });
          } else {
            sendReply(res, { status: 400, body: { message: 'Problems parsing JSON' } });
          }
          return;
        }
      }

      const ctx = { forge, method, path, query: url.searchParams, body, rawBody };

      if (path.startsWith('/api/v3') || path === '/api/v3') {
        const reply = handleRest(ctx);
        sendReply(res, reply ?? { status: 404, body: { message: 'Not Found' } });
        return;
      }
      if (path === '/api/graphql') {
        sendReply(res, await handleGraphql(ctx));
        return;
      }
      if (path === '/mcp') {
        sendReply(res, await handleMcp(ctx));
        return;
      }
      if (path.includes('.git/') || path.endsWith('.git')) {
        const reply = await handleGit(ctx, url);
        sendReply(res, reply);
        return;
      }
      sendReply(res, { status: 404, body: { message: 'Not Found' } });
    })().catch(() => {
      if (!res.headersSent) sendReply(res, { status: 500, body: { message: 'Internal Server Error' } });
    });
  });
}
