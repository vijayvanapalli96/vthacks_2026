/**
 * POST /api/resume — upload a resume PDF, get a structured profile back.
 *
 * multipart/form-data with a `resume` file part.
 *
 * Node runtime (not edge): the extraction path uses Buffer and PDF.js.
 */
import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/current-user';
import { ingestResume } from '@/lib/resume-intake';

export const runtime = 'nodejs';
// Extraction calls a model and may cold-start a warehouse; never cache it.
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
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

  const result = await ingestResume(file, getCurrentUserId());

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
