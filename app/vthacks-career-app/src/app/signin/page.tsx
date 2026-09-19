import Link from 'next/link';

import { GoogleSignInForm } from '@/components/GoogleSignInForm';
import { SignInForm } from '@/components/SignInForm';

export const metadata = { title: 'Sign in · HireWire' };

export default function SignInPage() {
  return (
    <main className="auth-shell">
      <section className="auth-card panel">
        <h1>Sign in</h1>
        <p className="muted">
          Your agent never releases a document or any personal detail until you approve it and the
          other side proves who it is.
        </p>

        <SignInForm />

        <p className="divider">or</p>
        <GoogleSignInForm />

        <p className="muted">
          No account yet? <Link href="/signup">Create one</Link>.
        </p>
      </section>
    </main>
  );
}
