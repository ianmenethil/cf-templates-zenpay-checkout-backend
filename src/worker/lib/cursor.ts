import { z } from 'zod';

/** Where the next page of a newest-first list starts: after this row in `(time, id)` order. */
export type Cursor = { time: string; id: string };

/** Rows per page of the admin lists. */
export const PAGE_SIZE = 50;

/** What is said when `before` is not a cursor. */
const CURSOR_MESSAGE = 'before is not a cursor from an earlier answer.';

/** A time and an ID with one underscore between them, or nothing at all. */
const CURSOR_PATTERN = /^(?:[^_]+_[^_]+)?$/;

/**
 * Writes the cursor of the page after `row`, as the admin API's `nextBefore`.
 * @param row - The last row of a page.
 * @returns The cursor text.
 */
export const formatCursor = (row: Cursor): string => `${row.time}_${row.id}`;

/**
 * Reads a `before` query value: the `nextBefore` of an earlier answer. An empty value means no cursor, the same as
 * leaving `before` out, so it is the first page.
 */
export const cursorSchema = z
  .string({ error: CURSOR_MESSAGE })
  .regex(CURSOR_PATTERN, { error: CURSOR_MESSAGE })
  .transform((value): Cursor | undefined => {
    if (value === '') {
      return undefined;
    }
    const [time, id] = value.split('_');
    return { time, id };
  });
