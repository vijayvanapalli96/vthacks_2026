import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { setRoleAction } from '@/app/actions/auth';
import { intakeGate } from '@/lib/intake';
import { DEFAULT_ROLE, dashboardPath } from '@/lib/session';
import { SIGNUP_ROLE_COOKIE } from '@/lib/signup-role';
import { setUserRole, type Role } from '@/lib/users';

function asRole(value: string | string[] | undefined): Role | undefined {
  if (value === 'applicant' || value === 'employer') return value;
  return undefined;
}

const roleLabel: Record<Role, string> = { applicant: 'applicant', employer: 'employer' };
const workspaceLabel: Record<Role, string> = {
  applicant: 'applicant workspace',
  employer: 'hiring workspace',
};

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
 *
 * ONE CASE IS NOT SILENT, and this is the bug this page used to have. Google
 * gives one account per email, and an email that already signed up as an
 * applicant is still an applicant next time — whatever ?role= says, because a
 * URL must never be able to reassign an existing account. So "Create your
 * employer account" → "Sign up with Google" on an email that already exists as
 * an applicant dropped the person into /applicant/intake/resume with no
 * explanation at all. The role they asked for was known and thrown away.
 * A mismatch now stops and says so, and offers the switch.
 *
 * Applicants also go through intake before their dashboard: resume, then LinkedIn.
 * Employers have no intake and go straight to /employer.
 */
async function destinationFor(role: Role, userId: string): Promise<string> {
  if (role !== 'applicant') return dashboardPath[role];
  // Only the COLLECT steps have their own url. If analysis is outstanding the
  // dashboard shows it in place, so this hop still lands there.
  return (await intakeGate(userId)).nextStep ?? dashboardPath.applicant;
}

export default async function ContinuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/signin');

  const { role } = await searchParams;
  const asked = asRole(role);
  const current = session.user.role;

  // The account exists and wants a side it is not on. Never silently overrule
  // either one: the account's role is what it is until its owner changes it,
  // and the request is what they just clicked.
  if (current && asked && current !== asked) {
    return (
      <main className="auth-shell">
        <section className="auth-card panel">
          <h1>This account is already an {roleLabel[current]} account</h1>
          <p className="muted">
            You asked for the {workspaceLabel[asked]}, but {session.user.email ?? 'this account'} is registered as
            an {roleLabel[current]}. One email is one account here — signing in with Google does not create a
            second one, and a link cannot reassign an account on its own.
          </p>

          {/* The switch is deliberate, and it is the whole account: there is no
              dual-role state, so this is a move rather than an addition. */}
          <form action={setRoleAction}>
            <input type="hidden" name="role" value={asked} />
            <button className="primary" type="submit">
              Switch this account to {roleLabel[asked]}
            </button>
          </form>
          <p className="muted">
            Nothing already saved is deleted, but this account will use the {workspaceLabel[asked]} from now on.
          </p>

          <p className="divider">or</p>

          <p>
            <Link href={dashboardPath[current]}>Keep it as an {roleLabel[current]} account</Link>
          </p>
          <p className="muted">
            To have both sides at once, create the {roleLabel[asked]} account with a different email —{' '}
            <Link href={`/signup?role=${asked}`}>sign up here</Link>.
          </p>
        </section>
      </main>
    );
  }

  if (current) {
    redirect(await destinationFor(current, session.user.id));
  }

  // No role on the account, so this is the sign-up that decides it. The cookie
  // is consulted ONLY here, as the fallback for an OAuth round trip that lost
  // the query string — never in the mismatch check above, where a stale one
  // would question an ordinary sign-in that asked for nothing.
  const resolved = asked ?? asRole((await cookies()).get(SIGNUP_ROLE_COOKIE)?.value) ?? DEFAULT_ROLE;

  // Only ever SET a missing role, never overwrite one — an existing account keeps
  // the side it signed up as, whatever a URL claims.
  if (session.user.email) await setUserRole(session.user.email, resolved);

  redirect(await destinationFor(resolved, session.user.id));
}
