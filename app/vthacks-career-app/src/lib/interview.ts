/**
 * interview.ts — the server half of the video mock interview.
 *
 * WHAT UNLOCKS IT. One read of `latest_application_state`. The room opens when the
 * stage is `interviewing` or `offer` and refuses otherwise, with the reason on
 * screen. `interviewing` is also what the pipeline normalises an employer `callback`
 * event to, so a reply the A2A lane detected opens this without the student marking
 * anything by hand — which is the whole point of "once an application has gained a
 * response".
 *
 * NO NEW TABLES. The transcript goes to `voice_turns` with `conversation_id` set to
 * the interview session id, exactly like a voice conversation, and the session
 * telemetry goes to `voice_events` keyed on `applicationId(userId, jobId)`. Both
 * tables already exist and both are append-only. CLAUDE.md says extend the schema,
 * do not build a parallel one, and a mock interview genuinely is a voice session
 * with an application attached.
 *
 * `interview_feedback` IS FINALLY REACHED. voice-contract.ts has carried that action
 * kind since the actor rewrite with a comment saying nothing produces it yet. This
 * file produces it. The comment in voice-contract.ts was updated in the same change.
 *
 * FOUR UPGRADES, FOUR GATES, ONE FLOOR. Gemini writes the questions, ElevenLabs
 * persona 2 asks them out loud, ElevenLabs Scribe transcribes the spoken answers,
 * and Presage reads steadiness off the webcam. Every one of them is absent from `.env.local`
 * today. Each is checked independently and each missing one adds a sentence to
 * `degraded` rather than failing the request: the floor is a typed interview with
 * deterministic questions and it is a real feature on its own.
 */
import { randomUUID } from 'node:crypto';

import { loadContext } from '@/lib/artifacts/context.mjs';
import { sql } from '@/lib/databricks';
import { interviewerConfig, signedConversationUrl } from '@/lib/elevenlabs';
import {
  emptyVitals,
  lockedReason,
  pacingNote,
  vitalsSentence,
  type AnswerCritique,
  type InterviewAnswer,
  type InterviewFeedback,
  type InterviewQuestion,
  type InterviewSessionPayload,
  type QuestionSource,
  type VitalsSummary,
} from '@/lib/interview-contract';
import { deterministicQuestions, geminiQuestions, type QuestionInputs } from '@/lib/interview-questions';
import { applicationId } from '@/lib/pipeline';
import { toStage, type PipelineStatus } from '@/lib/pipeline-contract';
import { vitalsReady } from '@/lib/presage';
import { sttReady } from '@/lib/scribe';
import { logTurns } from '@/lib/voice';

const FQ = 'workspace.vthacks_2026';

/** Session ids are prefixed so a `voice_turns` row is attributable at a glance. */
export function interviewSessionId(): string {
  return `interview:${randomUUID()}`;
}

export function isInterviewSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('interview:') && value.length > 'interview:'.length;
}

/**
 * The stage this user has this job at, or null if the job is not on their board.
 *
 * Reads the same view the board reads and normalises through the same `toStage`, so
 * "they replied" means the same thing here as it does on the board. A second
 * definition of the gate is a second thing to get wrong.
 */
export async function currentStage(userId: string, jobId: string): Promise<PipelineStatus | null> {
  const result = await sql(
    `SELECT current_state FROM ${FQ}.latest_application_state WHERE user_id = :user_id AND job_id = :job_id`,
    [
      { name: 'user_id', value: userId },
      { name: 'job_id', value: jobId },
    ],
  );
  return toStage(result.rows[0]?.[0] ?? null);
}

/* ------------------------------------------------------- the question store */

/**
 * The question set for a live session, held in the process that minted it.
 *
 * WHY NOT A TABLE. The questions are worthless the moment the interview ends — the
 * transcript keeps each question as its own `voice_turns` row, so the durable record
 * is already complete. Writing a set to Delta at session start would add a warehouse
 * round trip to opening the room, on a warehouse that cold-starts in 20-30 seconds,
 * to hold data for ten minutes.
 *
 * WHY NOT TRUST THE CLIENT. The critique reads `looksLike` off the question, so a
 * client that posted its own question could shape its own feedback. That harms
 * nobody but the student rehearsing, which is why the fallback below is allowed at
 * all: if this process restarted mid-interview, a client-supplied question is much
 * better than dropping the answer. What it may never do is reach the database as
 * anything but text, and it does not.
 *
 * Single process behind Caddy (server.mjs), same as presage.ts. On a platform that
 * scales this out, sessions would need pinning or this becomes a table.
 */
const questionStore = new Map<string, { questions: InterviewQuestion[]; at: number }>();

