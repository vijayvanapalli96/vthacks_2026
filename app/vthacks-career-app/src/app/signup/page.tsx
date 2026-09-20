import Link from 'next/link';

import { GoogleSignInForm } from '@/components/GoogleSignInForm';
import { SignUpForm } from '@/components/SignUpForm';
import { isGoogleConfigured } from '@/lib/providers';
import type { Role } from '@/lib/users';

export const metadata = { title: 'Create account · HireWire' };

function asRole(value: string | string[] | undefined): Role | undefined {
  if (value === 'applicant' || value === 'employer') return value;
  return undefined;
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The landing page links here with ?role=…, so the pathway is already decided
  // and the form does not ask again.
  const { role } = await searchParams;
  const chosen = asRole(role);

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1>
          {chosen === 'applicant'
            ? 'Create your applicant account'
            : chosen === 'employer'
              ? 'Create your employer account'
              : 'Create your account'}
        </h1>
        <p className="muted">
          {chosen
            ? 'Both sides are real accounts, because both sides have to prove who they are.'
            : 'Pick your side. Both are real accounts, because both sides have to prove who they are.'}
        </p>

        <SignUpForm role={chosen} />

        {isGoogleConfigured() ? (
          <GoogleSignInForm label="Sign up with Google" role={chosen} />
        ) : null}

        <p className="muted">
          Already have an account? <Link href="/signin">Sign in</Link>.
        </p>
      </section>
    </main>
  );
}
