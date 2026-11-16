// MCP: filled in by the MCP step.
import type { Ctx, Reply } from './rest.ts';

export async function handleMcp(ctx: Ctx): Promise<Reply> {
  void ctx;
  return { status: 200, body: { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not implemented' } } };
}
