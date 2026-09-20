/**
 * voice-contract.ts — the wire types shared by the voice routes and the browser.
 *
 * DELIBERATELY FREE OF NODE IMPORTS. `src/lib/voice.ts` pulls in the Databricks
 * client, which cannot be bundled into a client component; putting the shapes here
 * means the transcript UI and the route handler agree on one definition instead of
 * two that drift.
 *
 * Nothing in this file may import anything that touches a credential.
 *
 * The one import below is type-only and points at `voice-brief.ts`, which has no
 * imports of its own — not even type imports — so this stays bundleable into a
 * client component.
 */
import type { MatchBrief, PageBrief } from '@/lib/voice-brief';

/**
 * Every kind of thing the agent can report having DONE.
 *
 * `profile_updated` was the only reachable one when the agent could only ask
 * questions. Making it an ACTOR reached three more: `job_matched` (a match run, a
 * read-out, or an explanation), `refused` (the agent declining — a job id that does
 * not resolve, or being asked to apply) and `navigated` / `job_status_set` for the
 * two things it now does on the user's behalf.
 *
 * `interview_feedback` is produced by the mock interview room (src/lib/interview.ts,
 * F4.7), which appends the closing readout as a role='action' turn. It was reserved
 * here and unreached until then.
 *
 * The union is the mechanism, not decoration — adding a kind is a compile error in
 * TranscriptAction's exhaustive switch until it is handled, rather than a silent
 * unlabelled row.
 */
export const VOICE_ACTION_KINDS = [
  'profile_updated',
  'job_matched',
  'refused',
  'interview_feedback',
  'navigated',
  'job_status_set',
] as const;

export type VoiceActionKind = (typeof VOICE_ACTION_KINDS)[number];

export function isVoiceActionKind(value: unknown): value is VoiceActionKind {
  return typeof value === 'string' && (VOICE_ACTION_KINDS as readonly string[]).includes(value);
}

/** One outstanding question, straight from profile_gaps. */
export type VoiceGap = {
  fieldKey: string;
  question: string;
  priority: number;
};

/**
 * What GET /api/voice/session returns.
 *
 * `signedUrl` is null when ElevenLabs is not reachable or not configured, and
 * `unavailableReason` says why in a sentence a user can read. The UI must still
 * render the transcript and the typed input in that case — a missing voice hop
 * degrades to typing, it does not remove the feature.
 */
export type VoiceSessionPayload = {
  signedUrl: string | null;
  unavailableReason: string | null;
  gaps: VoiceGap[];
  firstMessage: string;
  /** Substituted into the agent's prompt as {{name}}. Never contains a secret. */
  dynamicVariables: Record<string, string>;
};

/** The one request body for an answer, whether it was spoken or typed. */
export type VoiceAnswerRequest = {
  fieldKey: string;
  value: string;
  /** ElevenLabs conversation id, or typed:<uuid> for the typed fallback. */
  conversationId?: string;
  /** Client-asserted. 'voice' went through a microphone, 'form' was typed. */
  source?: 'voice' | 'form';
  /** The raw utterance or typed line, logged as the `user` turn. */
  spokenText?: string;
  /** Position in the transcript. Omitted, the server computes the next one. */
  turnIndex?: number;
};

export type VoiceAnswerResponse = {
  ok: boolean;
  /** The human sentence the transcript shows. This IS the action line. */
  action: string;
  actionKind: VoiceActionKind;
  fieldKey: string;
  /** What actually got stored, which may differ from what was said. */
  storedValue: string;
  confidence: number;
  gapsRemaining: number;
  error?: string;
};

/** A line in the transcript panel. */
export type TranscriptEntry =
  | { id: string; role: 'user' | 'agent'; text: string; at: number }
  | {
      id: string;
      role: 'action';
      kind: VoiceActionKind;
      /** 'pending' while the write is in flight — the user sees it settle. */
      state: 'pending' | 'done' | 'failed';
      text: string;
      fieldKey?: string;
      /** The job the action was about, when it was about one. */
      jobId?: string;
      at: number;
    };

/* ==========================================================================
 * THE ACTOR HALF. Everything below exists because the agent stopped being a
 * question-asker. Each type belongs to exactly one route, named above it.
 * ========================================================================== */

/**
 * GET /api/voice/context?path=…&job=…
 *
 * The page brief. Everything in `PageBrief` has been through the allow-list in
 * `voice-brief.ts`; nothing in it came from `contact.*`. See that file before
 * widening this.
 */
