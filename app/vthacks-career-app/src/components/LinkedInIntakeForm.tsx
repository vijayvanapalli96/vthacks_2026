'use client';

/**
 * LinkedIn: a URL, an optional data export, or skip.
 *
 * TWO INPUTS, BECAUSE A URL IS NOT PROFILE DATA. LinkedIn has no public profile API
 * and blocks anonymous requests, so the URL alone can only ever be displayed and
 * passed on (docs/DATA_MODEL.md §4). The export — the archive from
 * *Settings → Data privacy → Get a copy of your data* — is the file that actually
 * produces roles, skills and schools, and it is the user's own data to hand over.
 * The copy says which one does what, because an optional field with no stated
 * benefit is a field nobody fills in.
 *
 * Validation is server-side (the zod schema and validateExportUpload in the action)
 * so it cannot be bypassed, but the URL input is typed as a URL and the file input
 * carries `accept` so the browser helps before a round trip.
 *
 * ACCESSIBILITY. Each control has a real <label htmlFor>, its own hint wired through
 * aria-describedby, and aria-invalid driven by which field the server blamed — so a
 * screen-reader user hears the error on the control that caused it rather than
 * hunting between two. The error region is role="alert" and referenced from the
 * offending field. No autoFocus: the eslint config bans it, and correctly.
 */
import { useActionState } from 'react';

import { linkedInAction, type IntakeState } from '@/app/actions/intake';

export function LinkedInIntakeForm() {
  const [state, action, pending] = useActionState<IntakeState, FormData>(linkedInAction, null);
  const invalid = state?.status === 'error';
  // An error with no field named is shown but attributed to neither control, rather
  // than blamed on whichever one happens to be first.
  const urlInvalid = invalid && state?.field === 'linkedinUrl';
  const exportInvalid = invalid && state?.field === 'linkedinExport';

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
          aria-invalid={urlInvalid}
          aria-describedby={urlInvalid ? 'linkedin-hint linkedin-error' : 'linkedin-hint'}
        />
        <small id="linkedin-hint">
          Open your profile and copy the address bar — it looks like linkedin.com/in/your-name. I
          save it and show it, but I cannot read the page: LinkedIn blocks that.
        </small>
      </div>

      <div className="field">
        <label htmlFor="linkedinExport">Optional — upload your LinkedIn data export</label>
        <input
          id="linkedinExport"
          name="linkedinExport"
          type="file"
          accept=".zip,.csv,.pdf,application/zip,text/csv,application/pdf"
          disabled={pending}
          aria-invalid={exportInvalid}
          aria-describedby={
            exportInvalid ? 'linkedin-export-hint linkedin-error' : 'linkedin-export-hint'
          }
        />
        <small id="linkedin-export-hint">
          This is the part that fills in your roles, skills and schools. On LinkedIn go to Settings
          → Data privacy → Get a copy of your data, then drop the .zip here — or a single .csv from
          it, or your profile saved as a PDF. Up to 10 MB. Skip it and I will still try to find what
          the public web says about you, but that is a guess and it is recorded as one.
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