/** Long enough for a slow interview, short enough that a leak is bounded. */
const STORE_TTL_MS = 60 * 60 * 1000;

function rememberQuestions(sessionId: string, questions: InterviewQuestion[]): void {
  const now = Date.now();
  for (const [id, entry] of questionStore) {
    if (now - entry.at > STORE_TTL_MS) questionStore.delete(id);
  }
  questionStore.set(sessionId, { questions, at: now });
}

export function recallQuestions(sessionId: string): InterviewQuestion[] | null {
  return questionStore.get(sessionId)?.questions ?? null;
}

/* ------------------------------------------------------------------ session */

export async function buildSession(userId: string, jobId: string): Promise<InterviewSessionPayload | { error: string; status: number }> {
  const stage = await currentStage(userId, jobId);
  const locked = lockedReason(stage);

  const context = await loadContext(sql, userId, jobId);
  if (!context.ok) return { error: context.error, status: context.status };

  const jobTitle = context.job.job_title ?? 'this role';
  const company = context.job.company_name ?? 'this company';

  // A locked room still needs a title and a company to explain itself with, but it
  // must not spend a model call or mint a conversation credential for an interview
  // that cannot start. Everything expensive is below this line.
  if (locked) {
    return {
      sessionId: interviewSessionId(),
      jobId,
      jobTitle,
      company,
      locked,
      questions: [],
      questionSource: 'jd-deterministic',
      degraded: [],
      signedUrl: null,
      dynamicVariables: {},
      sttReady: false,
      vitalsReady: false,
    };
  }

  const inputs = questionInputs(context, jobTitle, company);
  const degraded: string[] = [];

  const floor = deterministicQuestions(inputs);
  let questions = floor;
  let questionSource: QuestionSource = 'jd-deterministic';
  try {
    questions = await geminiQuestions(inputs);
    questionSource = 'gemini';
  } catch (error) {
    // Expected whenever GOOGLE_GENERATIVE_AI_API_KEY is unset, which is every local
    // checkout today. Logged at info, not error, so a missing key does not look like
    // an incident in the container logs.
    console.info('[interview] falling back to deterministic questions:', (error as Error).message);
    degraded.push(
      'Gemini did not write the questions, so these were built from the posting and your match gaps instead.',
    );
  }

  const sessionId = interviewSessionId();
  rememberQuestions(sessionId, questions);

  let signedUrl: string | null = null;
  const configured = interviewerConfig();
  if ('reason' in configured) {
    degraded.push(configured.reason);
  } else {
    try {
      signedUrl = await signedConversationUrl(configured.config);
    } catch (error) {
      console.error('[interview] signed URL request failed', (error as Error).message);
      degraded.push('The interviewer voice could not be reached, so the questions are on screen instead.');
    }
  }

  const stt = sttReady();
  if (!stt) degraded.push('Speech-to-text is not switched on, so answers are typed.');
  const vitals = vitalsReady();
  if (!vitals) degraded.push('The steadiness read is not switched on. Your camera still runs locally for the self-view.');

  // Telemetry, not state. A failed write must not stop an interview starting, so
  // this is fired and forgotten with its own catch.
  void logEvent(userId, jobId, sessionId, 'interview_started', 'started', {
    question_source: questionSource,
    questions: questions.length,
    stage,
    voice: signedUrl !== null,
    stt,
    vitals,
  });

  return {
    sessionId,
    jobId,
    jobTitle,
    company,
    locked: null,
    questions,
    questionSource,
    degraded,
    signedUrl,
    // Read by the model and spoken out loud. Nothing secret belongs in here.
    dynamicVariables: {
      role_title: jobTitle,
      company_name: company,
      candidate_name: context.profile.fullName ?? 'there',
      question_count: String(questions.length),
      question_queue: questions.map((q, i) => `${i + 1}. [${q.id}] ${q.text}`).join('\n'),
    },
    sttReady: stt,
    vitalsReady: vitals,
  };
}

type LoadedContext = Extract<Awaited<ReturnType<typeof loadContext>>, { ok: true }>;

function questionInputs(context: LoadedContext, jobTitle: string, company: string): QuestionInputs {
  const recent = context.facts.structured.experience[0] ?? null;
  return {
    jobTitle,
    company,
    description: context.job.description_text ?? '',
    skillsMissing: context.cachedMatch?.skills_missing ?? [],
    skillsMatched: context.cachedMatch?.skills_matched ?? [],
    recentRole: recent
      ? { title: recent.title, company: recent.company, bullet: recent.bullets[0] ?? null }
      : null,
    courses: context.profile.courses.map((course) => course.course_code),
  };
}

