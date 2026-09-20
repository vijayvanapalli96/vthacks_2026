/**
 * users.ts — accounts, backed by `workspace.vthacks_2026.users` in Databricks.
 *
 * DDL lives in sql/001_users.sql. Sessions are stateless JWTs, so there is no
 * sessions table.
 *
 * Two properties of this backend you have to design around, both real:
 *
 *  1. COLD START. The Serverless Starter warehouse stops when idle and takes
 *     20-30s to wake. The first sign-in after a quiet period genuinely blocks for
 *     that long. Before demoing, fire any query to warm it.
 *
 *  2. NO ENFORCED UNIQUENESS. Unity Catalog PRIMARY KEY/UNIQUE constraints are
 *     informational; Delta will happily store two rows with the same email.
 *     createUser() checks first, which closes the ordinary case but is not
 *     race-proof, and findUserByEmail() takes the newest row if duplicates ever
 *     appear. Postgres (TigerData, already in the stack) would enforce this
 *     properly — noted for after the hackathon.
 */
import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { sql, type SqlParam } from '@/lib/databricks';

export type Role = 'applicant' | 'employer';

export type StoredUser = {
  id: string;
  email: string;
  name?: string;
  passwordHash?: string;
  role?: Role;
  provider: 'credentials' | 'google';
  createdAt: string;
};

export type CreateUserInput = {
  email: string;
  provider: StoredUser['provider'];
  password?: string;
  name?: string;
  role?: Role;
};

/** Thrown by createUser when the email is already registered. */
export const EMAIL_TAKEN = 'EMAIL_TAKEN';

const TABLE = 'workspace.vthacks_2026.users';
const BCRYPT_ROUNDS = 10;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function asRole(value: string | null): Role | undefined {
  return value === 'applicant' || value === 'employer' ? value : undefined;
}

function toUser(row: (string | null)[]): StoredUser {
  const [id, email, name, passwordHash, role, provider, createdAt] = row;
  return {
    id: id ?? '',
    email: email ?? '',
    name: name ?? undefined,
    passwordHash: passwordHash ?? undefined,
    role: asRole(role),
    provider: provider === 'google' ? 'google' : 'credentials',
    createdAt: createdAt ?? '',
  };
}

const SELECT_COLUMNS = 'user_id, email, name, password_hash, role, provider, created_at';

/**
 * THE HOTTEST READ IN THE APP, and the reason navigation felt slow.
 *
 * Auth.js runs the `jwt` callback on every `auth()` call, and that callback
 * re-reads the store to pick up a role written at /continue. Each read is a
 * Databricks Statement Execution round trip: measured at 0.6-1.1s against a
 * WARM warehouse, for `SELECT 1`. Every page calls `requireRole` in its route
 * group layout AND in the page itself, so two of those were on the critical
 * path of every navigation before a single line of page data was read.
 *
 * So the row is held for a few seconds. Writes invalidate it explicitly rather
 * than waiting for the TTL, which is what keeps the one case that matters —
 * signing up, or switching role at /continue — instant and correct.
 *
 * SCOPE, stated because it is a real limit: this cache is per process. One
 * container is what we run; with several, a role written on one would take up
 * to TTL_MS to be seen by the others. Nothing here is a permission check —
 * requireRole reads this row, but the row is the user's own, and a stale copy
 * can only delay a workspace switch the user just asked for.
 */
const TTL_MS = 5_000;
const userCache = new Map<string, { user: StoredUser | null; at: number }>();

function invalidate(email: string): void {
  userCache.delete(normalizeEmail(email));
}

export async function findUserByEmail(email: string): Promise<StoredUser | null> {
  const normalized = normalizeEmail(email);
  const hit = userCache.get(normalized);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.user;

  const { rows } = await sql(
    `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE email = :email ORDER BY created_at DESC LIMIT 1`,
    [{ name: 'email', value: normalized }],
  );
  const user = rows.length ? toUser(rows[0]) : null;
  userCache.set(normalized, { user, at: Date.now() });
  return user;
}

export async function createUser(input: CreateUserInput): Promise<StoredUser> {
  const email = normalizeEmail(input.email);

  // Best-effort guard: Delta cannot enforce this for us. See the header note.
  const existing = await findUserByEmail(email);
  if (existing) throw new Error(EMAIL_TAKEN);

  const user: StoredUser = {
    id: randomUUID(),
    email,
    name: input.name?.trim() || undefined,
    passwordHash: input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : undefined,
    role: input.role,
    provider: input.provider,
    createdAt: new Date().toISOString(),
  };

  const parameters: SqlParam[] = [
    { name: 'user_id', value: user.id },
    { name: 'email', value: user.email },
    { name: 'name', value: user.name ?? null },
    { name: 'password_hash', value: user.passwordHash ?? null },
    { name: 'role', value: user.role ?? null },
    { name: 'provider', value: user.provider },
  ];

  await sql(
    `INSERT INTO ${TABLE} (user_id, email, name, password_hash, role, provider, created_at)
     VALUES (:user_id, :email, :name, :password_hash, :role, :provider, current_timestamp())`,
    parameters,
  );

  // The "no such user" answer from the check above is now wrong.
  invalidate(user.email);
  return user;
}

export async function setUserRole(email: string, role: Role): Promise<StoredUser | null> {
  const normalized = normalizeEmail(email);
  await sql(`UPDATE ${TABLE} SET role = :role WHERE email = :email`, [
    { name: 'role', value: role },
    { name: 'email', value: normalized },
  ]);
  // Before the re-read, so the next session callback sees the new role rather
  // than the one this call just replaced.
  invalidate(normalized);
  return findUserByEmail(normalized);
}

export async function verifyPassword(user: StoredUser, password: string): Promise<boolean> {
  // Google accounts have no password hash; they can only sign in via Google.
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}
