/**
 * voice-actions.ts — the server half of "the agent takes actions".
 *
 * THREE JOBS, AND THE REASON EACH ONE IS HERE RATHER THAN IN A ROUTE:
 *
 *  1. READ the last match run, once, cheaply. `readCachedRun()` is already exported
 *     from the match lane, so this file calls it rather than writing a second reader —
 *     two readers of the same run is how "/api/match returns a different order the
 *     second time" happened once already.
 *
 *  2. RESOLVE what the model said into a real job. The model will produce a job id
 *     that does not exist. That is not a bug to be prompted away; it is the normal
 *     failure mode of speech, and the fix is that resolution happens HERE, against
 *     the signed-in user's own cached run, and REFUSES when it cannot. A refusal is
 *     a better outcome than a plausible neighbour, because a plausible neighbour is
 *     indistinguishable from working until somebody applies to the wrong job.
 *
 *  3. LOG. `voice_events` has existed and been empty since the schema was written.
 *     Every action the agent takes writes one row here. That is the audit trail the
 *     product's whole claim rests on, and it costs one INSERT.
 *
 * WHAT IS NOT HERE: applying. There is no function in this file that sends anything
 * to an employer, because hard rule 3 puts a human confirmation between the agent
 * and any field leaving. The agent may navigate to the approval page. That is all.
 *
 * Everything user-derived — a transcribed job reference, a typed note — is bound as a
 * NAMED SQL PARAMETER. Nothing is interpolated. `user_id` comes from requireRole() in
 * the route and never from a request body.
 */
import { randomUUID } from 'node:crypto';

import { sql, type SqlParam } from '@/lib/databricks';
import { readCachedRun } from '@/lib/match/run.mjs';
import { resolveJobRef, toMatchBriefs, type MatchBrief } from '@/lib/voice-brief';
import type { VoiceActionKind, VoiceNavTarget } from '@/lib/voice-contract';

// Re-exported, not reimplemented: the routes resolve a spoken job reference with the
// SAME function the browser uses to decide which stored reason to read back. See the
// long note on resolveJobRef in voice-brief.ts for why there is only one copy.
export { resolveJobRef };
export type { Resolution } from '@/lib/voice-brief';

const EVENTS = 'workspace.vthacks_2026.voice_events';
const TURNS = 'workspace.vthacks_2026.voice_turns';
const PROFILES = 'workspace.vthacks_2026.profiles';
const GAPS = 'workspace.vthacks_2026.profile_gaps';

/** Show ten. The spoken summary names three; see spokenSummary() in voice-brief.ts. */
export const PANEL_MATCH_LIMIT = 10;

/* -------------------------------------------------------------- the cached run */

export type CachedMatches = {
  matches: MatchBrief[];
  /** True when there is no completed run inside the TTL — nothing to read out. */
  stale: boolean;
  runId: string | null;
  startedAt: string | null;
};

/**
 * The last match run, projected through the egress allow-list. ZERO model calls.
 *
 * This is what makes "why am I a good fit for this role" free: the reason sentence
 * and the requirement scores were written at match time by the match agent. Asking a
 * model to re-explain at conversation time would cost a call, take a second, and
 * produce a DIFFERENT answer than the one stored on the row — so the page and the
 * voice would disagree about the same job.
 *
 * Never throws. A warehouse that is down means "no matches to read out", which the
 * agent can say; it does not mean the conversation fails.
 */
export async function cachedMatches(userId: string): Promise<CachedMatches> {
  try {
    const run = await readCachedRun(sql, userId);
    if (!run) return { matches: [], stale: true, runId: null, startedAt: null };
    return {
      matches: toMatchBriefs(run.matches, PANEL_MATCH_LIMIT),
      stale: false,
      runId: typeof run.run_id === 'string' ? run.run_id : null,
      startedAt: typeof run.started_at === 'string' ? run.started_at : null,
    };
  } catch (error) {
    console.error('voice: cached match read failed', (error as Error).message);
    return { matches: [], stale: true, runId: null, startedAt: null };
  }
}

/* ----------------------------------------------------------- the second PII wall */

export type ContactGuard = { email: string | null; phone: string | null };

/**
 * The user's own email and phone, read so that they can be ASSERTED ABSENT.
 *
 * This looks backwards and is not: the brief is built from a projection that has no
 * path to these columns, and then we check the finished string for them anyway. The
 * value of the check is exactly that it should be impossible — if it ever fires, some
 * code path nobody audited copied a contact field, and the payload is dropped before
 * it reaches ElevenLabs rather than after.
 *
 * These two values never enter a response body. They exist inside one function call.
 */
export async function contactGuard(userId: string): Promise<ContactGuard> {
  try {
    const result = await sql(
      `SELECT email, phone FROM ${PROFILES} WHERE user_id = :user LIMIT 1`,
      [{ name: 'user', value: userId }],
    );
    const row = result.rows[0] ?? [];
    return { email: row[0] ?? null, phone: row[1] ?? null };
  } catch {
    // A failed guard read must not block the brief; the shape checks in
    // containsContactPii() do not depend on it.
    return { email: null, phone: null };
  }
}

