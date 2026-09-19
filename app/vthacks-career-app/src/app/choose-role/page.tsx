import { redirect } from 'next/navigation';

import { setRoleAction } from '@/app/actions/auth';
import { dashboardPath, requireUser } from '@/lib/session';

export const metadata = { title: 'Pick a workspace · HireWire' };

/**
 * PLACEHOLDER. Only reachable by signing in with Google straight from /signin,
 * where no pathway was ever collected — every route through the landing page
 * carries the role through OAuth and lands on a dashboard directly.
 *
 * It exists so a role-less account isn't a dead end. Replace it (or delete it,
 * once Google sign-in always originates from a pathway).
 */
export default async function ChooseRolePage() {
  const user = await requireUser();
  if (user.role) redirect(dashboardPath[user.role]);

  return (
    <main className="auth-shell">
      <section className="auth-card panel">
        <h1>Pick a workspace</h1>
        <form action={setRoleAction} className="role-actions">
          <button className="primary" type="submit" name="role" value="applicant">
            Applicant dashboard
          </button>
          <button className="primary" type="submit" name="role" value="employer">
            Employer dashboard
          </button>
        </form>
      </section>
    </main>
  );
}
