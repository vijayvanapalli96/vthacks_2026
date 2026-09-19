/**
 * voice.ts — the voice agent's only write path, and the queue it reads.
 *
 * THE AGENT IS A MEDIUM, NOT A BRAIN. It asks what profile_gaps says is open and
 * hands the answer to recordAnswer(), which is the same function the typed input in
 * the transcript panel reaches through the same HTTP route. Hard rule 5 —
 * "everything you can say, you can type" — is satisfied here, at the API layer,
 * rather than approximated by two similar code paths.
 *
 * FOUR THINGS HAPPEN PER ANSWER, IN THIS ORDER:
 *   1. append a fact to profile_memory      (what they said, with provenance)
 *   2. update the structured row            (what we can filter on)
 *   3. close the gap                        (so it is never asked again)
 *   4. log the turn(s) to voice_turns       (the audit trail of 1-3)
 *
 * Memory first, on purpose. profile_memory is the record of the conversation; if the
 * structured write fails we would rather hold an un-filterable fact than lose the
 * only copy of what the user told us.
 *
 * APPEND-ONLY MEANS APPEND-ONLY. Answering the same question twice appends a SECOND
 * fact and lets profile_current pick the later one. Nothing is updated in place and
 * nothing is deduplicated, because a duplicated fact has no undo and a mutated one
 * destroys the history that makes this a memory rather than a form.
 *
 * FACT KEY NAMESPACE — read this before adding a field.
 * Answers land under `answer.<field_key>`, which collides with NOTHING the resume
 * extractor writes (it owns `contact.*`, `education.*`, `experience.*`, `skill.*`,
 * `course.*`, `project.*`, `certification.*`, `summary`). That matters because
 * profile_current is "latest row per (user_id, fact_key)": if a spoken answer at
 * confidence 0.6 were appended to `contact.name`, it would silently become the
 * current name and outrank the resume's 0.95 simply by being newer. Separate key
 * spaces mean the two observations sit side by side and the structured table is
 * where they are reconciled, visibly.
 *
 * (The plan's §4 prose suggested `authorization.sponsorship` for one field. One
 * uniform namespace was chosen instead so there is a single rule to check, and
 * `answer.*` rather than `voice.*` because this endpoint also serves the typed
 * fallback — the `source` column already records which of the two it was.)
 */
import { randomUUID } from 'node:crypto';

import { arrayLiteral, sql, type SqlParam } from '@/lib/databricks';
import { GAP_FIELDS } from '@/lib/intake';
import { appendFacts, singleFact, type FactKind } from '@/lib/profile-memory';
import type { VoiceActionKind, VoiceGap } from '@/lib/voice-contract';

const GAPS = 'workspace.vthacks_2026.profile_gaps';
const GOALS = 'workspace.vthacks_2026.goals';
const PROFILES = 'workspace.vthacks_2026.profiles';
const TURNS = 'workspace.vthacks_2026.voice_turns';

/**
 * Speech is transcribed, so it can be wrong, and the user should be able to see
 * that we know it can be wrong. Typed input cannot be misheard but is still
 * self-reported and unverified, so it is not 1 either. Nothing in this system
 * reaches 1 without a verification step behind it.
 */
const CONFIDENCE = { voice: 0.6, form: 0.9 } as const;

/** Longest answer we will store. Transcripts run on; a runaway one is a bug. */
const MAX_VALUE_CHARS = 600;

/* ------------------------------------------------------------ the field table */

/**
 * Where each answer goes, besides profile_memory.
 *
 * `memory-only` is a real, honest outcome rather than a gap in this table: a spoken
 * list of past jobs has no single column to live in, and profile_experience rows are
 * owned by the document that produced them (see writeStructuredProfile in intake.ts)
 * — inventing document-less rows there would break that ownership. The action
 * sentence says so out loud instead of implying a structured write that did not
 * happen.
 */
type Target =
  | { to: 'profiles'; column: 'full_name' | 'email' | 'phone' | 'location' }
  | { to: 'goals' }
  | { to: 'memory-only' };

