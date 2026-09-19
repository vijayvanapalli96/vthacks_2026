import { signOutAction } from '@/app/actions/auth';

export function SignOutForm() {
  return (
    <form action={signOutAction} className="signout">
      <button type="submit">Sign out</button>
    </form>
  );
}
