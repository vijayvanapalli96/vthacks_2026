import Link from 'next/link';

import { GoogleSignInForm } from '@/components/GoogleSignInForm';
import { SignUpForm } from '@/components/SignUpForm';
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
      <section className="auth-card panel">
        <h1>
          {chosen === 'applicant'
            ? 'Create your applicant account'
            : chosen === 'employer'
              ? 'Create your employer account'
              : 'Create your account'}
        </h1>
        <p className="muted">
          {chosen
            ? 'Both sides of the handshake are real accounts, because both sides have to be able to prove who they are.'
            : 'Pick your side of the handshake. Both sides are real accounts, because both sides have to be able to prove who they are.'}
        </p>

        <SignUpForm role={chosen} />

        <p className="divider">or</p>
        <GoogleSignInForm label="Sign up with Google" />

        <p className="muted">
          Already have an account? <Link href="/signin">Sign in</Link>.
        </p>
      </section>
    </main>
  );
}