export type VoicePageContextResponse = {
  ok: true;
  context: PageBrief;
  /**
   * Which match run produced `context.matches`.
   *
   * Carried so the browser can tell a run it has ALREADY told the user about from a
   * new one that just landed. That is the whole of proactivity: a changed `run_id`
   * means "these are new, volunteer them", and an unchanged one means stay quiet. The
   * alternative — announcing on every page load — is an agent that repeats itself
   * until you close the tab.
   */
  run: { run_id: string | null; started_at: string | null } | null;
  /** Only present when the PII assertion tripped, which should never happen. */
  redacted?: string;
};

/**
 * The statuses `POST /api/pipeline/status` accepts. Validated here so a
 * transcribed word cannot become an arbitrary stage string.
 *
 * `applied` records WHAT THE USER SAYS HAPPENED. It is never the agent claiming it
 * applied — the agent cannot apply (hard rule 3) and has no tool that could.
 */
export const VOICE_JOB_STATUSES = ['saved', 'applied', 'interviewing', 'rejected', 'dismissed'] as const;

export type VoiceJobStatus = (typeof VOICE_JOB_STATUSES)[number];

export function isVoiceJobStatus(value: unknown): value is VoiceJobStatus {
  return typeof value === 'string' && (VOICE_JOB_STATUSES as readonly string[]).includes(value);
}

/** Where `open_page` is allowed to send the browser. A closed set, not a URL. */
export const VOICE_NAV_TARGETS = [
  'dashboard',
  'matches',
  'job',
  'apply',
  'profile',
  'activity',
  'pipeline',
] as const;

export type VoiceNavTarget = (typeof VOICE_NAV_TARGETS)[number];

export function isVoiceNavTarget(value: unknown): value is VoiceNavTarget {
  return typeof value === 'string' && (VOICE_NAV_TARGETS as readonly string[]).includes(value);
}

/**
 * POST /api/voice/resolve — turn whatever the model said into a real job, or refuse.
 *
 * The model WILL produce a job id that does not exist: invented outright, or
 * mis-transcribed from "the second one". So resolution happens server-side against
 * the signed-in user's OWN cached match run and nothing else. No free-text search
 * over 16k postings, no fuzzy guess at a plausible neighbour.
 */
export type VoiceResolveRequest = {
  /** Whatever the model produced: a job id, an ordinal, or a company name. */
  jobRef?: string;
  target?: VoiceNavTarget;
  conversationId?: string;
  source?: 'voice' | 'form';
};

export type VoiceResolveResponse =
  | {
      ok: true;
      kind: 'navigated';
      match: MatchBrief | null;
      /** The in-app path the browser should push. Always app-relative. */
      href: string;
      /** Hard rule 4: never an action without a reason string. */
      reason: string;
    }
  | {
      ok: false;
      kind: 'refused';
      reason: string;
      /**
       * Hard rule 3. A refusal releases NOTHING. This array is empty on every
       * refusal this codebase can produce, and a test asserts it.
       */
      fields_released: [];
    };

/**
 * POST /api/voice/status — the voice/typed shim in FRONT of the pipeline lane's
 * route. It validates, forwards to POST /api/pipeline/status, and logs. It does not
 * own a table and must never write one; if the pipeline route is missing this
 * returns `blocked` and says so out loud rather than inventing a second store for
 * the same fact.
 */
export type VoiceStatusRequest = {
  jobRef?: string;
  status?: string;
  note?: string;
  conversationId?: string;
  source?: 'voice' | 'form';
};

export type VoiceStatusResponse =
  | {
      ok: true;
      kind: 'job_status_set';
      jobId: string;
      status: VoiceJobStatus;
      previousStatus: string | null;
      at: string;
      reason: string;
    }
  | {
      ok: false;
      kind: 'refused' | 'blocked';
      reason: string;
      fields_released: [];
    };

/**
 * POST /api/voice/event — the producer `voice_events` never had.
 *
 * Every action the agent takes writes one row: who, which conversation, what kind,
 * which job, the outcome, and the spoken reason. That is the answer to "what did the
 * agent do on my behalf", which is the whole claim the product makes.
 */
export type VoiceEventRequest = {
  kind: VoiceActionKind;
  /** The spoken reason. Required — hard rule 4. */
  text: string;
  outcome?: 'ok' | 'refused' | 'failed';
  jobId?: string;
  conversationId?: string;
  detail?: Record<string, unknown>;
};

export type VoiceEventResponse = { ok: boolean; error?: string };

// Re-exported so a consumer can name these shapes from one module. voice-brief.ts
// has no imports of its own, so this costs nothing and keeps one definition rather
// than two that drift.
export type { MatchBrief, PageBrief };
