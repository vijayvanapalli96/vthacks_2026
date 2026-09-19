import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { dashboardPath } from '@/lib/session';
import { setUserRole, type Role } from '@/lib/users';

function asRole(value: string | string[] | undefined): Role | undefined {
  if (value === 'applicant' || value === 'employer') return value;
  return undefined;
}

/**
 * Post-auth hop: the single place that decides where a signed-in person belongs.
 *
 * Google returns here with ?role=… when the landing page already asked which
 * pathway they're on. Claiming it here is what keeps /choose-role out of the
 * normal flow — that page is now only a fallback for a Google sign-in that
 * carried no role at all.
 */
export default async function ContinuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  const { role } = await searchParams;
  const requested = asRole(role);

  // Only ever SET a role, never overwrite one. An existing account keeps the side
  // it signed up as, whatever a URL claims.
  if (!session.user.role && requested && session.user.email) {
    await setUserRole(session.user.email, requested);
    redirect(dashboardPath[requested]);
  }

  if (!session.user.role) redirect('/choose-role');
  redirect(dashboardPath[session.user.role]);
}
