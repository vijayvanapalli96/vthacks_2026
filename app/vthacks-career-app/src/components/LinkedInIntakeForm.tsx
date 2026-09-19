'use client';

/**
 * LinkedIn profile URL, or skip.
 *
 * Validation is server-side (the zod schema in the action) so it cannot be
 * bypassed, but the input is also typed as a URL with a pattern hint so the browser
 * helps before a round trip. aria-invalid is driven by the server result.
 */
import { useActionState } from 'react';

import { linkedInAction, type IntakeState } from '@/app/actions/intake';

export function LinkedInIntakeForm() {
  const [state, action, pending] = useActionState<IntakeState, FormData>(linkedInAction, null);
  const invalid = state?.status === 'error';

  return (
    <form action={action} className="intake-form" aria-busy={pending}>
      <div className="field">
        <label htmlFor="linkedinUrl">Your LinkedIn profile URL</label>
        <input
          id="linkedinUrl"
          name="linkedinUrl"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://www.linkedin.com/in/your-name"
          disabled={pending}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'linkedin-hint linkedin-error' : 'linkedin-hint'}
        />
        <small id="linkedin-hint">
          Open your profile and copy the address bar — it looks like linkedin.com/in/your-name.
        </small>
      </div>

      <div className="actions">
        <button className="primary" type="submit" name="intent" value="save" disabled={pending}>
          {pending ? 'Saving…' : 'Next'}
        </button>
        <button className="ghost" type="submit" name="intent" value="skip" disabled={pending}>
          Skip for now
        </button>
      </div>

      <p className="status" role="status">
        {pending ? 'Saving your profile URL.' : ''}
      </p>

      {/* Success redirects to the reading step, so the only thing left to render is a
          validation failure the user has to act on. */}
      {invalid && (
        <p id="linkedin-error" className="outcome outcome-error" role="alert">
          {state?.message}
        </p>
      )}
    </form>
  );
}
