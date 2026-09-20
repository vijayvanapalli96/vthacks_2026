/**
 * transcript.ts — the message-by-message record of one agent-to-agent exchange,
 * MongoDB Atlas `hirewire.a2a_transcripts`.
 *
 * `a2a_audit` already records the DECISION: one document per verify or apply,
 * with the verdict, the five dimensions, and the field names released. What it
 * cannot answer is "what did the two agents actually say to each other, and in
 * what order". That is this collection: one document per exchange, holding the
 * turns in sequence — the ANS lookup, the agent-card fetch, the signed envelope
 * we posted, and the receipt that came back.
 *
 * SAME PII RULE AS THE AUDIT LOG, for the same reason. A turn records field
 * NAMES, endpoints, ANS names, envelope claims and HTTP statuses. It never
 * records a field's value, so the transcript cannot become the leak the
 * handshake exists to prevent. `withoutValues` below is the enforcement; the
 * rule is not left to the comment.
 *
 * INSERT-ONLY, like the audit log, and best-effort: a transcript that cannot be
 * saved must never fail the application it describes.
 */
import { randomUUID } from 'node:crypto';

import { mongoCollection } from '../mongo';

/**
 * Three parties, because the chain genuinely has three. Folding the registry
 * into the employer would draw the applicant agent asking the employer whether
 * the employer is real — the one question it must not take that agent's word
 * for.
 */
export type TurnParty = 'applicant_agent' | 'employer_agent' | 'ans_registry';

export type Turn = {
  seq: number;
  at: string;
  from: TurnParty;
  to: TurnParty;
  /** Short headline, written by us from what happened. Never model output. */
  label: string;
  /** The deterministic facts of the turn, in one sentence. Never model output. */
  detail: string;
  /** PII-free structured facts: ANS names, endpoints, field names, claims. */
  data?: Record<string, unknown>;
  outcome: 'ok' | 'refused' | 'failed';
  /**
   * The applicant agent's own line, written by Gemini AFTER the turn happened
   * and from these same PII-free facts. Narration only: it is attached to a
   * turn that already took place and cannot change a verdict, a field, or a
   * byte on the wire. Null whenever there is no key or the call failed, which
   * is why every turn still reads correctly without it.
   */
  said?: string | null;
};

export type TranscriptDocument = {
  transcript_id: string;
  user_id: string | null;
  job_id: string | null;
  employer: string;
  audit_id: string | null;
  outcome: 'submitted' | 'refused' | 'delivery_failed';
  narrator: 'gemini' | 'none';
  started_at: Date;
  finished_at: Date;
  turns: Turn[];
};

const COLLECTION = 'a2a_transcripts';

/**
 * Field VALUES must never reach this collection, so what is about to be written
 * is checked against the values actually being released rather than trusted to
 * a convention. A turn that carries one is dropped, not quietly trimmed.
 */
function withoutValues(
  data: Record<string, unknown> | undefined,
  forbidden: string[],
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const serialised = JSON.stringify(data).toLowerCase();
  // Two characters or fewer is not identifying and would false-positive on
  // ordinary words; longer values are matched whole.
  const leaked = forbidden.some((value) => value.length > 2 && serialised.includes(value.toLowerCase()));
  if (!leaked) return data;
  console.error('Dropped A2A transcript turn data that contained a released field value');
  return { redacted: 'This turn carried a released field value and was dropped before it was written.' };
}

export type Recorder = {
  turn: (turn: Omit<Turn, 'seq' | 'at'>) => Turn;
  turns: () => Turn[];
  /** The candidate values being released, which must never appear in a turn. */
  guard: (values: unknown[]) => void;
};

/**
 * Collects the turns of one exchange and hands each finished turn to `emit`,
 * which is how the streaming route pushes a turn to the browser the moment it
 * happens rather than after the whole handshake is over.
 */
export function createRecorder(emit?: (turn: Turn) => void): Recorder {
  const turns: Turn[] = [];
  let forbidden: string[] = [];
  return {
    guard(values) {
      forbidden = values.flatMap((value) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : typeof value === 'string'
            ? [value]
            : [],
      );
    },
    turn(partial) {
      const turn: Turn = {
        ...partial,
        data: withoutValues(partial.data, forbidden),
        seq: turns.length + 1,
        at: new Date().toISOString(),
      };
      turns.push(turn);
      emit?.(turn);
      return turn;
    },
    turns: () => turns,
  };
}

export async function saveTranscript(
  input: Omit<TranscriptDocument, 'transcript_id' | 'finished_at'>,
): Promise<string | null> {
  try {
    const transcripts = await mongoCollection<TranscriptDocument>(COLLECTION, [
      { key: { transcript_id: 1 }, name: 'transcript_id', unique: true },
      { key: { user_id: 1, finished_at: -1 }, name: 'user_finished' },
      { key: { audit_id: 1 }, name: 'audit_id' },
    ]);
    if (!transcripts) return null;
    const document: TranscriptDocument = {
      ...input,
      transcript_id: randomUUID(),
      finished_at: new Date(),
    };
    await transcripts.insertOne(document);
    return document.transcript_id;
  } catch (error) {
    console.error('Could not write the A2A transcript', error);
    return null;
  }
}

/** One saved transcript, scoped to the applicant it belongs to. */
export async function readTranscript(transcriptId: string, userId: string): Promise<TranscriptDocument | null> {
  try {
    const transcripts = await mongoCollection<TranscriptDocument>(COLLECTION);
    if (!transcripts) return null;
    return await transcripts.findOne({ transcript_id: transcriptId, user_id: userId }, { projection: { _id: 0 } });
  } catch (error) {
    console.error('Could not read the A2A transcript', error);
    return null;
  }
}

export async function recentTranscripts(userId: string, limit = 20): Promise<TranscriptDocument[] | null> {
  try {
    const transcripts = await mongoCollection<TranscriptDocument>(COLLECTION);
    if (!transcripts) return null;
    return await transcripts
      .find({ user_id: userId }, { projection: { _id: 0 } })
      .sort({ finished_at: -1 })
      .limit(Math.min(limit, 100))
      .toArray();
  } catch (error) {
    console.error('Could not list the A2A transcripts', error);
    return null;
  }
}
