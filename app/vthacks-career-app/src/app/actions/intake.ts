'use server';

/**
 * Server actions for the two intake pages.
 *
 * Shaped for React 19 `useActionState`: (prevState, formData) => nextState. The
 * forms post to these directly, so intake works without client JavaScript — which
 * matters for an app whose whole thesis is that it stays usable under assistive
 * technology.
 *
 * Every action resolves the user from the session itself. The userId is never a
 * form field: a hidden input saying whose profile to write would be trivially
 * forgeable.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  skipIntake,
  stageDocument,
  stageDocumentDeferred,
  stageLinkedInUrlDeferred,
  validateExportUpload,
  validateUpload,
} from '@/lib/intake';
import { requireRole } from '@/lib/session';

/**
 * Both actions only ever STAGE and advance. Nothing here calls a model, so neither
 * page can leave the user watching a disabled button — the reading happens once,
 * afterwards, on the dashboard itself, where the progress log is rendered in place.
 *
 * The only state worth rendering is therefore a validation failure the user has to
 * act on. Success is a redirect.
 *
 * `field` exists for accessibility, not decoration. The LinkedIn step now has two
 * controls, so a bare message would leave a screen-reader user with "that needs to
 * be a LinkedIn profile URL" and no idea which of the two inputs carries
 * aria-invalid. Omitted means "not attributable to one field".
 */
export type IntakeField = 'resume' | 'linkedinUrl' | 'linkedinExport';

export type IntakeState =
  | { status: 'error'; message: string; field?: IntakeField }
  | null;

/**
 * linkedin.com/in/<slug>. Deliberately narrow: a silently-saved typo is worse than
 * a rejection, because nothing downstream will ever tell the user it was wrong.
 * Accepts an optional www/locale subdomain and a trailing slash.
 */
const linkedInUrl = z
  .string()
  .trim()
  .min(1, 'Paste your LinkedIn profile URL.')
  .transform((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          /(^|\.)linkedin\.com$/i.test(url.hostname) && /^\/in\/[^/]+\/?$/.test(url.pathname)
        );
      } catch {
        return false;
      }
    },
    'That needs to be a LinkedIn profile URL, like https://www.linkedin.com/in/your-name',
  );

export async function uploadResumeAction(
  _prev: IntakeState,
  formData: FormData,
): Promise<IntakeState> {
  const user = await requireRole('applicant');

  // THE RESUME CANNOT BE SKIPPED, and that is enforced here rather than by leaving a
  // button out of the form. It is the only thing intake collects (see intakeGate) and
  // the only source of skills, roles and coursework, so a skipped resume leaves the
  // matcher with nothing to match on and every downstream screen empty. A step that a
  // crafted POST can walk past is not a required step, so `intent=skip` is not honoured
  // for this kind at all — it falls through to the same "choose a PDF" answer as an
  // empty submit.
  //
  // skipIntake() is untouched and still used by linkedInAction, which IS optional.

  const candidate = formData.get('resume');
  const file = candidate instanceof File ? candidate : null;
  const invalid = validateUpload(file);
  if (invalid || !file) {
    return { status: 'error', message: invalid ?? 'Choose a PDF to upload.', field: 'resume' };
  }

  // Returns as soon as the bytes are durable; the catalogue writes finish in the
  // background so Next is not held on a cold warehouse.
  const result = await stageDocumentDeferred({ userId: user.id, kind: 'resume_pdf', file });
  if (!result.ok) return { status: 'error', message: result.error, field: 'resume' };

  redirect('/applicant');
}

/**
 * LinkedIn step: a required URL, and an OPTIONAL data export.
 *
 * The two are staged as two documents ('linkedin_url' and 'linkedin_export_pdf')
 * rather than one, because they are different kinds of evidence with different
 * confidence and different failure modes — the URL is a link we display, the export
 * is a file we parse — and intake_documents already keys on (user_id, kind).
 *
 * ORDER MATTERS. The URL is validated and staged FIRST. If a 40 MB export blows up
 * on the Volume write, the thing the user actually typed is already durable and the
 * only thing they have to retry is the file.
 *
 * The export never blocks the step. It is optional, so a rejected file returns a
 * message and keeps them on the page to try again; it does not lose the URL.
 */
export async function linkedInAction(_prev: IntakeState, formData: FormData): Promise<IntakeState> {
  const user = await requireRole('applicant');

  if (formData.get('intent') === 'skip') {
    const result = await skipIntake(user.id, 'linkedin_url');
    if (!result.ok) return { status: 'error', message: result.error };
    revalidatePath('/applicant/profile');
    redirect('/applicant');
  }

  const parsed = linkedInUrl.safeParse(String(formData.get('linkedinUrl') ?? ''));
  if (!parsed.success) {
    return {
      status: 'error',
      message: parsed.error.issues[0]?.message ?? 'That URL is not valid.',
      field: 'linkedinUrl',
    };
  }

  // An empty file input still posts a File, with size 0. That is "no export", not a
  // validation failure — the field is optional and must stay silent when unused.
  const candidate = formData.get('linkedinExport');
  const exportFile = candidate instanceof File && candidate.size > 0 ? candidate : null;
  if (exportFile) {
    const invalid = validateExportUpload(exportFile);
    if (invalid) return { status: 'error', message: invalid, field: 'linkedinExport' };
  }

  // One round-trip, not two: the insert is awaited because the dashboard gate reads
  // it, the cleanup finishes in the background.
  const result = await stageLinkedInUrlDeferred(user.id, parsed.data);
  if (!result.ok) return { status: 'error', message: result.error, field: 'linkedinUrl' };

  if (exportFile) {
    // NOT the deferred variant, unlike the resume above. This is the last screen:
    // the redirect lands on /applicant, which starts the analysis immediately. The
    // resume can afford a background insert because the LinkedIn screen sits in
    // front of it; an export whose row has not landed yet would simply be missing
    // from the read, and the user would never know it was ignored.
    const stored = await stageDocument({
      userId: user.id,
      kind: 'linkedin_export_pdf',
      file: exportFile,
    });
    // The URL is saved either way, so this reports the file problem and keeps them
    // here rather than silently advancing with the export missing.
    if (!stored.ok) {
      return {
        status: 'error',
        message: `Your URL is saved, but the export did not upload: ${stored.error}`,
        field: 'linkedinExport',
      };
    }
  }

  revalidatePath('/applicant/profile');
  // Collection is finished. Everything staged gets read together on the next page.
  redirect('/applicant');
}