/* ----------------------------------------------------------------- critique */

/** Filler words counted verbatim. Naming them beats "you used filler words". */
const FILLERS = ['um', 'uh', 'like', 'basically', 'literally', 'sort of', 'kind of', 'you know'];

/** Answers shorter than this are not answers, and saying so is the useful feedback. */
const THIN_WORDS = 30;

/**
 * Critique one answer. NO MODEL CALL, and that is deliberate.
 *
 * Everything here is countable: length, pace, first person, whether a number
 * appears, which of the question's own `looksLike` points the answer touched. A
 * model would write warmer prose and would also, on a bad day, invent a criticism of
 * something the student did not say. Countable feedback is checkable feedback, and a
 * student can see for themselves that it is right.
 *
 * TRANSCRIPTION IS NOT HELD AGAINST THEM. Scribe mishears technical words, so the
 * only thing `source` changes is that a transcribed answer never gets a note about
 * wording — just structure, pace and coverage.
 */
export function critique(question: InterviewQuestion, answer: InterviewAnswer): AnswerCritique {
  const text = answer.text.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const lower = ` ${text.toLowerCase()} `;
  const notes: string[] = [];

  if (words === 0) {
    return { questionId: question.id, notes: ['You skipped this one.'], missing: question.looksLike, words: 0, spokenSeconds: answer.spokenSeconds };
  }

  if (words < THIN_WORDS) {
    notes.push(`That was ${words} words. An interviewer will read it as "no example ready" and move on.`);
  } else if (words > 400) {
    notes.push(`That was ${words} words, which is long enough that the point gets lost. Aim for the shape, then stop.`);
  }

  const pace = pacingNote(words, answer.spokenSeconds);
  if (pace) notes.push(pace);

  // "We" with no "I" is the single most common way a strong project answer fails.
  const saysI = /\bi\b|\bmy\b/.test(lower);
  const saysWe = /\bwe\b|\bour\b/.test(lower);
  if (saysWe && !saysI) {
    notes.push('You said "we" throughout and never "I". They cannot tell what you personally did.');
  }

  if (/\d/.test(text)) {
    notes.push('You put a number in it, which is what makes an answer stick.');
  } else if (question.kind === 'experience' || question.kind === 'behavioural') {
    notes.push('No number anywhere. A size, a duration, or a before-and-after would anchor this.');
  }

  const found = FILLERS.filter((filler) => lower.includes(` ${filler} `));
  if (answer.source !== 'typed' && found.length >= 2) {
    notes.push(`Filler you leaned on: ${found.slice(0, 3).join(', ')}. Worth a pause instead.`);
  }

  return {
    questionId: question.id,
    notes,
    missing: uncovered(question, lower),
    words,
    spokenSeconds: answer.spokenSeconds,
  };
}

/**
 * Which of the question's "strong answer" points the answer did not touch.
 *
 * Keyword overlap, not semantics: a point counts as covered when the answer contains
 * a content word from it. That is a coarse test and it is tuned to under-report — it
 * would rather stay quiet than tell a student they missed something they said in
 * different words. A false "you missed this" is the feedback that makes someone stop
 * trusting the tool.
 */
function uncovered(question: InterviewQuestion, lowerAnswer: string): string[] {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'your', 'you', 'it',
    'that', 'this', 'not', 'is', 'are', 'was', 'were', 'be', 'no', 'one', 'two', 'three', 'than',
    'then', 'what', 'which', 'who', 'ready', 'says', 'said', 'ends', 'names', 'something',
  ]);
  return question.looksLike.filter((point) => {
    const keywords = point
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((word) => word.length > 3 && !stop.has(word));
    if (keywords.length === 0) return false;
    return !keywords.some((word) => lowerAnswer.includes(word));
  });
}

/* ----------------------------------------------------------------- feedback */

/**
 * The closing readout.
 *
 * Written from the critiques, in this order: what was answered, the two things worth
 * fixing first, the pacing if we measured it, then the steadiness sentence. It never
 * grades and it never scores. A number out of ten on a rehearsal is a number people
 * argue with instead of acting on.
 */
