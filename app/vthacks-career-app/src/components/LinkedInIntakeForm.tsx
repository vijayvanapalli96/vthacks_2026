'use client';

/**
 * LinkedIn: just the profile URL now.
 *
 * NOT A STEP IN INTAKE. intakeGate() no longer routes here — collecting is the resume
 * and nothing else. This is an optional addition reached from /applicant/profile, and
 * all it does is save a URL to show on applications. Nothing reads the page: LinkedIn
 * has no public profile API and serves a login wall to anonymous requests.
 *
 * THE EXPORT UPLOAD IS GONE FROM THIS FORM, and with LinkedIn descoped nothing replaces
 * it — so this form currently collects a string we display and cannot act on. Say that
 * plainly rather than implying otherwise. `linkedInAction` still accepts
 * `linkedinExport` and the parser in src/lib/extract/linkedin-export.ts is untouched;
 * nothing was deleted, only removed from this screen, so restoring the field is a
 * one-component change if the data turns out to be wanted.
 *
 * Validation stays server-side (the zod schema in the action) so it cannot be
 * bypassed; the input is typed as a URL so the browser helps before a round trip.
 *
 * NOTHING IS DISABLED WHILE SAVING except the two submit buttons, and only to stop a
 * double submit. The FormData was snapshotted when the form was submitted, so nothing
 * done to the field afterwards can affect the request in flight.
 */
import Link from 'next/link';
import { useActionState } from 'react';

import { linkedInAction, type IntakeState } from '@/app/actions/intake';
import { IntakeStatus } from '@/components/IntakeStatus';

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
          aria-invalid={invalid}
          aria-describedby={invalid ? 'linkedin-error' : undefined}
        />
      </div>

      <div className="actions">
        <button className="primary" type="submit" name="intent" value="save" disabled={pending}>
          Next
        </button>
        <button className="ghost" type="submit" name="intent" value="skip" disabled={pending}>
          Skip for now
        </button>
        {/* Back to where this page is now reached FROM. It stopped being step two of
            intake, so "back to your resume" would send people somewhere they did not
            come from. */}
        <Link className="intake-back" href="/applicant/profile">
          Back to your profile
        </Link>
      </div>

      <IntakeStatus fileField="linkedinExport" noFile="Saving your profile URL…" />

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
