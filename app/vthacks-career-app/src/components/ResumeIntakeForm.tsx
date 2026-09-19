'use client';

/**
 * Resume upload, or skip. Stores the file and moves on — it does NOT read it.
 *
 * The pending state is short (an upload, not a model call), which is why the button
 * says "Next" and not "Read my resume": promising a read here would be a lie, and the
 * reading step has its own page where the wait is visible and explained.
 *
 * Upload and skip share ONE action on purpose: giving the skip button its own
 * `formAction` would bypass the useActionState reducer, so the UI would never
 * re-render with a skip failure. The intent rides in as the submit button's own
 * name/value pair.
 */
import { useActionState } from 'react';

import { uploadResumeAction, type IntakeState } from '@/app/actions/intake';

export function ResumeIntakeForm() {
  const [state, action, pending] = useActionState<IntakeState, FormData>(uploadResumeAction, null);
  const invalid = state?.status === 'error';

  return (
    <form action={action} className="intake-form" aria-busy={pending}>
      <div className="field">
        <label htmlFor="resume">Your resume, as a PDF</label>
        <input
          id="resume"
          name="resume"
          type="file"
          accept="application/pdf,.pdf"
          disabled={pending}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'resume-hint resume-error' : 'resume-hint'}
        />
        <small id="resume-hint">Up to 10 MB.</small>
      </div>

      <div className="actions">
        <button className="primary" type="submit" name="intent" value="upload" disabled={pending}>
          {pending ? 'Saving…' : 'Next'}
        </button>
        <button className="ghost" type="submit" name="intent" value="skip" disabled={pending}>
          Skip for now
        </button>
      </div>

      {/* Politely announced so a screen-reader user hears progress they cannot see. */}
      <p className="status" role="status">
        {pending ? 'Storing your file.' : ''}
      </p>

      {invalid && (
        <p id="resume-error" className="outcome outcome-error" role="alert">
          {state?.message}
        </p>
      )}
    </form>
  );
}