export async function openGapCount(userId: string): Promise<number> {
  try {
    const result = await sql(
      `SELECT count(*) FROM ${GAPS} WHERE user_id = :user AND status = 'open'`,
      [{ name: 'user', value: userId }],
    );
    return Number(result.rows[0]?.[0] ?? 0);
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------- where it may go */

/**
 * The only paths the agent may navigate to. A closed set, not a URL the model wrote.
 *
 * `/applicant/apply` is in it and that is not a contradiction: it is the HUMAN
 * CONFIRM page. Walking the user to the approval screen and stopping is the whole
 * demo. Nothing on the other side of it is reachable from any tool in this codebase.
 */
export function hrefFor(target: VoiceNavTarget, match: MatchBrief | null): string {
  switch (target) {
    case 'job':
      // The match list carries the detail; `?job=` selects one. A bare
      // /applicant/jobs/<id> currently redirects here anyway.
      return match ? `/applicant/jobs?job=${encodeURIComponent(match.job_id)}` : '/applicant/jobs';
    case 'apply':
      return match ? `/applicant/apply?job=${encodeURIComponent(match.job_id)}` : '/applicant/apply';
    case 'matches':
      return '/applicant/jobs';
    case 'profile':
      return '/applicant/profile';
    case 'activity':
      return '/applicant/activity';
    case 'pipeline':
      return '/applicant/pipeline';
    case 'dashboard':
      return '/applicant';
    default: {
      // Adding a VoiceNavTarget without a case here fails typecheck.
      const unhandled: never = target;
      return unhandled;
    }
  }
}

/* ------------------------------------------------------------------- the log */

export type VoiceEventInput = {
  userId: string;
  conversationId: string;
  kind: VoiceActionKind;
  outcome: 'ok' | 'refused' | 'failed';
  /** The spoken reason. Hard rule 4 — an action never exists without one. */
  text: string;
  jobId?: string | null;
  detail?: Record<string, unknown>;
};

/**
 * Write the action to `voice_events` AND to `voice_turns`.
 *
 * Two tables because they answer two questions and the schema says so out loud:
 * `voice_events` is telemetry keyed on the session (what the voice layer did, for the
 * audit story), `voice_turns` is the transcript in order (what the user would read
 * back). A judge asking "prove the agent did that" wants the first; a user asking
 * "what did it just do" wants the second.
 *
 * `application_id` is left NULL. There is no application during a conversation about
 * matches, which is exactly why voice_turns exists as its own table.
 *
 * NEVER THROWS. Losing a log line must not turn a completed action into an error the
 * user is told about — that would be a lie in the other direction.
 */
export async function logVoiceAction(input: VoiceEventInput): Promise<void> {
  const detail = JSON.stringify({
    job_id: input.jobId ?? null,
    outcome: input.outcome,
    ...(input.detail ?? {}),
  }).slice(0, 4000);

  const parameters: SqlParam[] = [
    { name: 'event_id', value: randomUUID() },
    { name: 'user', value: input.userId },
    { name: 'conv', value: input.conversationId },
    { name: 'kind', value: input.kind },
    { name: 'outcome', value: input.outcome },
    { name: 'detail', value: detail },
  ];

  try {
    await sql(
      `INSERT INTO ${EVENTS}
         (voice_event_id, application_id, session_id, event_type, outcome, event_at,
          metadata_json, user_id, conversation_id)
       VALUES (:event_id, NULL, :conv, :kind, :outcome, current_timestamp(),
               :detail, :user, :conv)`,
      parameters,
    );
  } catch (error) {
    console.error('voice: voice_events insert failed', (error as Error).message);
  }

  try {
    const next = await sql(
      `SELECT coalesce(max(turn_index), -1) + 1 FROM ${TURNS} WHERE conversation_id = :conv`,
      [{ name: 'conv', value: input.conversationId }],
    );
    await sql(
      `INSERT INTO ${TURNS}
         (turn_id, user_id, conversation_id, turn_index, role, text, action_kind,
          action_detail, field_key, spoken_at)
       VALUES (:turn_id, :user, :conv, :idx, 'action', :text, :kind, :detail, NULL,
               current_timestamp())`,
      [
        { name: 'turn_id', value: randomUUID() },
        { name: 'user', value: input.userId },
        { name: 'conv', value: input.conversationId },
        { name: 'idx', value: String(Number(next.rows[0]?.[0] ?? 0)), type: 'INT' },
        { name: 'text', value: input.text.slice(0, 4000) },
        { name: 'kind', value: input.kind },
        { name: 'detail', value: detail },
      ],
    );
  } catch (error) {
    console.error('voice: voice_turns action insert failed', (error as Error).message);
  }
}

/** A conversation id for the typed path, so turns still group. */
export function conversationIdOr(raw: unknown): string {
  const given = typeof raw === 'string' ? raw.trim() : '';
  return given ? given.slice(0, 120) : `typed:${randomUUID()}`;
}