type FieldSpec = { label: string; kind: FactKind; target: Target };

const FIELDS: Record<string, FieldSpec> = {
  // Basics. Normally closed by a resume; open here only when extraction found nothing.
  name: { label: 'name', kind: 'contact', target: { to: 'profiles', column: 'full_name' } },
  email: { label: 'reply-to email', kind: 'contact', target: { to: 'profiles', column: 'email' } },
  phone: { label: 'phone', kind: 'contact', target: { to: 'profiles', column: 'phone' } },
  location: { label: 'location', kind: 'contact', target: { to: 'profiles', column: 'location' } },
  education: { label: 'education', kind: 'education', target: { to: 'memory-only' } },
  courses: { label: 'coursework', kind: 'course', target: { to: 'memory-only' } },
  skills: { label: 'skills', kind: 'skill', target: { to: 'memory-only' } },
  experience: { label: 'experience', kind: 'experience', target: { to: 'memory-only' } },
  projects: { label: 'projects', kind: 'project', target: { to: 'memory-only' } },
  links: { label: 'links', kind: 'contact', target: { to: 'memory-only' } },

  // The P0 decisions. No document answers any of these.
  target_role: { label: 'target role', kind: 'preference', target: { to: 'goals' } },
  employment_type: { label: 'employment type', kind: 'preference', target: { to: 'goals' } },
  work_location_pref: { label: 'where you will work', kind: 'preference', target: { to: 'goals' } },
  sponsorship: { label: 'visa sponsorship', kind: 'preference', target: { to: 'goals' } },
  work_authorization: { label: 'work authorisation', kind: 'preference', target: { to: 'goals' } },
  graduation_date: { label: 'graduation', kind: 'preference', target: { to: 'goals' } },
  comp_floor: { label: 'salary floor', kind: 'preference', target: { to: 'goals' } },
  start_date: { label: 'start date', kind: 'preference', target: { to: 'goals' } },
  accommodations: { label: 'accommodations', kind: 'preference', target: { to: 'goals' } },
};

/** Is this something the agent is allowed to write? Unknown keys are rejected. */
export function isAnswerableField(fieldKey: string): boolean {
  return Object.hasOwn(FIELDS, fieldKey);
}

export function answerableFields(): string[] {
  return Object.keys(FIELDS);
}

/* --------------------------------------------------------------- the queue */

/** Open questions, in ask order. This IS the agent's script. */
export async function openGaps(userId: string): Promise<VoiceGap[]> {
  const result = await sql(
    `SELECT field_key, question, priority FROM ${GAPS}
      WHERE user_id = :user AND status = 'open'
      ORDER BY priority`,
    [{ name: 'user', value: userId }],
  );
  return result.rows
    .map((row) => ({
      fieldKey: row[0] ?? '',
      question: row[1] ?? '',
      priority: Number(row[2] ?? 0),
    }))
    // A gap nothing can write is a question with no destination. Better to not ask
    // it than to ask it and drop the answer.
    .filter((gap) => isAnswerableField(gap.fieldKey));
}

export type VoiceContext = {
  knownName: string | null;
  factCount: number;
  skillCount: number;
  courseCount: number;
};

/** What we already know, so the opening line can prove it rather than assert it. */
export async function voiceContext(userId: string): Promise<VoiceContext> {
  const result = await sql(
    `SELECT
       (SELECT full_name FROM ${PROFILES} WHERE user_id = :user LIMIT 1),
       (SELECT count(*) FROM workspace.vthacks_2026.profile_memory WHERE user_id = :user),
       (SELECT count(*) FROM workspace.vthacks_2026.profile_skills WHERE user_id = :user),
       (SELECT count(*) FROM workspace.vthacks_2026.courses WHERE user_id = :user)`,
    [{ name: 'user', value: userId }],
  );
  const row = result.rows[0] ?? [];
  return {
    knownName: row[0] ?? null,
    factCount: Number(row[1] ?? 0),
    skillCount: Number(row[2] ?? 0),
    courseCount: Number(row[3] ?? 0),
  };
}

