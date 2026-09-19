'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { signUpAction, type AuthFormState } from '@/app/actions/auth';
import type { Role } from '@/lib/users';

const initialState: AuthFormState = {};

const pathways: { value: Role; label: string; hint: string }[] = [
  {
    value: 'applicant',
    label: "I'm looking for a role",
    hint: 'Your agent finds roles, tailors your materials, and verifies employers before sending anything.',
  },
  {
    value: 'employer',
    label: "I'm hiring",
    hint: 'Your agent publishes roles and verifies that inbound applicant agents are who they claim to be.',
  },
];

export function SignUpForm({ role }: { role?: Role }) {
  const [state, action, pending] = useActionState(signUpAction, initialState);
  const nameError = state.fieldErrors?.name;
  const emailError = state.fieldErrors?.email;
  const passwordError = state.fieldErrors?.password;
  const roleError = state.fieldErrors?.role;

  // The landing page already asked which pathway you're on, so don't ask twice.
  // Arriving with ?role=… locks the choice to a hidden field; only a direct visit
  // to /signup (no role) still has to pick one.
  const chosen = pathways.find((pathway) => pathway.value === role);

  return (
    <form action={action} className="auth-form" noValidate>
      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      {chosen ? (
        <div className="role-locked">
          <input type="hidden" name="role" value={chosen.value} />
          <p>
            <strong>{chosen.label}</strong>
            <small>{chosen.hint}</small>
          </p>
          <Link href="/signup">Change</Link>
        </div>
      ) : (
        /* aria-describedby is global, aria-invalid is not supported on a group —
           so the error is announced via role="alert" and linked, not flagged. */
        <fieldset
          className="role-options"
          aria-describedby={roleError ? 'signup-role-error' : undefined}
        >
          <legend>Which describes you?</legend>
          {pathways.map((pathway) => (
            <label className="role-option" key={pathway.value} htmlFor={`role-${pathway.value}`}>
              <input
                id={`role-${pathway.value}`}
                type="radio"
                name="role"
                value={pathway.value}
                required
              />
              <span>
                <strong>{pathway.label}</strong>
                <small>{pathway.hint}</small>
              </span>
            </label>
          ))}
          {roleError ? (
            <p className="field-error" id="signup-role-error" role="alert">
              {roleError}
            </p>
          ) : null}
        </fieldset>
      )}

      <div className="field">
        <label htmlFor="signup-name">Name</label>
        <input
          id="signup-name"
          name="name"
          type="text"
          autoComplete="name"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'signup-name-error' : undefined}
        />
        {nameError ? (
          <p className="field-error" id="signup-name-error" role="alert">
            {nameError}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="signup-email">Email</label>
        <input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? 'signup-email-error' : undefined}
        />
        {emailError ? (
          <p className="field-error" id="signup-email-error" role="alert">
            {emailError}
          </p>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="signup-password">Password</label>
        <input
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={passwordError ? true : undefined}
          aria-describedby={
            passwordError ? 'signup-password-error signup-password-hint' : 'signup-password-hint'
          }
        />
        <p className="field-hint" id="signup-password-hint">
          At least 8 characters.
        </p>
        {passwordError ? (
          <p className="field-error" id="signup-password-error" role="alert">
            {passwordError}
          </p>
        ) : null}
      </div>

      <button className="primary" type="submit" disabled={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
