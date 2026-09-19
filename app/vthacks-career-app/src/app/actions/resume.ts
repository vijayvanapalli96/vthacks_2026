'use server';

/**
 * Server actions for resume intake.
 *
 * These exist alongside /api/resume so the upload form works without JavaScript:
 * the form posts, the action runs, the page re-renders. The API route is for the
 * voice agent's tool router and anything else calling us programmatically.
 *
 * Shaped for React 19 `useActionState`: (prevState, formData) => nextState.
 */
import { getCurrentUserId } from '@/lib/current-user';
import { ingestResume, skipResume, type IntakeResult } from '@/lib/resume-intake';

export type ResumeFormState = IntakeResult | null;

/**
 * Handles both intents from the same form. Upload and skip share one action
 * deliberately: a separate `formAction` on the skip button would bypass the
 * `useActionState` reducer, so the UI would never re-render with the skip result.
 * The intent arrives as the submit button's own name/value pair.
 */
export async function uploadResumeAction(
  _prev: ResumeFormState,
  formData: FormData,
): Promise<ResumeFormState> {
  if (formData.get('intent') === 'skip') {
    return skipResume();
  }

  const candidate = formData.get('resume');
  const file = candidate instanceof File ? candidate : null;
  return ingestResume(file, getCurrentUserId());
}
