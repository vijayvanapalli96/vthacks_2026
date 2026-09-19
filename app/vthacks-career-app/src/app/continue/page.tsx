import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { DEFAULT_ROLE, dashboardPath } from '@/lib/session';
import { setUserRole, type Role } from '@/lib/users';

function asRole(value: string | string[] | undefined): Role | undefined {
  if (value === 'applicant' || value === 'employer') return value;
  return undefined;
}

/**
 * Post-auth hop: the single place that decides where a signed-in person belongs,
 * and the only place that ever writes a missing role.
 *
 * There is no "pick a workspace" screen. The pathway is chosen once on the
 * landing page and travels from there: as a form field for email/password, and
 * as ?role=… through the Google OAuth round trip. This page persists it.
 *
 * If a role is somehow still missing — a Google sign-in begun straight from
 * /signin, or an account created before the pass-through existed — we write
 * DEFAULT_ROLE rather than interrupting with a question. Accepted tradeoff: an
 * employer arriving that way lands in the applicant workspace. That is
 * recoverable; a dead-end prompt in the middle of sign-in is not.
 */
export default async function ContinuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  if (session.user.role) redirect(dashboardPath[session.user.role]);

  const { role } = await searchParams;
  const resolved = asRole(role) ?? DEFAULT_ROLE;

  // Only ever SET a missing role, never overwrite one — an existing account keeps
  // the side it signed up as, whatever a URL claims.
  if (session.user.email) await setUserRole(session.user.email, resolved);

  redirect(dashboardPath[resolved]);
}
