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
      {/* `panel` was inert here: .auth-card is declared later in globals.css and
          zeroes the same padding, so the class only added noise. */}
      <section className="auth-card">
        <h1>Sign in</h1>
        <p className="muted">
          Nothing leaves your hands until you approve it and the other side proves who it is.
        </p>

        {error === 'google-unavailable' ? (
          <p className="auth-error" role="alert">
            Google sign-in isn&rsquo;t set up on this deployment yet. Use your email and password.
          </p>
        ) : null}

        <SignInForm />

        {/* No "or" rule between the two. The Google control is visibly lighter
            than the primary bar, so the alternative reads as an alternative
            without a label and two hairlines saying so. */}
        {google ? <GoogleSignInForm /> : null}

        <p className="muted">
          No account yet? <Link href="/signup">Create one</Link>.
        </p>
      </section>
    </main>
  );
}
