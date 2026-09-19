import { googleSignInAction } from '@/app/actions/auth';
import type { Role } from '@/lib/users';

/**
 * Server-rendered: a plain form posting a server action, so Google sign-in works
 * with JavaScript disabled and needs no client bundle.
 *
 * `role` matters. Google tells us nothing about which side of the handshake
 * someone is on, so if the landing page already asked, we carry that answer
 * through the OAuth round trip instead of asking again on the way back.
 */
export function GoogleSignInForm({
  label = 'Continue with Google',
  role,
}: {
  label?: string;
  role?: Role;
}) {
  return (
    <form action={googleSignInAction}>
      {role ? <input type="hidden" name="role" value={role} /> : null}
      <button className="secondary" type="submit">
        {label}
      </button>
    </form>
  );
}
