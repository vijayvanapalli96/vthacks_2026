/**
 * POST /api/resume — upload a resume PDF, get the structured profile back.
 *
 * multipart/form-data with a `resume` file part.
 *
 * This exists alongside the server action because the ElevenLabs tool router needs a
 * real HTTP endpoint to call. Both go through stageDocument() and analyzeIntake(), so
 * voice and form cannot drift apart — "everything you can say, you can type" has to
 * be true at the API layer or it is not true at all.
 *
 * Unlike the UI, this endpoint stages AND analyses in one call, because a tool call
 * has nowhere to render a progress log: it wants the finished answer. The returned
 * `logs` array is the same sequence the processing page streams, so a voice agent can
 * narrate it if it wants to.
 *
 * Node runtime, never cached: extraction uses Buffer and PDF.js and may cold-start a
 * warehouse.
 */
import { NextResponse } from 'next/server';

import { runIntakeAnalysis, stageDocument } from '@/lib/intake';
import { requireRole } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireRole('applicant');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Send multipart/form-data with a "resume" file part.' },
      { status: 400 },
    );
  }

  const candidate = form.get('resume');
  const file = candidate instanceof File ? candidate : null;
  if (!file) {
    return NextResponse.json({ ok: false, error: 'Missing the "resume" file part.' }, { status: 400 });
  }

  const staged = await stageDocument({ userId: user.id, kind: 'resume_pdf', file });
  if (!staged.ok) return NextResponse.json(staged, { status: 422 });

  // Reused means these exact bytes were already read. Running the analysis anyway
  // would be harmless (there is no 'received' row to pick up) but reporting it as
  // fresh work would be misleading, so say so.
  if (staged.reused) {
    return NextResponse.json({
      ok: true,
      documentId: staged.documentId,
      reused: true,
      factsAppended: 0,
      logs: [],
      warning: 'This exact file had already been read, so nothing was added twice.',
    });
  }

  const summary = await runIntakeAnalysis(user.id);
  return NextResponse.json(
    {
      ok: !summary.error,
      documentId: staged.documentId,
      reused: false,
      factsAppended: summary.factsAppended,
      openGaps: summary.openGaps,
      logs: summary.logs,
      error: summary.error,
    },
    { status: summary.error ? 422 : 200 },
  );
}
