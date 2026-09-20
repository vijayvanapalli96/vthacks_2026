/**
 * pipeline-contract.ts — the pipeline vocabulary, with no runtime dependencies.
 *
 * Split out of pipeline.ts on purpose: pipeline.ts imports `node:crypto` and the
 * Databricks client, so a client component that imported it would not build. The
 * board's <select> needs the stage list and the labels, and nothing else. Same
 * split, same reason, as voice-contract.ts next door.
 *
 * Everything here is pure data or a pure function. Do not add an import that is
 * not `type`-only.
 */

/**
 * The whitelist. Mirrors the FIELDS idiom in src/lib/voice.ts: `event_type` is an
 * unconstrained STRING at the storage layer (Unity Catalog CHECK constraints are
 * informational and Delta does not enforce them), so this array is the only thing
 * standing between a hallucinated status and a junk row that append-only rules
 * forbid anyone from cleaning up.
 *
 * Ordered as the board reads, left to right, which is also the funnel order.
 */
export const PIPELINE_STATUSES = [
  'saved',
  'applied',
  'interviewing',
  'offer',
  'accepted',
  'rejected',
  'withdrawn',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

/** The stages that form the funnel proper. Rejected and withdrawn are exits, not steps. */
export const FUNNEL_STAGES = ['saved', 'applied', 'interviewing', 'offer', 'accepted'] as const;

export const PIPELINE_SOURCES = ['ui', 'voice'] as const;
export type PipelineSource = (typeof PIPELINE_SOURCES)[number];

/**
 * Pre-existing machine event types that IMPLY a stage. `submitted` is what the A2A
 * apply path emits and `callback` is an employer reply, so normalising them means
 * an application the agent sent appears on the board without the user marking it
 * by hand. The view in sql/schema.sql §8 normalises the same two cases; this map
 * is the TypeScript side of that one decision.
 *
 * viewed | tailored | verified | refused are activity, NOT stages, and are absent
 * on purpose — viewing a job you already marked "interviewing" must not demote it.
 */
export const IMPLIED_STAGE: Record<string, PipelineStatus> = {
  submitted: 'applied',
  callback: 'interviewing',
};

/** Human labels. Shipped with the stage because the board never uses colour alone. */
export const STATUS_LABEL: Record<PipelineStatus, string> = {
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/**
 * What each column means, in words.
 *
 * "Offer" and "Accepted" are two stages, not one. An offer is the employer's
 * decision and acceptance is the user's; an offer you declined is not a success,
 * and one "Success" column would overstate the outcome.
 */
export const STATUS_HINT: Record<PipelineStatus, string> = {
  saved: 'Worth a look. Nothing sent yet.',
  applied: 'Application sent. Waiting on them.',
  interviewing: 'They replied and the conversation is live.',
  offer: 'They made an offer. Their decision.',
  accepted: 'You said yes. Your decision.',
  rejected: 'They said no.',
  withdrawn: 'You pulled out.',
};

/**
 * A non-colour marker per stage: the funnel position as a numeral, or an em dash
 * for the two exits. Hard rule 6 — stage is never conveyed by colour alone, so
 * every stage badge carries its label AND this mark.
 */
export const STATUS_MARK: Record<PipelineStatus, string> = {
  saved: '1',
  applied: '2',
  interviewing: '3',
  offer: '4',
  accepted: '5',
  rejected: '×',
  withdrawn: '×',
};

/** Type guard over the whitelist. The only route a status takes to the database. */
export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return typeof value === 'string' && (PIPELINE_STATUSES as readonly string[]).includes(value);
}

export function isPipelineSource(value: unknown): value is PipelineSource {
  return typeof value === 'string' && (PIPELINE_SOURCES as readonly string[]).includes(value);
}

/** Normalise a raw event_type to a stage, or null if it is activity rather than a stage. */
export function toStage(eventType: string | null | undefined): PipelineStatus | null {
  if (!eventType) return null;
  if (isPipelineStatus(eventType)) return eventType;
  return IMPLIED_STAGE[eventType] ?? null;
}

export type PipelineCard = {
  job_id: string;
  status: PipelineStatus;
  title: string | null;
  company: string | null;
  location: string | null;
  source_url: string | null;
  /** When this stage was entered, ISO 8601. */
  status_changed_at: string | null;
  /** Whole days spent in the current stage. 0 means today. */
  days_in_stage: number | null;
  /** Whole days since this job first entered the pipeline at all. */
  days_tracked: number | null;
  /** Pipeline events for this job. Greater than 1 is visible proof the log appended. */
  events_total: number;
  note: string | null;
  /** Match score out of 100 when the match cache has one. Null is normal and fine. */
  match_score: number | null;
  /** The match agent's one-sentence reason, when it has one. */
  match_reason: string | null;
};

export type PipelineBoard = {
  stages: Record<PipelineStatus, PipelineCard[]>;
  counts: Record<PipelineStatus, number>;
  total: number;
};

export function emptyBoard(): PipelineBoard {
  return {
    stages: { saved: [], applied: [], interviewing: [], offer: [], accepted: [], rejected: [], withdrawn: [] },
    counts: { saved: 0, applied: 0, interviewing: 0, offer: 0, accepted: 0, rejected: 0, withdrawn: 0 },
    total: 0,
  };
}

/**
 * "7 days in Applied with no response" — the sentence the event log gives away for
 * free, because `state_changed_at` is already on the view row. Returns null when
 * there is nothing worth saying, so the caller never renders an empty nag.
 *
 * Three days, not one: a day-old application is not stalled, and a board that
 * nags immediately is a board people stop reading.
 */
export function stalledSentence(card: PipelineCard): string | null {
  const days = card.days_in_stage;
  if (days === null || days < 3) return null;
  if (card.status === 'applied') return `${days} days in Applied, no response yet.`;
  if (card.status === 'interviewing') return `${days} days since the last interview update.`;
  if (card.status === 'offer') return `${days} days to decide on this offer.`;
  return null;
}

/** "today" / "1 day" / "12 days". Used in a sentence, so it is never bare. */
export function daysPhrase(days: number | null): string {
  if (days === null) return 'an unknown time';
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}
