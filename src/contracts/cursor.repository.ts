/**
 * @module contracts/cursor.repository
 * @description Reusable cursor encode/decode primitives.
 *
 * The cursor is a base-64 URL-safe JSON blob containing a {@link CursorPosition}.
 * Encoding is intentionally opaque to callers — they should treat it as an
 * untyped string and never parse it themselves.
 *
 * Security note: the cursor value is decoded with a try/catch and the
 * resulting fields are validated before use, so a malformed or tampered
 * cursor produces a 400 rather than a runtime exception.
 */

import type { CursorPosition } from './cursor.types';
import { CURSOR_MAX_LIMIT, CURSOR_DEFAULT_LIMIT } from './cursor.types';

/**
 * Encodes a {@link CursorPosition} into an opaque base-64 string suitable for
 * embedding in an API response.
 *
 * @param position - The anchor row's `createdAt` + `id` tuple.
 * @returns A base-64 URL-safe encoded cursor string.
 */
export function encodeCursor(position: CursorPosition): string {
  const json = JSON.stringify(position);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor string previously produced by {@link encodeCursor}.
 *
 * @param cursor - The opaque cursor string from the client.
 * @returns The decoded {@link CursorPosition}.
 * @throws {Error} When the cursor is malformed, tampered, or missing required fields.
 */
export function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid pagination cursor: cannot decode');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['createdAt'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['id'] !== 'string'
  ) {
    throw new Error('Invalid pagination cursor: missing required fields');
  }

  const pos = parsed as CursorPosition;

  // Basic ISO-8601 sanity check — rejects obviously garbage timestamps
  if (isNaN(Date.parse(pos.createdAt))) {
    throw new Error('Invalid pagination cursor: createdAt is not a valid date');
  }

  return pos;
}

/**
 * Clamps and validates a raw `limit` value from query params.
 *
 * @param raw - The raw value from `req.query.limit`.
 * @returns A safe integer in [1, {@link CURSOR_MAX_LIMIT}].
 * @throws {Error} When the supplied value exceeds {@link CURSOR_MAX_LIMIT}.
 */
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return CURSOR_DEFAULT_LIMIT;
  }

  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid limit: must be a positive integer`);
  }
  if (n > CURSOR_MAX_LIMIT) {
    throw new Error(
      `Invalid limit: ${n} exceeds maximum allowed page size of ${CURSOR_MAX_LIMIT}`
    );
  }
  return n;
}
