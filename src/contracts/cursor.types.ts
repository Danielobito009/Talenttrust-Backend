/**
 * @module contracts/cursor.types
 * @description Shared types for cursor-based pagination across repository layers.
 *
 * Cursor pagination avoids O(n) memory scans by anchoring the next page to a
 * stable row position rather than a numeric OFFSET.  The cursor encodes
 * (createdAt, id) — both are needed to guarantee stable ordering even when
 * two rows share an identical timestamp.
 */

/** Maximum number of items that may be requested in a single page. */
export const CURSOR_MAX_LIMIT = 100;

/** Default page size when the caller omits `limit`. */
export const CURSOR_DEFAULT_LIMIT = 20;

/**
 * The decoded position of the last item on a returned page.
 * Both fields must be present for unambiguous ordering.
 */
export interface CursorPosition {
  /** ISO-8601 creation timestamp of the anchor row. */
  createdAt: string;
  /** UUID of the anchor row (tie-breaker when timestamps collide). */
  id: string;
}

/**
 * Input parameters for a cursor-paginated query.
 *
 * @field limit  - Maximum items to return (1–100, default 20).
 * @field cursor - Opaque base-64 encoded {@link CursorPosition}.
 *                 Omit on the first page.
 */
export interface CursorPaginationInput {
  limit?: number;
  cursor?: string;
}

/**
 * Wraps a page of results with navigation metadata.
 *
 * @template T  - Domain record type.
 * @field data        - Items in the current page (up to `limit` entries).
 * @field nextCursor  - Opaque cursor to pass for the following page.
 *                      `null` when this is the last page.
 * @field hasNextPage - Convenience boolean; true when `nextCursor` is non-null.
 * @field limit       - The effective page size used for this query.
 */
export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
  hasNextPage: boolean;
  limit: number;
}
