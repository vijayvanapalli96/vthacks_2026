'use client';

/**
 * Resume upload, or skip.
 *
 * Upload and skip share ONE action on purpose: giving the skip button its own
 * `formAction` would bypass the useActionState reducer, so the UI would never
 * re-render with the skip result. The intent rides in as the submit button's own
 * name/value pair.
 */
import { useActionState } from 'react';

import { uploadResumeAction, type IntakeState } from '@/app/actions/intake';

import { IntakeOutcome } from './IntakeOutcome';

export function ResumeIntakeForm() {
  const [state, action, pending] = useActionState<IntakeState, FormData>(uploadResumeAction, null);

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
          aria-describedby="resume-hint"
        />
        <small id="resume-hint">Up to 10 MB. Two-column layouts are fine.</small>
      </div>

      <div className="actions">
        <button className="primary" type="submit" name="intent" value="upload" disabled={pending}>
          {pending ? 'Reading your resume…' : 'Read my resume'}
        </button>
        <button className="ghost" type="submit" name="intent" value="skip" disabled={pending}>
          Skip for now
        </button>
      </div>

      {/* Politely announced so a screen-reader user hears progress they cannot see. */}
      <p className="status" role="status">
        {pending ? 'Uploading and extracting. This can take up to half a minute.' : ''}
      </p>

      <IntakeOutcome state={state} nextHref="/applicant/intake/linkedin" nextLabel="Next: LinkedIn" />
    </form>
  );
}
