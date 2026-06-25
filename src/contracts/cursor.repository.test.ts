/**
 * Unit tests for cursor encode/decode primitives and limit validation.
 */

import {
  encodeCursor,
  decodeCursor,
  parseLimit,
} from './cursor.repository';
import { CURSOR_MAX_LIMIT, CURSOR_DEFAULT_LIMIT } from './cursor.types';

describe('encodeCursor / decodeCursor', () => {
  const position = { createdAt: '2024-06-01T12:00:00.000Z', id: 'abc-123' };

  it('round-trips a valid cursor position', () => {
    const cursor = encodeCursor(position);
    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(position);
  });

  it('produces a base64url string (no +, /, or = padding)', () => {
    const cursor = encodeCursor(position);
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('throws on completely invalid input', () => {
    expect(() => decodeCursor('not-base64-json')).toThrow(
      /invalid pagination cursor/i,
    );
  });

  it('throws on valid base64 that is not JSON', () => {
    const bad = Buffer.from('hello world', 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when createdAt field is missing', () => {
    const bad = Buffer.from(
      JSON.stringify({ id: 'abc-123' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when id field is missing', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when createdAt is not a valid date string', () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: 'not-a-date', id: 'abc-123' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when decoded value is a JSON primitive, not an object', () => {
    const bad = Buffer.from(JSON.stringify(42), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });

  it('throws when decoded value is null', () => {
    const bad = Buffer.from(JSON.stringify(null), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(/invalid pagination cursor/i);
  });
});

describe('parseLimit', () => {
  it('returns CURSOR_DEFAULT_LIMIT when value is undefined', () => {
    expect(parseLimit(undefined)).toBe(CURSOR_DEFAULT_LIMIT);
  });

  it('returns CURSOR_DEFAULT_LIMIT when value is null', () => {
    expect(parseLimit(null)).toBe(CURSOR_DEFAULT_LIMIT);
  });

  it('returns CURSOR_DEFAULT_LIMIT when value is empty string', () => {
    expect(parseLimit('')).toBe(CURSOR_DEFAULT_LIMIT);
  });

  it('parses a valid string number', () => {
    expect(parseLimit('10')).toBe(10);
  });

  it('parses a valid numeric value', () => {
    expect(parseLimit(50)).toBe(50);
  });

  it('accepts limit = 1 (minimum)', () => {
    expect(parseLimit(1)).toBe(1);
  });

  it(`accepts limit = ${CURSOR_MAX_LIMIT} (maximum)`, () => {
    expect(parseLimit(CURSOR_MAX_LIMIT)).toBe(CURSOR_MAX_LIMIT);
  });

  it(`throws when limit exceeds ${CURSOR_MAX_LIMIT}`, () => {
    expect(() => parseLimit(CURSOR_MAX_LIMIT + 1)).toThrow(/exceeds maximum/i);
  });

  it('throws when limit is 0', () => {
    expect(() => parseLimit(0)).toThrow(/positive integer/i);
  });

  it('throws when limit is negative', () => {
    expect(() => parseLimit(-10)).toThrow(/positive integer/i);
  });

  it('throws when limit is NaN (non-numeric string)', () => {
    expect(() => parseLimit('abc')).toThrow(/positive integer/i);
  });

  it('throws when limit is a float string that truncates to 0', () => {
    expect(() => parseLimit('0.9')).toThrow(/positive integer/i);
  });
});
