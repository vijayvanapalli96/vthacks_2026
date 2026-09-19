import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { dashboardPath } from '@/lib/session';

/**
 * Post-auth hop. Both sign-in paths land here so there is exactly one place that
 * decides where a signed-in person belongs.
 */
export default async function ContinuePage(): Promise<never> {
  const session = await auth();
  if (!session?.user) redirect('/signin');
  if (!session.user.role) redirect('/choose-role');
  redirect(dashboardPath[session.user.role]);
}
