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
  stageDocumentDeferred,
  stageLinkedInUrlDeferred,
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
 */
export type IntakeState = { status: 'error'; message: string } | null;

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

  // The row must land BEFORE the redirect. intakeState() reads these rows to
  // decide where to send people, so skipping without writing one would loop the user
  // back to this page forever.
  if (formData.get('intent') === 'skip') {
    const result = await skipIntake(user.id, 'resume_pdf');
    if (!result.ok) return { status: 'error', message: result.error };
    redirect('/applicant/intake/linkedin');
  }

  const candidate = formData.get('resume');
  const file = candidate instanceof File ? candidate : null;
  const invalid = validateUpload(file);
  if (invalid || !file) return { status: 'error', message: invalid ?? 'Choose a PDF to upload.' };

  // Returns as soon as the bytes are durable; the catalogue writes finish in the
  // background so Next is not held on a cold warehouse.
  const result = await stageDocumentDeferred({ userId: user.id, kind: 'resume_pdf', file });
  if (!result.ok) return { status: 'error', message: result.error };

  redirect('/applicant/intake/linkedin');
}

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
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'That URL is not valid.' };
  }

  // One round-trip, not two: the insert is awaited because the dashboard gate reads
  // it, the cleanup finishes in the background.
  const result = await stageLinkedInUrlDeferred(user.id, parsed.data);
  if (!result.ok) return { status: 'error', message: result.error };

  revalidatePath('/applicant/profile');
  // Collection is finished. Everything staged gets read together on the next page.
  redirect('/applicant');
}
