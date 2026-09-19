/**
 * voice-contract.ts — the wire types shared by the voice routes and the browser.
 *
 * DELIBERATELY FREE OF NODE IMPORTS. `src/lib/voice.ts` pulls in the Databricks
 * client, which cannot be bundled into a client component; putting the shapes here
 * means the transcript UI and the route handler agree on one definition instead of
 * two that drift.
 *
 * Nothing in this file may import anything that touches a credential.
 */

/**
 * Every kind of thing the agent can report having DONE.
 *
 * Only `profile_updated` is reachable today — that is the honest state of the
 * product and the transcript should not imply otherwise. The list is a union
 * rather than a string so `job_matched`, `refused` and `interview_feedback`
 * become new cases in the renderer's switch (which TypeScript will then demand
 * you handle) instead of a rewrite.
 */
export const VOICE_ACTION_KINDS = [
  'profile_updated',
  'job_matched',
  'refused',
  'interview_feedback',
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
      at: number;
    };
