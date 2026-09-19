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
  // The landing page links here with ?role=… so the pathway the person clicked is
  // already selected. They can still change it.
  const { role } = await searchParams;

  return (
    <main className="auth-shell">
      <section className="auth-card panel">
        <h1>Create your account</h1>
        <p className="muted">
          Pick your side of the handshake. Both sides are real accounts, because both sides have to
          be able to prove who they are.
        </p>

        <SignUpForm defaultRole={asRole(role)} />

        <p className="divider">or</p>
        <GoogleSignInForm label="Sign up with Google" />

        <p className="muted">
          Already have an account? <Link href="/signin">Sign in</Link>.
        </p>
      </section>
    </main>
  );
}
