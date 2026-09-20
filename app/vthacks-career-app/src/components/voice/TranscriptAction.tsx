'use client';

/**
 * The ACTION line — what the conversation DID, rendered by kind.
 *
 * This is the transcript's reason to exist. "The voice agent is a medium, not a
 * brain" is only a claim until the user can read, in order, the sentence that says
 * which field changed and to what. A wrong value the user can see is recoverable; a
 * wrong value they cannot is the bug that makes the whole product untrustworthy.
 *
 * WHY A SWITCH OVER A UNION AND NOT A STRING. When the agent could only ask questions,
 * `profile_updated` was the only reachable kind and the rest were written out so that
 * reaching one later would be a new case in an exhaustive switch rather than a rewrite.
 * That paid off: making the agent an ACTOR reached four of them —`job_matched` when it
 * reloads or explains, `refused` when it will not open a job it cannot resolve,
 * `navigated` when it walks you somewhere, `job_status_set` when it moves a role's
 * stage. `interview_feedback` is still unreached, and saying so is more useful than
 * quietly deleting it.
 *
 * The `never` assignment at the bottom is what makes that true: adding a kind without
 * a case here fails the build. The kinds are data; the styling is a lookup.
 */
import {
  BadgeCheck,
  Ban,
  BriefcaseBusiness,
  ListChecks,
  MessageSquareQuote,
  Navigation,
  UserCheck,
} from 'lucide-react';

import type { TranscriptEntry, VoiceActionKind } from '@/lib/voice-contract';

type ActionEntry = Extract<TranscriptEntry, { role: 'action' }>;

const LABELS: Record<VoiceActionKind, string> = {
  profile_updated: 'PROFILE UPDATED',
  job_matched: 'MATCHES',
  refused: 'REFUSED',
  interview_feedback: 'INTERVIEW FEEDBACK',
  navigated: 'OPENED',
  job_status_set: 'STAGE CHANGED',
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
    case 'navigated':
      return <Navigation size={15} aria-hidden="true" />;
    case 'job_status_set':
      return <ListChecks size={15} aria-hidden="true" />;
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
        {/* A settled REFUSAL keeps the refusal icon. A green tick beside "I would not
            open that" reads as success, and a refusal that looks like a success is
            exactly the confusion hard rule 3 is trying to avoid. */}
        {entry.state === 'done' && entry.kind !== 'refused' ? (
          <BadgeCheck size={15} aria-hidden="true" />
        ) : (
          icon(entry.kind)
        )}
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
