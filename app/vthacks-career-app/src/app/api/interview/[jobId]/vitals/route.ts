/**
 * POST /api/interview/[jobId]/vitals — webcam frames in, a steadiness read out.
 *
 *   POST multipart/form-data:
 *     sessionId  = the interview session id
 *     timestamps = JSON array of capture times in microseconds, one per frame
 *     frame      = one JPEG per captured frame, repeated, in timestamp order
 *
 *     200 -> { ok: true, latest, summary, accepted, skipped }
 *     200 -> { ok: false, reason } when Presage is off — NOT an error
 *     403 -> the stage gate closed since the room opened
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT. Presage SmartSpectra reads pulse, breathing
 * and expression off ordinary camera frames. Their own documentation says the metrics
 * are for general wellness only and are not FDA cleared. So this produces a NERVES
 * READ THE STUDENT SEES ABOUT THEMSELVES during their own practice session. It is
 * never a score, it never reaches an employer, and the only thing persisted is the
 * session aggregate on the closing telemetry row. See the header of src/lib/presage.ts,
 * including the note that CLAUDE.md's "Presage: out of scope" was reversed for this
 * feature and this feature only.
 *
 * NO FRAME IS EVER STORED. Frames are decoded, pushed into the measurement, and
 * dropped inside this request. Nothing writes an image anywhere, and there is no code
 * path in this repo that could.
 *
 * BATCHED, NOT STREAMED. Next's App Router has no WebSocket, and a request per frame
 * at any useful rate would be hundreds of requests a minute. The room posts about a
 * second of frames at a time, which keeps the wire honest and the reading current
 * enough for a panel that updates once a second.
 */
import { NextResponse } from 'next/server';

import { currentStage, logEvent } from '@/lib/interview';
import { interviewUnlocked, lockedReason } from '@/lib/interview-contract';
import { closeVitals, MAX_FRAME_BYTES, PresageError, pushFrames, vitalsReady } from '@/lib/presage';
import { requireRole } from '@/lib/session';

/** Dynamically imports a native module. Never the edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Decoding a second of JPEG in pure JS, plus the SDK's own work. */
export const maxDuration = 60;

/** About two seconds at the room's capture rate. A guard against a runaway client. */
const MAX_FRAMES_PER_BATCH = 40;

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);

  if (!vitalsReady()) {
    return NextResponse.json({
      ok: false,
      reason: 'The steadiness read is not switched on here. Your camera is still running locally for the self-view.',
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
    return NextResponse.json({ error: 'Body must be multipart/form-data.' }, { status: 400 });
  }

  const sessionId = form.get('sessionId');
  if (typeof sessionId !== 'string' || !sessionId.startsWith('interview:')) {
    return NextResponse.json({ error: 'sessionId must be an interview session id.' }, { status: 400 });
  }

  // A `close` batch carries no frames: it ends the measurement and returns the final
  // summary, so an SDK instance does not sit open until the idle reaper finds it.
  if (form.get('close') === '1') {
    const summary = await closeVitals(sessionId);
    void logEvent(user.id, decoded, sessionId, 'interview_vitals', 'closed', {
      samples: summary.samples,
      usable: summary.usable,
    });
    return NextResponse.json({ ok: true, latest: null, summary, accepted: 0, skipped: 0 });
  }

  // `File`, not `Blob`: the DOM lib types FormData entries as string | File, and a
  // File IS a Blob, so everything below reads it as one.
  const blobs = form.getAll('frame').filter((entry): entry is File => entry instanceof Blob);
  if (blobs.length === 0) {
    return NextResponse.json({ error: 'No frames in the batch.' }, { status: 400 });
  }
  if (blobs.length > MAX_FRAMES_PER_BATCH) {
    return NextResponse.json({ error: `A batch may carry at most ${MAX_FRAMES_PER_BATCH} frames.` }, { status: 413 });
  }

  const timestamps = parseTimestamps(form.get('timestamps'), blobs.length);

  try {
    const frames = await Promise.all(
      blobs.map(async (blob, index) => {
        // Oversized frames are dropped here rather than buffered: the point of the
        // guard is to not hold the memory in the first place.
        if (blob.size > MAX_FRAME_BYTES) return { jpeg: new Uint8Array(), timestampUs: timestamps[index] };
        return { jpeg: new Uint8Array(await blob.arrayBuffer()), timestampUs: timestamps[index] };
      }),
    );

    const result = await pushFrames(sessionId, frames);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof PresageError) {
      // The "key set, module not installed" case. Said plainly once rather than on
      // every batch: the room stops posting frames as soon as it sees ok:false.
      console.error('[interview] presage unavailable:', error.message);
      return NextResponse.json({
        ok: false,
        reason: 'The steadiness read could not start on this server. Everything else in the room is unaffected.',
      });
    }
    console.error('[interview] vitals batch failed:', (error as Error).message);
    return NextResponse.json({
      ok: false,
      reason: 'The steadiness read dropped out. Everything else in the room is unaffected.',
    });
  }
}

/**
 * Capture times in microseconds, one per frame.
 *
 * A missing or malformed list is filled from the clock rather than refused: a
 * measurement with slightly wrong frame times degrades, and a 400 in the middle of
 * an interview because a timestamp array was short does not.
 */
function parseTimestamps(raw: FormDataEntryValue | null, count: number): number[] {
  const now = Date.now() * 1000;
  let parsed: unknown = null;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const list = Array.isArray(parsed) ? parsed : [];
  return Array.from({ length: count }, (_, index) => {
    const value = Number(list[index]);
    return Number.isFinite(value) && value > 0 ? value : now + index * 33_333;
  });
}
