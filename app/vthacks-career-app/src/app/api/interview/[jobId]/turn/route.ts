/**
 * POST /api/interview/[jobId]/turn — one answer, critiqued and logged.
 *
 *   POST { sessionId, questionId, text, source, spokenSeconds?, question? }
 *     200 -> { ok: true, critique, next }
 *     400 -> a malformed body, WITH what was wrong
 *     403 -> the stage gate closed since the room opened
 *
 * THE CRITIQUE IS COMPUTED, NOT GENERATED. src/lib/interview.ts counts words, pace,
 * first person, whether a number appears, and which of the question's own "strong
 * answer" points went untouched. No model call, so it is fast enough to show between
 * questions and checkable by the student reading their own answer.
 *
 * THE GATE IS RE-CHECKED HERE. The room could have been open in a tab since before
 * the student marked the role rejected. Checking only at session build would let a
 * closed application keep appending turns.
 *
 * WRITING THE TURN IS BEST-EFFORT. The transcript write goes to a warehouse that
 * cold-starts in 20-30 seconds, and blocking the next question on it would make the
 * interview feel broken for a row that is a record rather than the product. A failed
 * write is logged server-side and the critique still comes back.
 */
import { NextResponse } from 'next/server';

import {
  critique,
  currentStage,
  isInterviewSessionId,
  logExchange,
  recallQuestions,
} from '@/lib/interview';
import {
  interviewUnlocked,
  isAnswerSource,
  isQuestionKind,
  lockedReason,
  type InterviewQuestion,
  type InterviewTurnRequest,
} from '@/lib/interview-contract';
import { requireRole } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** An answer longer than this is a paste accident. Truncated, not refused. */
const MAX_ANSWER_CHARS = 8_000;

type Body = Partial<InterviewTurnRequest> & { question?: unknown };

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const user = await requireRole('applicant');
  const { jobId } = await params;
  const decoded = decodeURIComponent(jobId);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON: { sessionId, questionId, text, source }' }, { status: 400 });
  }

  if (!isInterviewSessionId(body.sessionId)) {
    return NextResponse.json({ error: 'sessionId must be an interview session id.' }, { status: 400 });
  }
  if (typeof body.questionId !== 'string' || !body.questionId.trim()) {
    return NextResponse.json({ error: 'questionId is required.' }, { status: 400 });
  }
  if (typeof body.text !== 'string') {
    return NextResponse.json({ error: 'text is required, and may be an empty string for a skip.' }, { status: 400 });
  }
  const source = isAnswerSource(body.source) ? body.source : 'typed';

  const stage = await currentStage(user.id, decoded);
  if (!interviewUnlocked(stage)) {
    return NextResponse.json({ error: lockedReason(stage) }, { status: 403 });
  }

  const questions = recallQuestions(body.sessionId);
  const question =
    questions?.find((item) => item.id === body.questionId) ?? clientQuestion(body.question, body.questionId);
  if (!question) {
    return NextResponse.json(
      { error: 'That question is not part of this session, and this server no longer holds the set.' },
      { status: 400 },
    );
  }

  const answer = {
    questionId: question.id,
    text: body.text.slice(0, MAX_ANSWER_CHARS),
    source,
    spokenSeconds:
      typeof body.spokenSeconds === 'number' && Number.isFinite(body.spokenSeconds)
        ? Math.max(0, Math.round(body.spokenSeconds))
        : null,
  };

  const result = critique(question, answer);

  // Fire and forget, with its own catch. See the header.
  void logExchange({ userId: user.id, sessionId: body.sessionId, question, answer }).catch((error: Error) => {
    console.error('[interview] transcript write failed:', error.message);
  });

  const index = questions?.findIndex((item) => item.id === question.id) ?? -1;
  const next = index >= 0 && questions ? (questions[index + 1] ?? null) : null;

  return NextResponse.json({ ok: true, critique: result, next });
}

/**
 * Accept a question the client supplied, when this process no longer holds the set.
 *
 * Only reachable after a restart mid-interview. See the questionStore comment in
 * src/lib/interview.ts for why letting the client shape its own critique is the
 * right trade here and where the limit is.
 */
function clientQuestion(raw: unknown, questionId: string): InterviewQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;
  return {
    id: questionId,
    kind: isQuestionKind(record.kind) ? record.kind : 'experience',
    text,
    because: typeof record.because === 'string' ? record.because : '',
    looksLike: Array.isArray(record.looksLike)
      ? record.looksLike.filter((item): item is string => typeof item === 'string').slice(0, 3)
      : [],
  };
}
