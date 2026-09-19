'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { auth, signIn, signOut } from '@/auth';
import { isGoogleConfigured } from '@/lib/providers';
import { createUser, EMAIL_TAKEN, findUserByEmail, setUserRole } from '@/lib/users';

export type AuthFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

const roleSchema = z.enum(['applicant', 'employer']);

// Sign-in validates only presence. Checking the email FORMAT here would let
// someone distinguish "not a real address" from "wrong password", which is a
// (small) account-enumeration leak for no usability gain.
const signInSchema = z.object({
  email: z.string().min(1, 'Enter your email.'),
  password: z.string().min(1, 'Enter your password.'),
});

const signUpSchema = z.object({
  name: z.string().max(120, 'That name is too long.').optional(),
  email: z.email('Enter a valid email address.'),
  password: z.string().min(8, 'Use at least 8 characters.'),
  role: roleSchema,
});

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] ??= issue.message;
  }
  return errors;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = text(formData, 'email').trim();
  const password = text(formData, 'password');

  const parsed = signInSchema.safeParse({ email, password });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };

  try {
    await signIn('credentials', { email, password, redirectTo: '/continue' });
  } catch (error) {
    // A successful signIn throws NEXT_REDIRECT, which MUST propagate. Only
    // AuthError means the credentials were actually rejected.
    if (error instanceof AuthError) {
      return { error: 'That email and password do not match an account.' };
    }
    throw error;
  }

  return {};
}

export async function signUpAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const name = text(formData, 'name').trim();
  const email = text(formData, 'email').trim();
  const password = text(formData, 'password');
  const role = text(formData, 'role');

  const parsed = signUpSchema.safeParse({
    name: name || undefined,
    email,
    password,
    role: role || undefined,
  });
  if (!parsed.success) {
    const fieldErrors = fieldErrorsOf(parsed.error);
    if (fieldErrors.role) fieldErrors.role = 'Choose whether you are applying or hiring.';
    return { fieldErrors };
  }

  const existing = await findUserByEmail(parsed.data.email);
  if (existing) {
    return { fieldErrors: { email: 'An account with that email already exists. Sign in instead.' } };
  }

  try {
    await createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
      role: parsed.data.role,
      provider: 'credentials',
    });
  } catch (error) {
    if (error instanceof Error && error.message === EMAIL_TAKEN) {
      return {
        fieldErrors: { email: 'An account with that email already exists. Sign in instead.' },
      };
    }
    return { error: 'Could not create that account. Try again.' };
  }

  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: '/continue',
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'Account created, but sign-in failed. Try signing in.' };
    }
    throw error;
  }

  return {};
}

export async function googleSignInAction(formData: FormData): Promise<void> {
  // Belt and braces: the UI hides the button when Google isn't configured, but a
  // stale page or a hand-rolled POST could still land here, and calling signIn()
  // for an unregistered provider throws hard.
  if (!isGoogleConfigured()) redirect('/signin?error=google-unavailable');

  // Carry the pathway the landing page already collected through the OAuth round
  // trip, so we don't ask a second time on the way back.
  const role = roleSchema.safeParse(text(formData, 'role'));
  const redirectTo = role.success ? `/continue?role=${role.data}` : '/continue';

  await signIn('google', { redirectTo });
}

export async function setRoleAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.email) redirect('/signin');

  const parsed = roleSchema.safeParse(text(formData, 'role'));
  if (!parsed.success) redirect('/continue');

  await setUserRole(session.user.email, parsed.data);
  redirect(parsed.data === 'applicant' ? '/applicant' : '/employer');
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/' });
}