export function buildFeedback(
  questions: InterviewQuestion[],
  answers: InterviewAnswer[],
  vitals: VitalsSummary,
): InterviewFeedback {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const critiques: AnswerCritique[] = [];
  const unanswered: string[] = [];

  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer || !answer.text.trim()) {
      unanswered.push(question.text);
      continue;
    }
    critiques.push(critique(question, answer));
  }

  const answered = critiques.length;
  const totalWords = critiques.reduce((sum, item) => sum + item.words, 0);
  const missedPoints = critiques.flatMap((item) => item.missing);

  const lines: string[] = [];
  lines.push(
    answered === 0
      ? 'You opened the room and did not answer anything, so there is nothing to read back yet.'
      : `You answered ${answered} of ${questions.length} questions, ${totalWords} words in total.`,
  );

  if (unanswered.length) {
    lines.push(
      `Left unanswered: ${unanswered.length === 1 ? 'one question' : `${unanswered.length} questions`}, starting with "${truncate(unanswered[0])}". The ones people skip in rehearsal are the ones that land badly live.`,
    );
  }

  if (missedPoints.length) {
    const top = [...new Set(missedPoints)].slice(0, 2);
    lines.push(`Across your answers the thing missing most often was: ${top.join('; and ')}.`);
  } else if (answered > 0) {
    lines.push('Every answer touched what a strong answer needs, which is rarer than it sounds.');
  }

  const timed = critiques.filter((item) => item.spokenSeconds !== null);
  if (timed.length) {
    const seconds = timed.reduce((sum, item) => sum + (item.spokenSeconds ?? 0), 0);
    lines.push(`You spoke for ${Math.round(seconds)} seconds across ${timed.length} spoken answers.`);
  }

  const vitalsNote = vitalsSentence(vitals);
  if (vitalsNote) lines.push(vitalsNote);

  return {
    summary: lines.join(' '),
    critiques,
    unanswered,
    vitals,
    vitalsNote,
    source: 'jd-deterministic',
  };
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* -------------------------------------------------------------- persistence */

/**
 * Persist one exchange: what was asked, what was said, and nothing else.
 *
 * Mirrors voice.ts's decision not to store agent speech — except here the QUESTION
 * is the artefact worth keeping, because a critique nobody can trace back to its
 * question is unreadable a week later. So the question goes in as the `agent` turn
 * and the answer as the `user` turn.
 */
export async function logExchange(args: {
  userId: string;
  sessionId: string;
  question: InterviewQuestion;
  answer: InterviewAnswer;
}): Promise<void> {
  await logTurns({
    userId: args.userId,
    conversationId: args.sessionId,
    startIndex: await nextIndex(args.sessionId),
    rows: [
      { role: 'agent', text: args.question.text },
      { role: 'user', text: args.answer.text },
    ],
  });
}

/** The closing readout, as the `interview_feedback` action row this kind was reserved for. */
export async function logFeedback(args: {
  userId: string;
  jobId: string;
  sessionId: string;
  feedback: InterviewFeedback;
}): Promise<void> {
  await logTurns({
    userId: args.userId,
    conversationId: args.sessionId,
    startIndex: await nextIndex(args.sessionId),
    rows: [
      {
        role: 'action',
        text: args.feedback.summary,
        actionKind: 'interview_feedback',
        actionDetail: JSON.stringify({
          job_id: args.jobId,
          answered: args.feedback.critiques.length,
          unanswered: args.feedback.unanswered.length,
        }),
      },
    ],
  });

  await logEvent(args.userId, args.jobId, args.sessionId, 'interview_finished', 'completed', {
    answered: args.feedback.critiques.length,
    unanswered: args.feedback.unanswered.length,
    // Aggregate only. No frame, no image, and no per-moment reading is stored.
    vitals: args.feedback.vitals.usable > 0 ? args.feedback.vitals : null,
  });
}

async function nextIndex(sessionId: string): Promise<number> {
  const result = await sql(
    `SELECT coalesce(max(turn_index), -1) + 1 FROM ${FQ}.voice_turns WHERE conversation_id = :conv`,
    [{ name: 'conv', value: sessionId }],
  );
  return Number(result.rows[0]?.[0] ?? 0);
}

/**
 * One telemetry row. NEVER throws — a failed telemetry write must not take an
 * interview down with it, and every caller is in the middle of one.
 */
export async function logEvent(
  userId: string,
  jobId: string,
  sessionId: string,
  eventType: string,
  outcome: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await sql(
      `INSERT INTO ${FQ}.voice_events
         (voice_event_id, application_id, session_id, event_type, outcome, event_at, metadata_json)
       VALUES (:id, :application_id, :session_id, :event_type, :outcome, current_timestamp(), :metadata_json)`,
      [
        { name: 'id', value: randomUUID() },
        { name: 'application_id', value: applicationId(userId, jobId) },
        { name: 'session_id', value: sessionId },
        { name: 'event_type', value: eventType },
        { name: 'outcome', value: outcome },
        { name: 'metadata_json', value: JSON.stringify({ feature: 'mock_interview', ...metadata }) },
      ],
    );
  } catch (error) {
    console.error('[interview] telemetry write failed:', (error as Error).message);
  }
}

export { emptyVitals };
