import { BriefcaseBusiness, UserRoundSearch } from 'lucide-react';
import { redirect } from 'next/navigation';

import { setRoleAction } from '@/app/actions/auth';
import { dashboardPath, requireUser } from '@/lib/session';

export const metadata = { title: 'Choose your pathway · HireWire' };

export default async function ChooseRolePage() {
  const user = await requireUser();

  // Already decided — don't make them answer twice.
  if (user.role) redirect(dashboardPath[user.role]);

  return (
    <main className="auth-shell">
      <section className="auth-card panel">
        <h1>Which describes you?</h1>
        <p className="muted">
          Google doesn&rsquo;t tell us whether you&rsquo;re applying or hiring, so we have to ask.
          This decides which workspace you land in.
        </p>

        <form action={setRoleAction} className="role-actions">
          <button className="primary" type="submit" name="role" value="applicant">
            <UserRoundSearch size={18} aria-hidden="true" />
            I&rsquo;m looking for a role
          </button>
          <button className="primary" type="submit" name="role" value="employer">
            <BriefcaseBusiness size={18} aria-hidden="true" />
            I&rsquo;m hiring
          </button>
        </form>
      </section>
    </main>
  );
}
