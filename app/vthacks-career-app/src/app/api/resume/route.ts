/**
 * POST /api/resume — upload a resume PDF, get the structured profile back.
 *
 * multipart/form-data with a `resume` file part.
 *
 * This exists alongside the server action because the ElevenLabs tool router needs
 * a real HTTP endpoint to call. Both go through ingestDocument(), so voice and form
 * cannot drift apart — "everything you can say, you can type" has to be true at the
 * API layer or it is not true at all.
 *
 * Node runtime, never cached: extraction uses Buffer and PDF.js and may cold-start
 * a warehouse.
 */
import { NextResponse } from 'next/server';

import { ingestDocument } from '@/lib/intake';
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

  const result = await ingestDocument({ userId: user.id, kind: 'resume_pdf', file });
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
