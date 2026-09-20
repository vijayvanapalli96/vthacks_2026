/**
 * interview-contract.ts — the mock-interview vocabulary, with no runtime dependencies.
 *
 * Same split, same reason, as pipeline-contract.ts and voice-contract.ts next door:
 * the interview room is a client component and `interview.ts` imports the Databricks
 * client, so anything the browser needs to know lives here instead. Pure data and
 * pure functions only. Do not add an import that is not `type`-only.
 *
 * WHY A SEPARATE CONTRACT AT ALL, rather than widening voice-contract.ts. A mock
 * interview is not a profile conversation wearing a different prompt: it has a
 * question SET fixed up front, a per-answer critique, and a readiness summary at the
 * end. Folding it into VoiceSessionPayload would have made half that payload's fields
 * meaningless in each mode, and "which fields apply right now" is exactly the kind of
 * thing that rots. The two contracts share `voice_turns` at the storage layer and
 * nothing else.
 */
import type { PipelineStatus } from '@/lib/pipeline-contract';

/**
 * THE GATE. A mock interview is offered once an employer has actually replied.
 *
 * `interviewing` is what "they responded" resolves to — the pipeline normalises the
 * machine event `callback` to it (IMPLIED_STAGE in pipeline-contract.ts), so an
 * employer reply the A2A lane detected unlocks this without the student marking
 * anything by hand. `offer` is included because an offer implies the conversation
 * happened and later rounds are still a thing people rehearse for.
 *
 * `applied` is deliberately NOT here. Rehearsing for an interview nobody has offered
 * is the kind of feature that feels supportive and is actually just anxiety with a
 * button, and it would make the stage gate meaningless.
 */
export const INTERVIEW_STAGES: readonly PipelineStatus[] = ['interviewing', 'offer'];

export function interviewUnlocked(status: PipelineStatus | null | undefined): boolean {
  return !!status && INTERVIEW_STAGES.includes(status);
}

/** Why the room is closed, in a sentence the student can read. Null means it is open. */
export function lockedReason(status: PipelineStatus | null | undefined): string | null {
  if (interviewUnlocked(status)) return null;
  if (!status) return 'This role is not on your pipeline board yet, so there is nothing to rehearse for.';
  if (status === 'rejected' || status === 'withdrawn') {
    return 'This application is closed. A mock interview would not change anything now.';
  }
  if (status === 'accepted') return 'You already accepted this one. Go and enjoy it.';
  return 'Mock interviews open once the employer replies. Mark this role Interviewing when they do.';
}

/**
 * What a question is FOR. Carried on every question so the transcript, the feedback
 * and the spoken prompt all agree, and so a student can see the interview has a
 * shape rather than being a random pile.
 *
 * `gap` is the one that earns its keep: it is generated from `skills_missing` on the
 * cached match row — the skills the JD asks for that the profile does not evidence.
 * Those are the questions a real interviewer asks and the student has not prepared.
 */
