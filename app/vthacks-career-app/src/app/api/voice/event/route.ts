/**
 * POST /api/voice/event — `voice_events` finally gets a producer.
 *
 * The table has existed since the schema was written and has always been empty. It is
 * the answer to the one question a judge asks about an agent that acts on your behalf:
 * *what did it actually do?* Nearly free to fill, and the audit story is worth more
 * than most of the features it audits.
 *
 * WHAT COMES HERE AND WHAT DOES NOT. Actions that complete inside another endpoint —
 * resolving a job, setting a stage, recording an answer — are logged by THAT endpoint,
 * at the moment they happen, where the outcome is known for certain. This route is for
 * the actions whose work happens somewhere the log cannot reach: a match refresh that
 * ran through `POST /api/match` (a route this lane does not own), a read-out of the
 * cached list, an explanation, and the refusal the agent gives when asked to apply.
 *
 * It is a LOG, not an action. Nothing here changes a user's data, so there is no
 * "voice can do a thing the UI cannot" to worry about: the same button that performs
 * the action posts the same event.
 *
 * THE ONE THING IT VALIDATES HARD: `kind` must be a declared VoiceActionKind, and
 * `text` — the spoken reason — must be present. Hard rule 4. An action logged without
 * its reason is an audit row that cannot answer the question the table exists for.
 */
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/session';
import { conversationIdOr, logVoiceAction } from '@/lib/voice-actions';
import { safeJobId } from '@/lib/voice-brief';
import {
  isVoiceActionKind,
  type VoiceEventRequest,
  type VoiceEventResponse,
} from '@/lib/voice-contract';

export const dynamic = 'force-dynamic';

const OUTCOMES = new Set(['ok', 'refused', 'failed']);

export async function POST(request: Request) {
  const user = await requireRole('applicant');

  let body: Partial<VoiceEventRequest>;
  try {
    body = (await request.json()) as Partial<VoiceEventRequest>;
  } catch {
    return json({ ok: false, error: 'That request body was not JSON.' }, 400);
  }

  const raw = body as Record<string, unknown>;
  const kind = raw.kind;
  if (!isVoiceActionKind(kind)) {
    return json({ ok: false, error: 'kind must be one of the declared voice action kinds.' }, 400);
  }

  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) {
    // Hard rule 4, enforced rather than described.
    return json({ ok: false, error: 'An action cannot be logged without its reason string.' }, 400);
  }

  const rawOutcome = typeof raw.outcome === 'string' ? raw.outcome : 'ok';
  const outcome = (OUTCOMES.has(rawOutcome) ? rawOutcome : 'ok') as 'ok' | 'refused' | 'failed';

  // Shape-checked, not existence-checked. This is a log line, not a navigation: a stale
  // id in an audit row is a fact about what was said, whereas a stale id in
  // /api/voice/resolve would send somebody to the wrong job. Different jobs, different
  // strictness. Note that a job id here is a posting URL — see safeJobId.
  const jobId = safeJobId(raw.jobId ?? raw.job_id);

  const detail =
    raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail)
      ? (raw.detail as Record<string, unknown>)
      : undefined;

  await logVoiceAction({
    userId: user.id,
    conversationId: conversationIdOr(raw.conversationId ?? raw.conversation_id),
    kind,
    outcome,
    text: text.slice(0, 2000),
    jobId,
    detail,
  });

  return json({ ok: true }, 200);
}

function json(body: VoiceEventResponse, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
