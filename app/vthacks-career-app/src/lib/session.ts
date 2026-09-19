/**
 * session.ts — the route guards.
 *
 * These run in the route-group layouts (`/applicant`, `/employer`) rather than in
 * middleware, on purpose: see the note in auth.ts.
 *
 * A wrong-role visit is a redirect to your OWN dashboard, not a 403. Someone who
 * signed up as an applicant and typed /employer made a navigation mistake, not an
 * attack, and an error page would be a dead end for a screen-reader user.
 */
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import type { Role } from '@/lib/users';

export const dashboardPath: Record<Role, string> = {
  applicant: '/applicant',
  employer: '/employer',
};

export async function requireUser() {
  const session = await auth();
  if (!session?.user) redirect('/signin');
  return session.user;
}

export async function requireRole(role: Role) {
  const user = await requireUser();
  if (!user.role) redirect('/choose-role');
  if (user.role !== role) redirect(dashboardPath[user.role]);
  return user;
}
