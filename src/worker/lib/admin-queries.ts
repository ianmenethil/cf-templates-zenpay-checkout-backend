import { z } from 'zod';
import { CALLBACK_OUTCOMES, PAYMENT_STATES } from '../../shared/types';
import { cursorSchema } from './cursor';

/** Longest search text used; the rest of a longer one is ignored. */
const MAX_SEARCH_LENGTH = 100;

/** The query string of `GET /admin/api/payments`. A parameter that is left out filters nothing; an empty `q` filters nothing too. */
export const paymentsQuerySchema = z.object({
  state: z.enum(PAYMENT_STATES, { error: 'state is not a payment state.' }).optional(),
  q: z
    .string({ error: 'q must be text.' })
    .transform((text) => text.slice(0, MAX_SEARCH_LENGTH))
    .optional(),
  before: cursorSchema.optional(),
});

/** The query string of `GET /admin/api/callbacks`. A parameter that is left out filters nothing. */
export const callbacksQuerySchema = z.object({
  outcome: z.enum(CALLBACK_OUTCOMES, { error: 'outcome is not a callback outcome.' }).optional(),
  before: cursorSchema.optional(),
});
