// Git smart HTTP: filled in by the git surface step.
import type { Ctx, Reply } from './rest.ts';

export async function handleGit(ctx: Ctx, _url: URL): Promise<Reply> {
  void ctx;
  return { status: 404, body: { message: 'Not Found' } };
}
