/**
 * GET /api/voice/context?path=/applicant/jobs&job=<id>
 *
 * "What page am I on, and what is on it." The agent's situational awareness, built
 * server-side and handed over as one factual paragraph.
 *
 * WHY THE SERVER DECIDES WHAT A PAGE MEANS. The browser knows `usePathname()`. It does
 * not know that `/applicant/jobs` is a scored match list, or that `/applicant/apply`
 * is the human-confirm gate that the agent must stop at. If the client assembled that
 * description, the agent's model of the app would be a second source of truth that
 * drifts the first time a route is renamed. So the client sends a path and gets back
 * prose it did not write. See PAGES in `voice-brief.ts`.
 *
 * WHY IT COSTS NOTHING. The matches come from `readCachedRun()` — the run the match
 * agent already paid ~21 model calls for. The reason sentence on each row was written
 * at match time. So "why am I a good fit for this role" is answered from storage, at
 * zero marginal cost, with the SAME words the match list shows. An agent that
 * re-explains at conversation time costs a call and contradicts the page.
 *
 * THIS IS THE EGRESS POINT. Whatever this route returns, the browser forwards to
 * ElevenLabs via sendContextualUpdate. Two walls stand in the way, in this order:
 *
 *   1. `toMatchBriefs()` — an eleven-field allow-list. Nothing reaches the payload
 *      except by being named there.
 *   2. `containsContactPii()` — the finished string is checked for email/phone shapes
 *      AND for this user's own stored email and phone, read here and deliberately
 *      never written into the response. If it trips, the BRIEF IS DROPPED and the
 *      response says it was. Failing closed is the only safe direction: you cannot
 *      un-say a phone number.
 *
 * GET is correct. This reads; it writes nothing and logs nothing.
 */
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/session';
import { cachedMatches, contactGuard, openGapCount } from '@/lib/voice-actions';
import {
  buildPageBrief,
  containsContactPii,
  egressSurface,
  jobIdFromPath,
  normalizePath,
  pageMeaning,
  safeJobId,
  type MatchBrief,
} from '@/lib/voice-brief';
import type { VoicePageContextResponse } from '@/lib/voice-contract';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await requireRole('applicant');
  const params = new URL(request.url).searchParams;

  const path = normalizePath(params.get('path'));
  // Either /applicant/jobs/<id> or ?job=<id>. The path form wins; both are validated
  // against the cached run below, so neither can point at a job that is not the
  // user's own.
  const requestedJobId = jobIdFromPath(path) ?? safeJobId(params.get('job'));

  const [matches, guard, gapsRemaining] = await Promise.all([
    cachedMatches(user.id),
    contactGuard(user.id),
    openGapCount(user.id),
  ]);

  // The focus job is resolved out of the user's OWN run, not fetched by id. A job
  // they have no match for has no score and no reason, so there is nothing to say
  // about it that would not be invented.
  const focusJob: MatchBrief | null = requestedJobId
    ? (matches.matches.find((match) => match.job_id === requestedJobId) ?? null)
    : null;

  const context = buildPageBrief({
    path,
    meaning: pageMeaning(path),
    matches: matches.matches,
    focusJob,
    stale: matches.stale,
    gapsRemaining,
  });

  // Wall two. `egressSurface()` is everything that can reach ElevenLabs from this
  // brief — including the reason sentences, which are the longest free text in the
  // payload and do not all appear in `brief` itself. The test imports the same function,
  // so there is no second, smaller idea of what leaves.
  const found = containsContactPii(egressSurface(context), guard);

  if (found) {
    console.error(`voice: refusing to send a brief containing ${found}`);
    const body: VoicePageContextResponse = {
      ok: true,
      context: {
        ...context,
        brief: `CURRENT PAGE: ${context.page_name} (${context.path}). I am not able to describe what is on screen right now. Do not guess at it; ask the student what they want to do.`,
        matches: [],
        spoken_summary: null,
        focus_job: null,
      },
      run: null,
      redacted: `A brief was dropped because it contained ${found}.`,
    };
    return NextResponse.json(body, { headers: { 'cache-control': 'no-store, private' } });
  }

  const body: VoicePageContextResponse = {
    ok: true,
    context,
    run: matches.runId ? { run_id: matches.runId, started_at: matches.startedAt } : null,
  };
  return NextResponse.json(body, {
    // Scoped to one signed-in user and read live. Never a shared cache.
    headers: { 'cache-control': 'no-store, private' },
  });
}
