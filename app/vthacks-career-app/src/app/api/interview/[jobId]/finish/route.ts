/**
 * POST /api/interview/[jobId]/finish — end the rehearsal, get the readout.
 *
 *   POST { sessionId, answers: InterviewAnswer[], vitals: VitalsSummary }
 *     200 -> { ok: true, feedback }
 *     400 -> a malformed body
 *     403 -> the stage gate closed since the room opened
 *
 * THIS IS WHERE `interview_feedback` FINALLY GETS PRODUCED. voice-contract.ts has
 * carried that action kind since the actor rewrite with a comment saying the
 * interviewer persona was a separate feature and nothing reached it yet. The readout
 * is written to `voice_turns` as a role='action' row with that kind, so it shows up
 * in the transcript panel next to every other thing the system has done for this
 * student, rather than in a feature-shaped silo.
 *
 * THE SERVER RE-COMPUTES THE FEEDBACK. The room already showed a critique per answer
 * as it went, but the summary is built here from the answers as posted. One writer,
 * so the paragraph stored in the transcript is the paragraph the student read.
 *
 * VITALS ARE TAKEN FROM THE SERVER'S OWN MEASUREMENT when there is one, and from the
 * body only as a fallback for a process that restarted. A client-asserted heart rate
 * is not evidence of anything, and this is the one number in the feature a person
 * might be tempted to screenshot.
 */
import { NextResponse } from 'next/server';

import { buildFeedback, currentStage, logFeedback, recallQuestions } from '@/lib/interview';
import {
  emptyVitals,
  interviewUnlocked,
  isAnswerSource,
  lockedReason,
  type InterviewAnswer,
  type InterviewFinishRequest,
  type VitalsSummary,
} from '@/lib/interview-contract';
import { closeVitals } from '@/lib/presage';
import { requireRole } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_ANSWER_CHARS = 8_000;

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);

  let body: Partial<InterviewFinishRequest>;
  try {
    body = (await request.json()) as Partial<InterviewFinishRequest>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON: { sessionId, answers, vitals }' }, { status: 400 });
  }

  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.startsWith('interview:')) {
    return NextResponse.json({ error: 'sessionId must be an interview session id.' }, { status: 400 });
  }

  const stage = await currentStage(user.id, decoded);
  if (!interviewUnlocked(stage)) {
    return NextResponse.json({ error: lockedReason(stage) }, { status: 403 });
  }

  const questions = recallQuestions(sessionId);
  if (!questions) {
    return NextResponse.json(
      { error: 'This server no longer holds that session. Your answers are already in the transcript.' },
      { status: 400 },
    );
  }

  const answers = normaliseAnswers(body.answers);

  // The measurement is closed here whether or not the client told us to: an
  // interview that ended is an SDK instance that should not stay open.
  const measured = await closeVitals(sessionId);
  const vitals = measured.usable > 0 ? measured : coerceVitals(body.vitals);

  const feedback = buildFeedback(questions, answers, vitals);

  // Awaited, unlike the per-turn write: this is the artefact of the whole session
  // and the student is looking at a "saving" state, not waiting to speak.
  try {
    await logFeedback({ userId: user.id, jobId: decoded, sessionId, feedback });
  } catch (error) {
    // The readout is still returned. Losing the row is worse than losing nothing,
    // and pretending the interview failed would be worse than both.
    console.error('[interview] feedback write failed:', (error as Error).message);
  }

  return NextResponse.json({ ok: true, feedback });
}

function normaliseAnswers(raw: unknown): InterviewAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): InterviewAnswer[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.questionId !== 'string' || typeof record.text !== 'string') return [];
    const seconds = Number(record.spokenSeconds);
    return [
      {
        questionId: record.questionId,
        text: record.text.slice(0, MAX_ANSWER_CHARS),
        source: isAnswerSource(record.source) ? record.source : 'typed',
        spokenSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null,
      },
    ];
  });
}

/** Only ever reached after a restart. Bounded to plausible ranges, never trusted blindly. */
function coerceVitals(raw: unknown): VitalsSummary {
  if (!raw || typeof raw !== 'object') return emptyVitals();
  const record = raw as Record<string, unknown>;
  const bpm = (value: unknown): number | null => {
    const parsed = Number(value);
    // The SDK's own valid range. Anything outside it is noise or a client inventing.
    return Number.isFinite(parsed) && parsed >= 40 && parsed <= 110 ? parsed : null;
  };
  const breathing = Number(record.meanBreathingBpm);
  return {
    meanPulseBpm: bpm(record.meanPulseBpm),
    peakPulseBpm: bpm(record.peakPulseBpm),
    meanBreathingBpm: Number.isFinite(breathing) && breathing >= 5 && breathing <= 40 ? breathing : null,
    expressions: Array.isArray(record.expressions)
      ? record.expressions.filter((item): item is string => typeof item === 'string').slice(0, 3)
      : [],
    samples: Math.max(0, Math.min(Number(record.samples) || 0, 100_000)),
    usable: Math.max(0, Math.min(Number(record.usable) || 0, 100_000)),
  };
}
