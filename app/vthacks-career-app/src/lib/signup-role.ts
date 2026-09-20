/**
 * signup-role.ts — the name of the cookie that carries "which side did they
 * click" across the Google OAuth round trip.
 *
 * IT LIVES HERE AND NOT IN app/actions/auth.ts because that file is a
 * 'use server' module, and those may export async functions and nothing else.
 * Exporting a string const from one does not fail typecheck or lint: it makes
 * the module export NOTHING at build time, and every import of every action in
 * it breaks at once. One shared constant is not worth that, so it sits in a
 * plain module both sides import.
 */
export const SIGNUP_ROLE_COOKIE = 'hirewire.signup_role';