/**
 * Touch the tables the WRITE path uses, so the first answer is not the one that
 * pays the 20-30 second cold start.
 *
 * The queue read above already wakes the warehouse, but it only touches
 * profile_gaps; a serverless warehouse still has per-table metadata to resolve.
 * Counting rows in goals and voice_turns is about as cheap as a statement gets and
 * it is the two tables an answer writes that nothing else on this page has read.
 *
 * Never throws: failing to warm up is not a reason to refuse a session.
 */
export async function warmWritePath(userId: string): Promise<void> {
  try {
    await sql(
      `SELECT
         (SELECT count(*) FROM ${GOALS} WHERE user_id = :user),
         (SELECT count(*) FROM ${TURNS} WHERE user_id = :user)`,
      [{ name: 'user', value: userId }],
    );
  } catch {
    // Deliberately silent. This is an optimisation, not a precondition.
  }
}

/**
 * The opening line, naming what is already known.
 *
 * Written here rather than in the agent's prompt so the transcript's first line is
 * exactly what the user hears — the agent receives it as a dynamic variable. A
 * prompt-generated greeting would be a second, unlogged source of truth.
 */
export function buildFirstMessage(context: VoiceContext, gaps: VoiceGap[]): string {
  const hello = context.knownName ? `Hi ${context.knownName.split(/\s+/)[0]}.` : 'Hi.';

  if (gaps.length === 0) {
    return `${hello} I have everything I need for now — there is nothing left to ask. You can close this whenever you like.`;
  }

  const known: string[] = [];
  if (context.skillCount) known.push(`${context.skillCount} skills`);
  if (context.courseCount) known.push(`${context.courseCount} courses`);
  const read = known.length
    ? `I have read your profile — ${known.join(' and ')} so far.`
    : 'I have not been able to read much from your documents yet.';

  const count =
    gaps.length === 1 ? 'one question left' : `${gaps.length} questions left, about three minutes`;

  return `${hello} ${read} I have ${count}. You can answer out loud, or type instead — both go to the same place. First: ${gaps[0].question}`;
}

/* ---------------------------------------------------------------- coercion */

/**
 * Free text into the shapes the structured columns demand.
 *
 * Every one of these is lossy, and every one of them keeps the original words in
 * profile_memory. That is the whole design: the column is what the match query can
 * filter on, the memory is what the user actually said. When a coercion fails it
 * returns null and the column is left alone rather than being filled with a guess.
 */

