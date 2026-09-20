import { googleSignInAction } from '@/app/actions/auth';
import type { Role } from '@/lib/users';

/**
 * Google's "G", in its four brand colours.
 *
 * Hard-coded hex, not currentColor: this is someone else's trademark and it is
 * only permitted in its own palette (or flat white/black), so it is the one mark
 * on the page that must NOT inherit our ink.
 *
 * aria-hidden — the button's own text already says Google.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.8059 5.9564-2.1818l-2.9087-2.2581c-.8059.54-1.8368.8591-3.0477.8591-2.344 0-4.3282-1.5831-5.036-3.7104H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </svg>
  );
}

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
      {/* Not `.secondary`: that one is square and is used across the product.
          This is the auth pages' own rounded outline button, matching the
          primary's footprint directly above it. */}
      <button className="auth-alt" type="submit">
        <GoogleMark />
        {label}
      </button>
    </form>
  );
}
