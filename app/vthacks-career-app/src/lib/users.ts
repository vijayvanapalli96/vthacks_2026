/**
 * users.ts — the user store behind email/password + Google sign-in.
 *
 * !! DEV STORE !!
 * This writes JSON to the local filesystem. The Databricks Apps filesystem is
 * EPHEMERAL: every redeploy wipes it, and instances do not share it. That is
 * fine for the template and for local work. It is NOT where users live for the
 * demo.
 *
 * Tarang swaps this for `workspace.vthacks_2026.users`. Keep the four exported
 * functions below signature-stable and that swap stays a one-file change —
 * nothing else in the app imports the JSON file or knows that it exists.
 *
 * Known limitation, deliberate: read-modify-write is not atomic, so two
 * simultaneous signups can race. At our scale (a demo, a handful of accounts)
 * this is not worth a lockfile. The Databricks-backed version won't have it.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';

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

const BCRYPT_ROUNDS = 10;

// The directory is a static literal on purpose. If any part of the path above
// the filename is dynamic, Next's static analysis gives up and traces the ENTIRE
// project into the server bundle. So AUTH_USER_STORE is a FILENAME inside .data/,
// not a path.
const STORE_DIR = '.data';

function storePath(): string {
  return join(process.cwd(), STORE_DIR, process.env.AUTH_USER_STORE ?? 'users.json');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function readAll(): Promise<StoredUser[]> {
  try {
    const raw = await readFile(storePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredUser[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeAll(users: StoredUser[]): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
}

export async function findUserByEmail(email: string): Promise<StoredUser | null> {
  const wanted = normalizeEmail(email);
  const users = await readAll();
  return users.find((user) => user.email === wanted) ?? null;
}

export async function createUser(input: CreateUserInput): Promise<StoredUser> {
  const email = normalizeEmail(input.email);
  const users = await readAll();
  if (users.some((user) => user.email === email)) throw new Error(EMAIL_TAKEN);

  const user: StoredUser = {
    id: randomUUID(),
    email,
    name: input.name?.trim() || undefined,
    passwordHash: input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : undefined,
    role: input.role,
    provider: input.provider,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  await writeAll(users);
  return user;
}

export async function setUserRole(email: string, role: Role): Promise<StoredUser | null> {
  const wanted = normalizeEmail(email);
  const users = await readAll();
  const user = users.find((candidate) => candidate.email === wanted);
  if (!user) return null;

  user.role = role;
  await writeAll(users);
  return user;
}

export async function verifyPassword(user: StoredUser, password: string): Promise<boolean> {
  // Google accounts have no password hash; they can only sign in via Google.
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}