export const QUESTION_KINDS = ['warmup', 'experience', 'gap', 'behavioural', 'role', 'closing'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_KIND_LABEL: Record<QuestionKind, string> = {
  warmup: 'Warm-up',
  experience: 'Your experience',
  gap: 'Skill gap',
  behavioural: 'Behavioural',
  role: 'About the role',
  closing: 'Closing',
};

export type InterviewQuestion = {
  /** Stable within a session; the answer and the critique both reference it. */
  id: string;
  kind: QuestionKind;
  text: string;
  /**
   * Why this question is being asked, shown under it. Never generated prose — for a
   * deterministic question it names the JD skill or the resume line it came from,
   * and for a generated one it is the model's stated reason, labelled as such.
   */
  because: string;
  /** What a strong answer contains. Drives the critique and is shown after answering. */
  looksLike: string[];
};

/** Where the question set came from. Shown on screen — hard rule 8, do not overclaim. */
export const QUESTION_SOURCES = ['gemini', 'jd-deterministic'] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

export const QUESTION_SOURCE_LABEL: Record<QuestionSource, string> = {
  gemini: 'Written by Gemini from this job description and your profile',
  'jd-deterministic': 'Built from this job description and your match gaps, no model call',
};

/**
 * How the student's answer reached us. Stored per answer because it changes how much
 * the critique can fairly say: a Scribe transcript can be wrong about a word, and
 * marking a student down for a mis-transcription would be indefensible.
 */
export const ANSWER_SOURCES = ['typed', 'scribe', 'elevenlabs'] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

export type InterviewAnswer = {
  questionId: string;
  text: string;
  source: AnswerSource;
  /** Seconds of speech, when we know. Pacing is half of interview feedback. */
  spokenSeconds: number | null;
};

/* ==========================================================================
 * VITALS. Presage SmartSpectra, read from the same webcam frames the self-view
 * already has.
 *
 * WHAT THIS IS AND IS NOT. Presage's own documentation says its metrics are for
 * "general wellness and informational purposes only" and are not FDA cleared. So
 * this is a NERVES read the student sees about themselves, in their own practice
 * session, and it is never a score, never shown to an employer, and never stored
 * against the application as a judgement. Hard rule 8 applies to our own UI: the
 * panel says what the number is and what it is not.
 * ========================================================================== */

export type VitalsSample = {
  /** Beats per minute, valid 40-110 per the SDK. Null when confidence is too low. */
  pulseBpm: number | null;
  /** Breaths per minute, valid 5-40. Null before the SDK's 30-second window fills. */
  breathingBpm: number | null;
  /** 0-1 from the SDK. Below CONFIDENCE_FLOOR we show nothing rather than a guess. */
  confidence: number;
  /** Strongest facial expression and its probability, when the face is readable. */
  expression: { label: string; probability: number } | null;
  /** Talking detection — drives the "you talked over the interviewer" note. */
  talking: boolean | null;
  at: number;
};

/**
 * Below this we render "still reading" instead of a number.
 *
 * The SDK reports confidence 0 until its window fills (60s for HRV, 30s for
 * breathing), and an early reading shown at face value would be the most memorable
 * wrong number in the demo.
 */
export const CONFIDENCE_FLOOR = 0.5;

export type VitalsSummary = {
  /** Mean pulse across the samples that cleared the floor. Null if none did. */
  meanPulseBpm: number | null;
  /** Highest sustained pulse, which is the one the student actually wants. */
  peakPulseBpm: number | null;
  meanBreathingBpm: number | null;
  /** Expression labels seen above the floor, most frequent first. */
  expressions: string[];
  samples: number;
  /** Samples that cleared CONFIDENCE_FLOOR. `samples - usable` is honest noise. */
  usable: number;
};

export function emptyVitals(): VitalsSummary {
  return {
    meanPulseBpm: null,
    peakPulseBpm: null,
    meanBreathingBpm: null,
    expressions: [],
    samples: 0,
    usable: 0,
  };
}

/**
 * The one sentence the vitals panel says at the end, or null when there is nothing
 * honest to say. Deliberately about STEADINESS and never about performance.
 */
export function vitalsSentence(summary: VitalsSummary): string | null {
  if (summary.usable === 0) return null;
  const { meanPulseBpm, peakPulseBpm } = summary;
  if (meanPulseBpm === null) return null;
  const climb = peakPulseBpm !== null ? Math.round(peakPulseBpm - meanPulseBpm) : 0;
  if (climb >= 15) {
    return `Your pulse averaged ${Math.round(meanPulseBpm)} bpm and climbed about ${climb} over your steadiest stretch — worth noticing which question did that.`;
  }
  return `Your pulse held near ${Math.round(meanPulseBpm)} bpm across the call, which is steady.`;
}

/* ========================================================================== */

/** Per-answer critique. One object per question actually answered. */
export type AnswerCritique = {
  questionId: string;
  /** Plain observations, each tied to something in the answer. Never a grade. */
  notes: string[];
  /** Things a strong answer has that this one did not. Straight from looksLike. */
  missing: string[];
  /** Word count, and seconds when spoken. Pacing is feedback a model cannot fake. */
  words: number;
  spokenSeconds: number | null;
};

export type InterviewFeedback = {
  /** The one-paragraph readout. This is what the `interview_feedback` turn says. */
  summary: string;
  critiques: AnswerCritique[];
  /** Questions that were skipped. Named, because silence is the useful signal. */
  unanswered: string[];
  vitals: VitalsSummary;
  vitalsNote: string | null;
  /** Whether the summary came from a model or from the deterministic writer. */
  source: QuestionSource;
};

/** What GET /api/interview/[jobId]/session returns. */
export type InterviewSessionPayload = {
  /** Minted per room open. Becomes conversation_id on every voice_turns row. */
  sessionId: string;
  jobId: string;
  jobTitle: string;
  company: string;
  /** Null when the room is open. A sentence when it is not — the page renders it. */
  locked: string | null;
  questions: InterviewQuestion[];
  questionSource: QuestionSource;
  /** Non-fatal sentences: which upgrades are off and why. Rendered as a list. */
  degraded: string[];
  /** ElevenLabs persona 2. Null means the questions are read on screen instead. */
  signedUrl: string | null;
  /** Substituted into the interviewer prompt. Never contains a secret. */
  dynamicVariables: Record<string, string>;
  /** Whether POST .../transcribe will do anything. False means typed answers only. */
  sttReady: boolean;
  /** Whether POST .../vitals will do anything. False means the panel says so. */
  vitalsReady: boolean;
};

export type InterviewTurnRequest = {
  sessionId: string;
  questionId: string;
  text: string;
  source: AnswerSource;
  spokenSeconds?: number;
};

export type InterviewTurnResponse = {
  ok: boolean;
  critique: AnswerCritique;
  /** The next question, or null when that was the last one. */
  next: InterviewQuestion | null;
  error?: string;
};

export type InterviewFinishRequest = {
  sessionId: string;
  answers: InterviewAnswer[];
  vitals: VitalsSummary;
};

export type InterviewFinishResponse = {
  ok: boolean;
  feedback: InterviewFeedback;
  error?: string;
};

/** Type guards. The only route a client-supplied enum takes to the database. */
export function isQuestionKind(value: unknown): value is QuestionKind {
  return typeof value === 'string' && (QUESTION_KINDS as readonly string[]).includes(value);
}

export function isAnswerSource(value: unknown): value is AnswerSource {
  return typeof value === 'string' && (ANSWER_SOURCES as readonly string[]).includes(value);
}

/**
 * Words per minute, or null when the answer was typed.
 *
 * 140-160 wpm is ordinary conversational pace; under 100 in an interview usually
 * means long pauses, and over 200 means nerves. The thresholds live in
 * `pacingNote` so the number and its interpretation cannot drift apart.
 */
export function wordsPerMinute(words: number, spokenSeconds: number | null): number | null {
  if (spokenSeconds === null || spokenSeconds < 5) return null;
  return Math.round((words / spokenSeconds) * 60);
}

export function pacingNote(words: number, spokenSeconds: number | null): string | null {
  const wpm = wordsPerMinute(words, spokenSeconds);
  if (wpm === null) return null;
  if (wpm > 200) return `You spoke at about ${wpm} words a minute, which is fast enough to be hard to follow.`;
  if (wpm < 100) return `You spoke at about ${wpm} words a minute, with enough pause that an interviewer may cut in.`;
  return `You spoke at about ${wpm} words a minute, which is an easy pace to listen to.`;
}
