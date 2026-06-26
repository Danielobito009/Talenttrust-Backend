/**
 * @module services/auth
 * @description Authentication service: registration, login, and refresh-token rotation.
 *
 * Security notes:
 * - Passwords are hashed with scrypt (Node built-in, no extra dependency).
 * - timingSafeEqual is used for all secret comparisons to prevent timing attacks.
 * - Refresh tokens are stored as SHA-256 hashes; the raw token is never persisted.
 * - All error paths return the same generic message to prevent user-enumeration.
 * - JWTs are HS256, signed with JWT_SECRET, payload shape: { sub, email, role }.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "crypto";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "7d";
const REFRESH_TOKEN_BYTES = 32;

/** JWT payload shape expected by requireAuth. */
export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface UserAuthRow {
  id: string;
  username: string;
  email: string;
  role: string;
  password_hash: string | null;
  refresh_token_hash: string | null;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return secret;
}

/**
 * Hashes a password using scrypt with a random salt.
 * Output format: `<hex-salt>:<hex-hash>`
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `${salt}:${hash.toString("hex")}`;
}

/**
 * Verifies a password against a stored scrypt hash (constant-time).
 */
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const storedBuf = Buffer.from(hashHex, "hex");
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return storedBuf.length === candidate.length && timingSafeEqual(storedBuf, candidate);
}

/** SHA-256 hash of a raw refresh token for storage. */
function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function issueTokens(user: { id: string; email: string; role: string }): AuthTokens {
  const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role };
  const secret = getSecret();
  const accessToken = jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn: ACCESS_TOKEN_TTL,
  });
  const rawRefresh = randomBytes(REFRESH_TOKEN_BYTES).toString("hex");
  const refreshToken = jwt.sign({ sub: user.id, tok: rawRefresh }, secret, {
    algorithm: "HS256",
    expiresIn: REFRESH_TOKEN_TTL,
  });
  return { accessToken, refreshToken };
}

export class AuthService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Registers a new user with a hashed password.
   *
   * @param email    - Normalised (lowercased) email address.
   * @param password - Plaintext password (min 8 chars enforced by Zod schema).
   * @param username - Display name.
   * @param role     - User role (default: 'client').
   * @returns Issued access + refresh tokens.
   * @throws Error with `duplicate_email` code when the email is already taken.
   */
  async register(
    email: string,
    password: string,
    username: string,
    role = "client"
  ): Promise<AuthTokens> {
    const normalised = email.toLowerCase();
    const existing = this.db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE email = ?")
      .get(normalised);
    if (existing) {
      const err = new Error("An account with that email already exists.");
      (err as NodeJS.ErrnoException).code = "duplicate_email";
      throw err;
    }

    const passwordHash = hashPassword(password);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare<[string, string, string, string, string, string]>(
        `INSERT INTO users (id, username, email, role, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, username, normalised, role, passwordHash, createdAt);

    const tokens = issueTokens({ id, email: normalised, role });
    this.db
      .prepare<[string, string]>("UPDATE users SET refresh_token_hash = ? WHERE id = ?")
      .run(hashRefreshToken(tokens.refreshToken), id);

    return tokens;
  }

  /**
   * Authenticates a user by email/password and returns tokens.
   *
   * Uses a constant-time compare for passwords and always returns the same
   * generic error to prevent user-enumeration.
   *
   * @param email    - User's email address.
   * @param password - Plaintext password.
   * @returns Issued access + refresh tokens.
   * @throws Error with `invalid_credentials` code on any auth failure.
   */
  async login(email: string, password: string): Promise<AuthTokens> {
    const normalised = email.toLowerCase();
    const row = this.db
      .prepare<[string], UserAuthRow>(
        "SELECT id, username, email, role, password_hash, refresh_token_hash FROM users WHERE email = ?"
      )
      .get(normalised);

    // Always hash even on "not found" to maintain constant-time behaviour
    const storedHash = row?.password_hash ?? `${"a".repeat(32)}:${"b".repeat(128)}`;
    const valid = verifyPassword(password, storedHash);

    if (!row || !valid) {
      const err = new Error("Authentication failed.");
      (err as NodeJS.ErrnoException).code = "invalid_credentials";
      throw err;
    }

    const tokens = issueTokens(row);
    this.db
      .prepare<[string, string]>("UPDATE users SET refresh_token_hash = ? WHERE id = ?")
      .run(hashRefreshToken(tokens.refreshToken), row.id);

    return tokens;
  }

  /**
   * Rotates a refresh token.
   *
   * Validates the JWT signature + expiry, then performs a constant-time hash
   * comparison against the stored hash. On success the old token is invalidated
   * and a fresh pair is issued.
   *
   * @param refreshToken - The raw refresh JWT presented by the client.
   * @returns New access + refresh token pair.
   * @throws Error with `invalid_refresh_token` code on any failure.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const invalidErr = (): never => {
      const err = new Error("Invalid or expired refresh token.");
      (err as NodeJS.ErrnoException).code = "invalid_refresh_token";
      throw err;
    };

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(refreshToken, getSecret(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    } catch {
      invalidErr();
    }

    const userId = decoded!.sub;
    if (!userId) invalidErr();

    const row = this.db
      .prepare<[string], UserAuthRow>(
        "SELECT id, email, role, refresh_token_hash FROM users WHERE id = ?"
      )
      .get(userId!);

    if (!row || !row.refresh_token_hash) invalidErr();

    const incoming = Buffer.from(hashRefreshToken(refreshToken), "hex");
    const stored = Buffer.from(row!.refresh_token_hash!, "hex");
    if (incoming.length !== stored.length || !timingSafeEqual(incoming, stored)) {
      invalidErr();
    }

    // Revoke current token immediately (rotation)
    this.db
      .prepare<[string]>("UPDATE users SET refresh_token_hash = NULL WHERE id = ?")
      .run(userId!);

    const tokens = issueTokens(row!);
    this.db
      .prepare<[string, string]>("UPDATE users SET refresh_token_hash = ? WHERE id = ?")
      .run(hashRefreshToken(tokens.refreshToken), row!.id);

    return tokens;
  }

  /**
   * Revokes the refresh token for the given user (logout).
   */
  logout(userId: string): void {
    this.db
      .prepare<[string]>("UPDATE users SET refresh_token_hash = NULL WHERE id = ?")
      .run(userId);
  }
}
