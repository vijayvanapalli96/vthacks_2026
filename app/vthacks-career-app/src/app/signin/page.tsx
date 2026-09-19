import Link from 'next/link';

import { GoogleSignInForm } from '@/components/GoogleSignInForm';
import { SignInForm } from '@/components/SignInForm';
import { isGoogleConfigured } from '@/lib/providers';

export const metadata = { title: 'Sign in · HireWire' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  const google = isGoogleConfigured();

  return (
    <main className="auth-shell">
      <section className="auth-card panel">
        <h1>Sign in</h1>
        <p className="muted">
          Your agent never releases a document or any personal detail until you approve it and the
          other side proves who it is.
        </p>

        {error === 'google-unavailable' ? (
          <p className="auth-error" role="alert">
            Google sign-in isn&rsquo;t set up on this deployment yet. Use your email and password.
          </p>
        ) : null}

        <SignInForm />

        {google ? (
          <>
            <p className="divider">or</p>
            <GoogleSignInForm />
          </>
        ) : null}

        <p className="muted">
          No account yet? <Link href="/signup">Create one</Link>.
        </p>
      </section>
    </main>
  );
}
