/**
 * POST /api/voice/status — "save that one", "mark it applied".
 *
 * THIS ROUTE OWNS NO TABLE, AND THAT IS THE ENTIRE POINT.
 *
 * "Saved" is not a separate concept from "applied"; it is the first stage of the
 * application pipeline, which is event-sourced onto `application_events` by the
 * pipeline lane behind `POST /api/pipeline/status`. So this route resolves the spoken
 * job reference, validates the status against a closed enum, FORWARDS to that one
 * endpoint, and logs the outcome. It does not create a `saved_jobs` table, it does not
 * write `application_events` itself, and if the pipeline route is missing it returns
 * `kind: 'blocked'` and says so out loud.
 *
 * A second store for the same fact is worse than a missing feature: two tables that
 * both claim to know whether a job is saved will disagree, and there is no way for a
 * user to tell which one the UI is reading.
 *
 * WHY A SHIM AT ALL, RATHER THAN THE BROWSER CALLING THEIRS DIRECTLY. Two things have
 * to happen server-side and cannot happen in the browser: the job reference has to be
 * resolved against the user's own cached run (the model says "the second one", and a
 * client that resolved that itself would be trusting the model — see
 * /api/voice/resolve for the same argument), and the action has to land in
 * `voice_events`. Hard rule 5 still holds: the BUTTON in the transcript panel and the
 * SPOKEN tool both post here, there is exactly one handler, and the actual status
 * write happens in exactly one place — theirs.
 *
 * `applied` RECORDS WHAT THE USER SAYS HAPPENED. It is never the agent reporting that
 * it applied. The agent cannot apply: there is no tool for it, hard rule 3 requires a
 * human confirmation, and the prompt says so in as many words.
 */
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/session';
import { cachedMatches, conversationIdOr, logVoiceAction, resolveJobRef } from '@/lib/voice-actions';
import {
  isVoiceJobStatus,
  VOICE_JOB_STATUSES,
  type VoiceStatusRequest,
  type VoiceStatusResponse,
} from '@/lib/voice-contract';

export const dynamic = 'force-dynamic';

/** The pipeline lane's route. One contract, stated identically in both plans. */
const PIPELINE_PATH = '/api/pipeline/status';

const SPOKEN: Record<string, string> = {
  saved: 'Saved',
  applied: 'Marked as applied',
  interviewing: 'Marked as interviewing',
  rejected: 'Marked as rejected',
  dismissed: 'Dismissed',
};

export async function POST(request: Request) {
  const user = await requireRole('applicant');

  let body: Partial<VoiceStatusRequest> = {};
  try {
    body = (await request.json()) as Partial<VoiceStatusRequest>;
  } catch {
    return refuse(
      'That request was not readable, so I did not change anything.',
      user.id,
      conversationIdOr(null),
    );
  }

  const raw = body as Record<string, unknown>;
  const conversationId = conversationIdOr(raw.conversationId ?? raw.conversation_id);
  const jobRef = raw.jobRef ?? raw.job_ref ?? raw.job_id;
  const status = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : 'saved';
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : undefined;

  if (!isVoiceJobStatus(status)) {
    return refuse(
      `"${status.slice(0, 40)}" is not a stage I can set. The ones I can are: ${VOICE_JOB_STATUSES.join(', ')}. Nothing was changed.`,
      user.id,
      conversationId,
    );
  }

  const { matches } = await cachedMatches(user.id);
  const resolution = resolveJobRef(matches, jobRef);
  if (!resolution.ok) return refuse(resolution.reason, user.id, conversationId);

  const match = resolution.match;

  // Forwarded with the caller's cookie so the pipeline route attributes the write to
  // the same signed-in user through its own guard. The user id is NOT passed in the
  // body: a route that trusts a body-supplied user id is a route that can be told to
  // write to somebody else's rows.
  const origin = new URL(request.url).origin;
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}${PIPELINE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: request.headers.get('cookie') ?? '',
      },
      body: JSON.stringify({ job_id: match.job_id, status, note, source: 'voice' }),
      cache: 'no-store',
    });
  } catch (error) {
    return blocked(
      `I could not reach the pipeline service, so ${match.title} at ${match.company} was NOT saved — ${(error as Error).message}.`,
      user.id,
      conversationId,
      match.job_id,
    );
  }

  if (upstream.status === 404 || upstream.status === 405) {
    return blocked(
      `Saving jobs is not wired up on this build yet — the pipeline endpoint is not there. ${match.title} at ${match.company} was NOT saved, and I am not going to record it somewhere else and pretend it was.`,
      user.id,
      conversationId,
      match.job_id,
    );
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return blocked(
      `The pipeline service refused that (${upstream.status}), so ${match.title} at ${match.company} was NOT saved.`,
      user.id,
      conversationId,
      match.job_id,
      text.slice(0, 300),
    );
  }

  let parsed: { previous_status?: unknown; at?: unknown; status?: unknown } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // A 200 with an unreadable body still means the write happened. Report the
    // status we asked for rather than inventing one we did not read.
  }

  const previousStatus = typeof parsed.previous_status === 'string' ? parsed.previous_status : null;
  const at = typeof parsed.at === 'string' ? parsed.at : new Date().toISOString();
  const reason = `${SPOKEN[status]}: ${match.title} at ${match.company} (${match.score}% match)${
    previousStatus ? `, moved from ${previousStatus}` : ''
  }.`;

  await logVoiceAction({
    userId: user.id,
    conversationId,
    kind: 'job_status_set',
    outcome: 'ok',
    text: reason,
    jobId: match.job_id,
    detail: { status, previous_status: previousStatus, resolved_by: resolution.how, note: note ?? null },
  });

  const ok: VoiceStatusResponse = {
    ok: true,
    kind: 'job_status_set',
    jobId: match.job_id,
    status,
    previousStatus,
    at,
    reason,
  };
  return NextResponse.json(ok, { headers: { 'cache-control': 'no-store' } });
}

/* --------------------------------------------------------------- the two no's */

/**
 * The agent declining. `fields_released: []` is in the payload, not in a comment,
 * because hard rule 3 says a refusal releases nothing and a reader should be able to
 * check that without reading the implementation.
 */
async function refuse(reason: string, userId: string, conversationId: string): Promise<NextResponse> {
  await logVoiceAction({
    userId,
    conversationId,
    kind: 'refused',
    outcome: 'refused',
    text: reason,
  });
  const body: VoiceStatusResponse = { ok: false, kind: 'refused', reason, fields_released: [] };
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}

/** Not the agent's decision — the dependency is absent. Said plainly, never faked. */
async function blocked(
  reason: string,
  userId: string,
  conversationId: string,
  jobId: string,
  upstreamBody?: string,
): Promise<NextResponse> {
  await logVoiceAction({
    userId,
    conversationId,
    kind: 'refused',
    outcome: 'failed',
    text: reason,
    jobId,
    detail: { blocked_on: PIPELINE_PATH, upstream: upstreamBody ?? null },
  });
  const body: VoiceStatusResponse = { ok: false, kind: 'blocked', reason, fields_released: [] };
  // 200, not 502: the conversation needs to read this sentence out, and the agent
  // treating it as a transport error would retry something that cannot succeed.
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } });
}
