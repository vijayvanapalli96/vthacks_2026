/**
 * current-user.ts — the ONLY seam between this branch and the auth branch.
 *
 * feat/auth-template adds Auth.js v5 with an applicant/employer role and a
 * `requireRole()` guard. Until that lands there is no session to read, so this
 * returns a fixed dev id.
 *
 * WHEN THE AUTH BRANCH MERGES: delete this file's body and replace calls with
 *
 *   import { requireRole } from '@/lib/session';
 *   const user = await requireRole('applicant');
 *   // user.id
 *
 * Everything else in this branch already takes a userId as a parameter, so that
 * swap touches this file and the two call sites, nothing more.
 */

export function getCurrentUserId(): string {
  return process.env.DEV_USER_ID?.trim() || 'dev-applicant';
}
