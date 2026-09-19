import { googleSignInAction } from '@/app/actions/auth';

/**
 * Server-rendered: a plain form posting a server action, so Google sign-in works
 * with JavaScript disabled and needs no client bundle.
 */
export function GoogleSignInForm({ label = 'Continue with Google' }: { label?: string }) {
  return (
    <form action={googleSignInAction}>
      <button className="secondary" type="submit">
        {label}
      </button>
    </form>
  );
}
