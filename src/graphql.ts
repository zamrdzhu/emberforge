// GraphQL v4: filled in by the GraphQL step.
import type { Ctx, Reply } from './rest.ts';

export async function handleGraphql(ctx: Ctx): Promise<Reply> {
  void ctx;
  return { status: 200, body: { errors: [{ message: 'not implemented' }] } };
}
