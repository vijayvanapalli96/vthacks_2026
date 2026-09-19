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

import { ingestDocument, ingestLinkedInUrl, skipIntake, validateUpload } from '@/lib/intake';
import { requireRole } from '@/lib/session';

export type IntakeState = {
  status: 'idle' | 'done' | 'skipped' | 'reused' | 'error';
  message?: string;
  warnings?: string[];
  openGaps?: number;
  factsAppended?: number;
  provider?: string;
  model?: string;
} | null;

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

  if (formData.get('intent') === 'skip') {
    // The row must land BEFORE the redirect. nextIntakeStep() reads these rows to
    // decide where to send people, so skipping without writing one would loop the
    // user back to this page forever.
    const result = await skipIntake(user.id, 'resume_pdf');
    if (!result.ok) return { status: 'error', message: result.error };
    revalidatePath('/applicant/profile');
    redirect('/applicant/intake/linkedin');
  }

  const candidate = formData.get('resume');
  const file = candidate instanceof File ? candidate : null;
  const invalid = validateUpload(file);
  if (invalid || !file) return { status: 'error', message: invalid ?? 'Choose a PDF to upload.' };

  const result = await ingestDocument({ userId: user.id, kind: 'resume_pdf', file });
  if (!result.ok) return { status: 'error', message: result.error };

  revalidatePath('/applicant/profile');
  return {
    status: result.reused ? 'reused' : 'done',
    message: result.reused
      ? 'I had already read this exact file, so nothing was added twice.'
      : 'Read your resume and updated your profile.',
    warnings: result.warnings,
    openGaps: result.openGaps,
    factsAppended: result.factsAppended,
    provider: result.provider ?? undefined,
    model: result.model ?? undefined,
  };
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

  const result = await ingestLinkedInUrl(user.id, parsed.data);
  if (!result.ok) return { status: 'error', message: result.error };

  revalidatePath('/applicant/profile');
  // Last step of onboarding, so this one lands on the dashboard rather than
  // rendering an outcome panel nobody needs to read.
  redirect('/applicant');
}
