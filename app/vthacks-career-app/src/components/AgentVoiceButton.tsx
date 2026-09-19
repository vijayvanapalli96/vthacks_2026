'use client';

import { AgentFace, type FaceMood } from './AgentFace';

/** The caption under the face. It is the visible state *and* the announced
 *  one — the face itself is aria-hidden, so this line is the whole
 *  accessibility story for it. Same wording the greeter uses on the homepage,
 *  so HireWire reads as one character across the app.
 *  See docs/FRONTEND_UIUX_PLAN.txt §1. */
const CAPTION: Record<FaceMood, string> = {
  idle: 'Tap to talk — or say “find me backend internships.”',
  listening: 'Listening…',
  thinking: 'Working on it…',
  speaking: 'Speaking.',
  happy: 'Done.',
  refusing: 'Stopped. That employer could not prove who it is. Nothing was sent.',
};

/**
 * HireWire's face, as the way you reach the voice agent. One component on
 * every page: the expression is the agent's real state, and pressing it opens
 * or closes the mic.
 */
export function AgentVoiceButton({
  mood = 'idle',
  listening = false,
  error = null,
  size = 190,
  onToggle,
}: {
  mood?: FaceMood;
  listening?: boolean;
  error?: string | null;
  size?: number;
  onToggle: () => void;
}) {
  const tone =
    mood === 'refusing' ? ' is-failure' : mood === 'happy' || mood === 'speaking' ? ' is-success' : '';

  return (
    <div className={`agent-button agent-button--${mood}`}>
      <button
        type="button"
        className="agent-button__hit"
        onClick={onToggle}
        aria-pressed={listening}
        aria-label={listening ? 'Stop listening' : 'Talk to HireWire'}
      >
        <AgentFace mood={mood} size={size} />
      </button>

      <p className={`agent-button__caption${tone}`} role="status" aria-live="polite">
        {listening ? 'Listening… tap to stop.' : CAPTION[mood]}
      </p>

      {error ? (
        <p className="is-failure agent-button__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
