import type { Hook } from '@hono/standard-validator';
import type { AppEnv } from '../env';

/**
 * The hook every `sValidator` in this Worker uses. A request that fails its schema is answered `400` with the first
 * issue's message in the `{ error }` shape the other routes use; a request that passes goes on to the handler, which
 * reads the checked values with `c.req.valid(...)`.
 * @param result - What the schema made of the request.
 * @param c - The request context.
 * @returns The `400` answer when the request is not valid, otherwise nothing.
 */
export const rejectInvalid: Hook<unknown, AppEnv, string> = (result, c) => {
  if (!result.success) {
    return c.json({ error: result.error[0]?.message ?? 'The request is not valid.' }, 400);
  }
};
