/**
 * POST /api/interview/[jobId]/transcribe — spoken answer in, text out. ElevenLabs Scribe.
 *
 *   POST multipart/form-data: audio=<blob>, sessionId=<id>
 *     200 -> { ok: true, text, seconds, empty: boolean }
 *     200 -> { ok: false, reason } when Scribe is not configured — NOT an error
 *     413 -> the recording is past the size limit
 *
 * WHY THE UNCONFIGURED CASE IS A 200. The room asks for this only after the student
 * has already spoken, and the recording exists by then. Answering 500 would put a
 * red failure in front of someone who did nothing wrong; answering 200 with a reason
 * lets the room say "speech-to-text is off here, your answer is in the box, edit it
 * and send" and keep the interview moving. The same judgement as the voice session
 * route's `unavailableReason`.
 *
 * THE AUDIO IS NOT STORED. It is streamed to Scribe and dropped. What gets kept is
 * the text, in `voice_turns`, exactly like a typed answer — a recording of someone's
 * voice is a heavier thing to hold than a transcript of it, and nothing in the
 * feature needs it.
 */
import { NextResponse } from 'next/server';

import { currentStage } from '@/lib/interview';
import { interviewUnlocked, lockedReason } from '@/lib/interview-contract';
import { requireRole } from '@/lib/session';
import { MAX_AUDIO_BYTES, sttReady, transcribe } from '@/lib/scribe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A long answer, uploaded on hotel wifi, transcribed by a cold API. */
export const maxDuration = 120;

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);

  if (!sttReady()) {
    return NextResponse.json({
      ok: false,
      reason: 'Speech-to-text is not switched on here. Your answer is in the box below — edit it and send it.',
    });
  }

  const stage = await currentStage(user.id, decoded);
  if (!interviewUnlocked(stage)) {
    return NextResponse.json({ error: lockedReason(stage) }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Body must be multipart/form-data with an "audio" part.' }, { status: 400 });
  }

  const audio = form.get('audio');
  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: 'No "audio" part in the request.' }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: `That recording is ${Math.round(audio.size / 1_000_000)} MB, which is past the limit.` },
      { status: 413 },
    );
  }

  try {
    // The extension matters to the API's format sniffing; MediaRecorder gives us
    // webm/opus in every browser we support.
    const { text, seconds } = await transcribe(audio, 'answer.webm');
    // `seconds` is measured from the last word's end timestamp, not from how long
    // the student held the record button down. See src/lib/scribe.ts.
    return NextResponse.json({ ok: true, text, seconds, empty: text.length === 0 });
  } catch (error) {
    // Full detail server-side, a sentence for the browser: the upstream body echoes
    // request detail and sometimes the organisation name.
    console.error('[interview] scribe failed:', (error as Error).message);
    return NextResponse.json({
      ok: false,
      reason: 'That recording could not be transcribed. Type the answer instead and carry on.',
    });
  }
}
