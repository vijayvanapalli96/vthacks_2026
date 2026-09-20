'use client';

/**
 * Resume upload. Required, and it submits itself.
 *
 * NO BUTTONS. Adding the file IS the action, so a Next button would only ask the user to
 * confirm a decision they already made by choosing a file. `onFileChosen` fires once
 * `input.files` is populated, and requestSubmit() then posts the same FormData the
 * button used to. There is no second code path: `uploadResumeAction` cannot tell the
 * difference.
 *
 * requestSubmit() and NOT submit(): the latter bypasses the submit event entirely, which
 * is the event React 19 listens to in order to run `action`. form.submit() would do a
 * native navigation and the server action would never run.
 *
 * NO SKIP. The resume is the only thing intake collects now, and it is what produces
 * skills, roles and coursework — a skipped resume leaves the matcher with nothing to
 * match on. Enforced in `uploadResumeAction`, which no longer honours `intent=skip` for
 * this kind, not merely by leaving the button out: a required step that a crafted POST
 * can walk past is not required.
 *
 * The plate IS disabled while the submit is in flight. With no button left there is
 * nothing else to interact with, and re-entering the picker mid-upload would stage a
 * second document for the same step.
 */
import { useActionState, useCallback, useRef } from 'react';

import { uploadResumeAction, type IntakeState } from '@/app/actions/intake';
import { DropZone } from '@/components/DropZone';
import { IntakeStatus } from '@/components/IntakeStatus';

export function ResumeIntakeForm() {
  const [state, action, pending] = useActionState<IntakeState, FormData>(uploadResumeAction, null);
  const invalid = state?.status === 'error';
  const formRef = useRef<HTMLFormElement | null>(null);

  const submitNow = useCallback(() => {
    if (pending) return;
    formRef.current?.requestSubmit();
  }, [pending]);

  return (
    <form ref={formRef} action={action} className="intake-form" aria-busy={pending}>
      <DropZone
        id="resume"
        name="resume"
        accept="application/pdf,.pdf"
        label="Your resume"
        prompt="Drop your resume here."
        constraint="PDF, up to 10 MB."
        ariaLabel="Your resume, as a PDF"
        disabled={pending}
        invalid={invalid}
        /* No hint element to point at, so this is the error or nothing — an
           aria-describedby naming an id that does not exist is read as an empty
           description by some screen readers and skipped by others. */
        describedBy={invalid ? 'resume-error' : undefined}
        onFileChosen={submitNow}
      />

      <IntakeStatus fileField="resume" noFile="Saving…" />

      {/* Reachable again after a rejected file: the action returns here with the plate
          still showing it, and Replace inside the plate is how you pick another. */}
      {invalid && (
        <p id="resume-error" className="outcome outcome-error" role="alert">
          {state?.message}
        </p>
      )}
    </form>
  );
}
