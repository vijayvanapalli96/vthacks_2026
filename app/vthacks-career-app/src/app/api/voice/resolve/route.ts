/**
 * POST /api/voice/resolve — "take me to it", with the guess taken out.
 *
 * THE PROBLEM THIS ROUTE EXISTS FOR. `open_page` is the one tool where the model
 * supplies an identifier. It will get that identifier wrong: invented outright, or
 * mis-transcribed, or reasoned from "the second one" against a list it half
 * remembers. If the browser trusted it, the user would be navigated somewhere
 * plausible — and "plausible but wrong job" is indistinguishable from working right
 * up until somebody approves an application on the wrong page.
 *
 * So the browser does not resolve anything. It posts what the model said, and this
 * route matches it against THE SIGNED-IN USER'S OWN CACHED MATCH RUN. Four ways in
 * (exact id, ordinal, company/title, "the top one"), no fuzzy fallback, and an
 * ambiguous reference is a refusal rather than a coin flip. See resolveJobRef().
 *
 * A REFUSAL IS A FIRST-CLASS OUTCOME, NOT AN ERROR. It returns 200 with
 * `kind: 'refused'`, a spoken reason, and `fields_released: []`. Hard rule 3: a
 * refusal releases nothing, and the empty array is in the payload so that claim is
 * checkable by a reader and by a test rather than asserted in a comment. It is logged
 * to `voice_events` as the `refused` action kind — one of the kinds that has been
 * declared and unreachable since the schema was written.
 *
 * WHAT IT RETURNS IS A PATH, NOT A NAVIGATION. `router.push()` happens in the
 * browser. This route cannot navigate anyone; it can only say where it would be
 * legitimate to go, from the closed set in hrefFor(). There is no code path here
 * that takes a URL from the request.
 *
 * `apply` IS NOT REACHABLE FROM HERE AS AN ACTION. `target: 'apply'` resolves to
 * /applicant/apply?job=… which is the HUMAN CONFIRM page. Walking the user there and
 * stopping is the point.
 */
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/session';
import { cachedMatches, conversationIdOr, hrefFor, logVoiceAction, resolveJobRef } from '@/lib/voice-actions';
import {
  isVoiceNavTarget,
  type VoiceResolveRequest,
  type VoiceResolveResponse,
} from '@/lib/voice-contract';

export const dynamic = 'force-dynamic';

/** Targets that do not name a job need no resolution at all. */
const JOBLESS = new Set(['dashboard', 'matches', 'profile', 'activity', 'pipeline']);

export async function POST(request: Request) {
  const user = await requireRole('applicant');

  let body: Partial<VoiceResolveRequest> = {};
  try {
    body = (await request.json()) as Partial<VoiceResolveRequest>;
  } catch {
    // An empty body means "the top match", which is a reasonable default for a
    // button labelled "Open the best one".
  }

  const raw = body as Record<string, unknown>;
  const jobRef = raw.jobRef ?? raw.job_ref;
  const rawTarget = raw.target ?? 'job';
  const conversationId = conversationIdOr(raw.conversationId ?? raw.conversation_id);

  if (!isVoiceNavTarget(rawTarget)) {
    const reason = `I do not have a page called "${String(rawTarget).slice(0, 40)}", so I am not going to send you anywhere.`;
    await logVoiceAction({
      userId: user.id,
      conversationId,
      kind: 'refused',
      outcome: 'refused',
      text: reason,
      detail: { requested_target: String(rawTarget).slice(0, 40) },
    });
    const refusal: VoiceResolveResponse = { ok: false, kind: 'refused', reason, fields_released: [] };
    return NextResponse.json(refusal, { headers: { 'cache-control': 'no-store' } });
  }

  if (JOBLESS.has(rawTarget)) {
    const href = hrefFor(rawTarget, null);
    const reason = `Opening ${href}.`;
    await logVoiceAction({
      userId: user.id,
      conversationId,
      kind: 'navigated',
      outcome: 'ok',
      text: reason,
      detail: { target: rawTarget, href },
    });
    const ok: VoiceResolveResponse = { ok: true, kind: 'navigated', match: null, href, reason };
    return NextResponse.json(ok, { headers: { 'cache-control': 'no-store' } });
  }

  const { matches } = await cachedMatches(user.id);
  const resolution = resolveJobRef(matches, jobRef);

  if (!resolution.ok) {
    await logVoiceAction({
      userId: user.id,
      conversationId,
      kind: 'refused',
      outcome: 'refused',
      text: resolution.reason,
      detail: {
        requested_ref: typeof jobRef === 'string' ? jobRef.slice(0, 200) : null,
        target: rawTarget,
        candidates_available: matches.length,
      },
    });
    const refusal: VoiceResolveResponse = {
      ok: false,
      kind: 'refused',
      reason: resolution.reason,
      // Hard rule 3, stated in the payload rather than in a comment.
      fields_released: [],
    };
    return NextResponse.json(refusal, { headers: { 'cache-control': 'no-store' } });
  }

  const match = resolution.match;
  const href = hrefFor(rawTarget, match);

  // The reason string IS the action line the transcript renders. Hard rule 4: it
  // says which job, why that job resolved, and — for the approval page — that the
  // agent is stopping there.
  const reason =
    rawTarget === 'apply'
      ? `Taking you to the approval page for ${match.title} at ${match.company}. I cannot send anything myself — you approve what leaves.`
      : `Opening ${match.title} at ${match.company} (${match.score}% match)${
          resolution.how === 'ordinal'
            ? ', which is the one you meant by position in the list'
            : resolution.how === 'name'
              ? ', the only match with that name'
              : resolution.how === 'top'
                ? ', your strongest match'
                : ''
        }.`;

  await logVoiceAction({
    userId: user.id,
    conversationId,
    kind: 'navigated',
    outcome: 'ok',
    text: reason,
    jobId: match.job_id,
    detail: {
      target: rawTarget,
      href,
      resolved_by: resolution.how,
      requested_ref: typeof jobRef === 'string' ? jobRef.slice(0, 200) : null,
      score: match.score,
    },
  });

  const ok: VoiceResolveResponse = { ok: true, kind: 'navigated', match, href, reason };
  return NextResponse.json(ok, { headers: { 'cache-control': 'no-store' } });
}
