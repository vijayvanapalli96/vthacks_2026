'use client';

/**
 * The ACTION line — what the conversation DID, rendered by kind.
 *
 * This is the transcript's reason to exist. "The voice agent is a medium, not a
 * brain" is only a claim until the user can read, in order, the sentence that says
 * which field changed and to what. A wrong value the user can see is recoverable; a
 * wrong value they cannot is the bug that makes the whole product untrustworthy.
 *
 * WHY A SWITCH OVER A UNION AND NOT A STRING. Only `profile_updated` is reachable
 * today — that is the honest state of the product. The other three are written out
 * so that adding one later is a new case in an exhaustive switch (TypeScript stops
 * the build if a kind is unhandled, via the `never` assignment at the bottom), rather
 * than a rewrite of how actions render. The `kinds` are data; the styling is a lookup.
 */
import { BadgeCheck, Ban, BriefcaseBusiness, MessageSquareQuote, UserCheck } from 'lucide-react';

import type { TranscriptEntry, VoiceActionKind } from '@/lib/voice-contract';

type ActionEntry = Extract<TranscriptEntry, { role: 'action' }>;

const LABELS: Record<VoiceActionKind, string> = {
  profile_updated: 'PROFILE UPDATED',
  job_matched: 'JOB MATCHED',
  refused: 'REFUSED',
  interview_feedback: 'INTERVIEW FEEDBACK',
};

function icon(kind: VoiceActionKind) {
  switch (kind) {
    case 'profile_updated':
      return <UserCheck size={15} aria-hidden="true" />;
    case 'job_matched':
      return <BriefcaseBusiness size={15} aria-hidden="true" />;
    case 'refused':
      return <Ban size={15} aria-hidden="true" />;
    case 'interview_feedback':
      return <MessageSquareQuote size={15} aria-hidden="true" />;
    default: {
      // Adding a VoiceActionKind without a case here fails typecheck, which is the
      // point of the union.
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

export function TranscriptAction({ entry }: { entry: ActionEntry }) {
  return (
    <li className={`vt-entry vt-action vt-action-${entry.kind} is-${entry.state}`}>
      <span className="vt-action-tag">
        {entry.state === 'done' ? <BadgeCheck size={15} aria-hidden="true" /> : icon(entry.kind)}
        {/* The label is real text, not a colour or an icon: the state has to survive
            a screen reader and a monochrome display. */}
        {LABELS[entry.kind]}
        {entry.state === 'pending' ? ' · SAVING' : null}
        {entry.state === 'failed' ? ' · FAILED' : null}
      </span>
      <span className="vt-action-text">{entry.text}</span>
    </li>
  );
}
