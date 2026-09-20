'use client';

/**
 * The in-flight line, naming what is ACTUALLY happening.
 *
 * THE BUG THIS EXISTS TO FIX. Both intake forms rendered `{pending ? 'Saving your
 * file…' : ''}`, and `pending` is true for whichever button was pressed. So pressing
 * "Skip for now" — which reaches `skipIntake()` and never looks at the file input —
 * displayed "Saving your file…". A user who had added a file, removed it, and then
 * skipped was told their file was being saved. Nothing was: `uploadResumeAction`
 * returns on `intent === 'skip'` before it reads `formData.get('resume')`, and an
 * emptied input posts a zero-byte File that `validateUpload` rejects anyway. The
 * report was wrong, not the write — which is the worse of the two, because it is the
 * half nobody can check.
 *
 * `useFormStatus` is what makes the honest version possible: its `data` is the
 * submitted FormData, INCLUDING the submitter's own name/value pair, so the component
 * can read which `intent` is in flight instead of guessing from a boolean. It only
 * works in a component rendered INSIDE the <form>, which is the whole reason this is
 * its own file rather than three lines in each form.
 *
 * Mounted in both states so the live region exists before it has anything to say —
 * a role="status" that appears at the same moment as its text is not reliably
 * announced.
 *
 * IT IS NOT VISIBLE. `.status-sr` clips it. A line of prose narrating a one-second
 * upload is noise for anyone who can see the form go quiet and then navigate, and it
 * was asked for as noise. It stays in the DOM because a screen-reader user CANNOT see
 * that, and `aria-busy` on the form says "something is happening" without saying what
 * — hard rule 6 is not satisfied by silence.
 */
import { useFormStatus } from 'react-dom';

type IntakeStatusProps = {
  /** The file input's name, so the line can say which file by name. */
  fileField: string;
  /** What is being saved when the form carries no file. */
  noFile: string;
};

export function IntakeStatus({ fileField, noFile }: IntakeStatusProps) {
  const { pending, data } = useFormStatus();

  if (!pending) return <p className="status-sr" role="status" />;

  if (data?.get('intent') === 'skip') {
    return (
      <p className="status-sr" role="status">
        Recording that you skipped this step. Nothing is being uploaded.
      </p>
    );
  }

  const candidate = data?.get(fileField);
  const file = candidate instanceof File && candidate.size > 0 ? candidate : null;

  return (
    <p className="status-sr" role="status">
      {file ? `Saving ${file.name}…` : noFile}
    </p>
  );
}