/** "Backend or platform engineering, maybe data" → ['Backend', 'platform engineering', 'data'] */
function splitList(value: string): string[] {
  return value
    .split(/,|;|\bor\b|\band\b|\//i)
    .map((part) => part.replace(/^\s*(maybe|ideally|probably|preferably)\s+/i, '').trim())
    .map((part) => part.replace(/[.!?]+$/, '').trim())
    .filter((part) => part.length > 1 && part.length < 80)
    .slice(0, 8);
}

/** "$95,000" / "95k" / "about ninety-five thousand" → 95000 where it can, else null. */
function parseMoney(value: string): number | null {
  const cleaned = value.replace(/,/g, '');
  const match = /(\d+(?:\.\d+)?)\s*(k|thousand)?/i.exec(cleaned);
  if (!match) return null;
  let amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // "95k", "95 thousand", and a bare "95" all mean the same thing when the question
  // was about an annual salary. A bare 95000 is left alone.
  if (match[2] || amount < 1000) amount *= 1000;
  if (amount > 10_000_000) return null;
  return Math.round(amount);
}

/** "June 2026" → 2026-06-01. Anything V8 cannot read stays null; the words survive. */
function parseDate(value: string): string | null {
  const trimmed = value.trim();
  if (!/\d/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * The BOOLEAN problem, contained.
 *
 * goals.sponsorship_required cannot hold "I'm on F-1 OPT and I'll need H-1B in
 * about two years" and nothing will make it able to. So it is treated as a DERIVED
 * filter column: this reads the sentence, returns true / false / null, and the
 * sentence itself is what lands in profile_memory. Negation is checked first
 * because "no sponsorship needed" contains the word "sponsorship".
 *
 * null is a real answer here and means "we could not tell" — which is strictly
 * better than guessing false and quietly filtering the user out of every job that
 * sponsors.
 */
function deriveSponsorship(value: string): boolean | null {
  const text = value.toLowerCase();
  const no =
    /\b(no|not|don'?t|do not|never|none|without)\b[^.]{0,30}\b(sponsor\w*|visa|h-?1b)\b/.test(text) ||
    /\b(sponsor\w*|visa|h-?1b)\b[^.]{0,20}\b(not|isn'?t|won'?t|never)\b/.test(text) ||
    /\b(us|u\.s\.)? ?(citizen|national)\b/.test(text) ||
    /\b(permanent resident|green ?card|gc holder)\b/.test(text) ||
    /^\s*(no|nope|nah)\b/.test(text);
  if (no) return false;

  const yes =
    /\b(yes|yeah|yep|will|would|do|need|needs|require\w*|eventually|later)\b[^.]{0,40}\b(sponsor\w*|visa|h-?1b|transfer)\b/.test(text) ||
    /\b(sponsor\w*|h-?1b|f-?1|opt|cpt|stem opt|tn visa|j-?1)\b/.test(text) ||
    /^\s*(yes|yeah|yep)\b/.test(text);
  if (yes) return true;

  return null;
}

/** Drop the onsite/hybrid/remote words; whatever is left is a place. */
function extractLocations(value: string): string[] {
  const modes = /^(on-?site|in-?person|in office|hybrid|remote|flexible|anywhere|either|any)$/i;
  return splitList(value).filter((part) => !modes.test(part.replace(/\s+/g, ' ').trim()));
}

/* ------------------------------------------------------- structured writes */

/** One column assignment in the goals MERGE. `expr` is SQL; values stay bound. */
type Assignment = { column: string; expr: string; params: SqlParam[] };

/** A human note appended to the action sentence when a coercion did something. */
type Derivation = string;

/**
 * Column names come from this function and nowhere else.
 *
 * The request body supplies `field_key` and `value`; the COLUMN is looked up from a
 * literal here. That is what stops a transcribed sentence from choosing which part
 * of the schema to write to, and it is why a whitelist beats escaping for
 * identifiers — there is no correct way to bind a column name as a parameter.
 */
function goalsAssignments(
  fieldKey: string,
  value: string,
): { assignments: Assignment[]; derivations: Derivation[] } {
  const derivations: Derivation[] = [];
  const text: Assignment = { column: '', expr: ':value', params: [] };

  switch (fieldKey) {
    case 'target_role': {
      const roles = splitList(value);
      return {
        assignments: [{ column: 'target_roles', expr: arrayLiteral(roles.length ? roles : [value]), params: [] }],
        derivations: roles.length > 1 ? [`split into ${roles.length} roles for the match query`] : [],
      };
    }

    case 'employment_type':
      return { assignments: [{ ...text, column: 'employment_type' }], derivations };

    case 'work_location_pref': {
      const places = extractLocations(value);
      const assignments: Assignment[] = [{ ...text, column: 'work_location_pref' }];
      if (places.length) {
        assignments.push({ column: 'locations', expr: arrayLiteral(places), params: [] });
        derivations.push(`locations set to ${places.join(', ')}`);
      }
      return { assignments, derivations };
    }

    case 'sponsorship': {
      // The words go to memory (the caller always does that). Here we only derive
      // the boolean the match query can actually filter on.
      const derived = deriveSponsorship(value);
      derivations.push(
        derived === null
          ? 'I could not turn that into a yes/no for the job filter, so I left the filter unset and kept your exact words'
          : `job filter set to sponsorship ${derived ? 'required' : 'not required'}`,
      );
      return {
        assignments: [
          {
            column: 'sponsorship_required',
            expr: derived === null ? 'CAST(NULL AS BOOLEAN)' : ':sponsorship',
            params: derived === null ? [] : [{ name: 'sponsorship', value: String(derived), type: 'BOOLEAN' }],
          },
        ],
        derivations,
      };
    }

    case 'work_authorization':
      return { assignments: [{ ...text, column: 'work_authorization' }], derivations };

    case 'graduation_date':
      // STRING on purpose. "May 2027" is a real answer and a DATE column would
      // either reject it or invent a day.
      return { assignments: [{ ...text, column: 'graduation_date' }], derivations };

    case 'comp_floor': {
      const amount = parseMoney(value);
      derivations.push(
        amount === null
          ? 'I could not read a number out of that, so the salary filter is still unset'
          : `salary floor read as $${amount.toLocaleString('en-US')}`,
      );
      return {
        assignments: [
          {
            column: 'comp_floor',
            expr: amount === null ? 'CAST(NULL AS DOUBLE)' : ':comp',
            params: amount === null ? [] : [{ name: 'comp', value: String(amount), type: 'DOUBLE' }],
          },
        ],
        derivations,
      };
    }

    case 'start_date': {
      const date = parseDate(value);
      derivations.push(
        date === null
          ? 'I kept your wording; there was no date in it precise enough to filter on'
          : `earliest start read as ${date}`,
      );
      return {
        assignments: [
          {
            column: 'start_date',
            expr: date === null ? 'CAST(NULL AS DATE)' : 'CAST(:start AS DATE)',
            params: date === null ? [] : [{ name: 'start', value: date }],
          },
        ],
        derivations,
      };
    }

    case 'accommodations':
      return { assignments: [{ ...text, column: 'accommodations' }], derivations };

    default:
      return { assignments: [], derivations };
  }
}

async function writeGoals(userId: string, value: string, assignments: Assignment[]): Promise<void> {
  if (assignments.length === 0) return;

  const parameters: SqlParam[] = [
    { name: 'user', value: userId },
    { name: 'value', value: value },
    ...assignments.flatMap((assignment) => assignment.params),
  ];

  const set = assignments.map((a) => `${a.column} = ${a.expr}`).join(', ');
  const columns = assignments.map((a) => a.column).join(', ');
  const values = assignments.map((a) => a.expr).join(', ');

  // MERGE rather than UPDATE-then-INSERT: goals is one row per user and may not
  // exist yet (it is empty until someone answers something).
  await sql(
    `MERGE INTO ${GOALS} AS t
     USING (SELECT :user AS user_id) AS s
        ON t.user_id = s.user_id
      WHEN MATCHED THEN UPDATE SET ${set}, updated_at = current_timestamp()
      WHEN NOT MATCHED THEN INSERT (user_id, ${columns}, updated_at)
           VALUES (:user, ${values}, current_timestamp())`,
    parameters,
  );
}

async function writeProfileColumn(
  userId: string,
  column: 'full_name' | 'email' | 'phone' | 'location',
  value: string,
): Promise<void> {
  // NOT coalesce()-guarded, unlike the intake path. A user answering a question out
  // loud is the most recent and most deliberate statement we have about themselves,
  // so it wins over whatever a PDF said. The previous value is still in
  // profile_memory; nothing is lost, it is just no longer current.
  await sql(
    `MERGE INTO ${PROFILES} AS t
     USING (SELECT :user AS user_id) AS s
        ON t.user_id = s.user_id
      WHEN MATCHED THEN UPDATE SET ${column} = :value, updated_at = current_timestamp()
      WHEN NOT MATCHED THEN INSERT (user_id, ${column}, updated_at)
           VALUES (:user, :value, current_timestamp())`,
    [
      { name: 'user', value: userId },
      { name: 'value', value },
    ],
  );
}

/* ------------------------------------------------------------------- gaps */

/**
 * Close the gap.
 *
 * MERGE, not UPDATE, so a volunteered answer to a question that was never queued
 * still records itself — someone who types "I graduate in May 2027" before being
 * asked should not have that dropped, and should not be asked afterwards.
 *
 * Re-answering an already-answered gap overwrites answer_value and answered_at and
 * nothing else. That is the deliberate asymmetry with profile_memory: the gap row is
 * a piece of queue STATE ("stop asking this"), not a record of what was said, and
 * the record of what was said is append-only one table over.
 */
async function closeGap(
  userId: string,
  fieldKey: string,
  value: string,
  answerSource: 'voice' | 'form',
): Promise<void> {
  const known = GAP_FIELDS.find((gap) => gap.field === fieldKey);
  await sql(
    `MERGE INTO ${GAPS} AS t
     USING (SELECT :user AS user_id, :field AS field_key) AS s
        ON t.user_id = s.user_id AND t.field_key = s.field_key
      WHEN MATCHED THEN UPDATE SET
        status = 'answered', answer_value = :value, answer_source = :source,
        answered_at = current_timestamp(), updated_at = current_timestamp()
      WHEN NOT MATCHED THEN INSERT
        (user_id, field_key, status, priority, question, answer_value, answer_source, answered_at, updated_at)
        VALUES (:user, :field, 'answered', :priority, :question, :value, :source,
                current_timestamp(), current_timestamp())`,
    [
      { name: 'user', value: userId },
      { name: 'field', value: fieldKey },
      { name: 'value', value },
      { name: 'source', value: answerSource },
      { name: 'priority', value: String(known?.priority ?? 900), type: 'INT' },
      { name: 'question', value: known?.question ?? null },
    ],
  );
}

async function countOpenGaps(userId: string): Promise<number> {
  const result = await sql(
    `SELECT count(*) FROM ${GAPS} WHERE user_id = :user AND status = 'open'`,
    [{ name: 'user', value: userId }],
  );
  return Number(result.rows[0]?.[0] ?? 0);
}

/* ------------------------------------------------------------------ turns */

export type TurnRow = {
  role: 'user' | 'agent' | 'action';
  text: string;
  actionKind?: VoiceActionKind;
  actionDetail?: string;
  fieldKey?: string;
};

/**
 * Log the turns an answer produced — the utterance and the action it caused.
 *
 * ONE statement for both rows, not one each. Every Databricks round trip is real
 * latency inside a live conversation, and this runs on every single answer.
 *
 * Agent SPEECH is deliberately not persisted here. Logging every sentence the agent
 * says would double the write volume of a conversation for telemetry we already have
 * — ElevenLabs keeps the full transcript against the same conversation_id, and the
 * browser shows it live. What is worth storing is what the system DID, which is the
 * role='action' rows.
 */
export async function logTurns(args: {
  userId: string;
  conversationId: string;
  startIndex: number;
  rows: TurnRow[];
}): Promise<void> {
  if (args.rows.length === 0) return;

  const parameters: SqlParam[] = [
    { name: 'user', value: args.userId },
    { name: 'conv', value: args.conversationId },
  ];
  const tuples = args.rows.map((row, i) => {
    parameters.push(
      { name: `id${i}`, value: randomUUID() },
      { name: `idx${i}`, value: String(args.startIndex + i), type: 'INT' },
      { name: `role${i}`, value: row.role },
      { name: `text${i}`, value: row.text.slice(0, 4000) },
      { name: `kind${i}`, value: row.actionKind ?? null },
      { name: `detail${i}`, value: row.actionDetail ?? null },
      { name: `field${i}`, value: row.fieldKey ?? null },
    );
    return `(:id${i}, :user, :conv, :idx${i}, :role${i}, :text${i}, :kind${i}, :detail${i}, :field${i}, current_timestamp())`;
  });

  await sql(
    `INSERT INTO ${TURNS}
       (turn_id, user_id, conversation_id, turn_index, role, text, action_kind, action_detail, field_key, spoken_at)
     VALUES ${tuples.join(', ')}`,
    parameters,
  );
}

async function nextTurnIndex(conversationId: string): Promise<number> {
  const result = await sql(
    `SELECT coalesce(max(turn_index), -1) + 1 FROM ${TURNS} WHERE conversation_id = :conv`,
    [{ name: 'conv', value: conversationId }],
  );
  return Number(result.rows[0]?.[0] ?? 0);
}

/* ----------------------------------------------------------- the write path */

export type RecordAnswerInput = {
  userId: string;
  fieldKey: string;
  value: string;
  conversationId: string;
  source: 'voice' | 'form';
  spokenText?: string;
  turnIndex?: number;
};

export type RecordAnswerOutput = {
  action: string;
  actionKind: VoiceActionKind;
  fieldKey: string;
  storedValue: string;
  confidence: number;
  gapsRemaining: number;
};

export class VoiceAnswerError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'VoiceAnswerError';
    this.status = status;
  }
}

/**
 * Record one answer. The single write path for voice AND typed input.
 *
 * Returns the sentence the transcript shows. That sentence is not decoration: it is
 * how the user finds out the agent misheard them. "I recorded X" where X is wrong is
 * recoverable; a silent wrong value is not, which is why every branch below says what
 * it actually did, including the coercions that failed.
 */
export async function recordAnswer(input: RecordAnswerInput): Promise<RecordAnswerOutput> {
  const fieldKey = input.fieldKey.trim();
  const spec = FIELDS[fieldKey];
  if (!spec) {
    throw new VoiceAnswerError(
      `"${fieldKey}" is not a question this agent can answer. Known fields: ${answerableFields().join(', ')}.`,
    );
  }

  const value = input.value.trim().slice(0, MAX_VALUE_CHARS);
  if (!value) throw new VoiceAnswerError('An answer cannot be empty.');

  const confidence = CONFIDENCE[input.source];

  // 1. MEMORY FIRST. If everything after this fails we still have what they said.
  await appendFacts([
    singleFact({
      userId: input.userId,
      kind: spec.kind,
      key: `answer.${fieldKey}`,
      value,
      confidence,
      source: input.source,
      // The conversation is the artifact that produced the fact, the way a
      // document_id is for a resume.
      sourceRef: input.conversationId,
    }),
  ]);

  // 2. The structured row: what the match query can filter on.
  const derivations: string[] = [];
  if (spec.target.to === 'goals') {
    const { assignments, derivations: notes } = goalsAssignments(fieldKey, value);
    await writeGoals(input.userId, value, assignments);
    derivations.push(...notes);
  } else if (spec.target.to === 'profiles') {
    await writeProfileColumn(input.userId, spec.target.column, value);
  } else {
    derivations.push(
      'kept in your profile memory — this one has no structured slot yet, so nothing filters on it',
    );
  }

  // 3. Stop asking.
  await closeGap(input.userId, fieldKey, value, input.source);

  const gapsRemaining = await countOpenGaps(input.userId);

  const detail = derivations.length ? ` (${derivations.join('; ')})` : '';
  const action = `Updated your profile — ${spec.label}: ${value}${detail}`;

  // 4. The audit trail of 1-3. Last, and never fatal: losing a log line must not
  // turn a successful write into an error the user sees as a failure.
  try {
    const startIndex = input.turnIndex ?? (await nextTurnIndex(input.conversationId));
    const rows: TurnRow[] = [];
    if (input.spokenText?.trim()) {
      rows.push({ role: 'user', text: input.spokenText.trim(), fieldKey });
    }
    rows.push({
      role: 'action',
      text: action,
      actionKind: 'profile_updated',
      actionDetail: JSON.stringify({ fieldKey, value, confidence, source: input.source }),
      fieldKey,
    });
    await logTurns({
      userId: input.userId,
      conversationId: input.conversationId,
      startIndex,
      rows,
    });
  } catch (error) {
    console.error('voice: failed to log turns', (error as Error).message);
  }

  return {
    action,
    actionKind: 'profile_updated',
    fieldKey,
    storedValue: value,
    confidence,
    gapsRemaining,
  };
}
