'use client';

import { useActionState } from 'react';

import { signInAction, type AuthFormState } from '@/app/actions/auth';

const initialState: AuthFormState = {};

export function SignInForm() {
  const [state, action, pending] = useActionState(signInAction, initialState);
  const emailError = state.fieldErrors?.email;
  const passwordError = state.fieldErrors?.password;

  return (
    <form action={action} className="auth-form" noValidate>
      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="signin-email">Email</label>
        <input
          id="signin-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? 'signin-email-error' : undefined}
        />
        {emailError ? (
          <p className="field-error" id="signin-email-error" role="alert">
            {emailError}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="signin-password">Password</label>
        <input
          id="signin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={passwordError ? true : undefined}
          aria-describedby={passwordError ? 'signin-password-error' : undefined}
        />
        {passwordError ? (
          <p className="field-error" id="signin-password-error" role="alert">
            {passwordError}
          </p>
        ) : null}
      </div>

      <button className="primary" type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
