'use client';

import { useVoiceAgent } from '@/hooks/useVoiceAgent';

import type { FaceMood } from './AgentFace';
import { AgentVoiceButton } from './AgentVoiceButton';

const STATES: FaceMood[] = ['idle', 'listening', 'thinking', 'speaking', 'happy', 'refusing'];

/**
 * The voice panel. HireWire's face is the contact button — press it to open
 * the mic, press it again to close it.
 *
 * The state buttons are a harness for building and for the demo dry-run; the
 * real agent loop will set these same states from backend events.
 */
export function VoiceConsole() {
  const { mood, listening, error, toggle, show } = useVoiceAgent();

  return (
    <section className="console" aria-labelledby="console-h">
      <div>
        <small>VOICE</small>
        <h2 id="console-h">Talk to it</h2>
        <p>
          Tap HireWire to start talking. Everything you can say, you can type — and its face shows
          what the agent is doing, announced aloud too.
        </p>

        <div className="console__states" role="group" aria-label="Agent state">
          {STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => show(s)}
              aria-pressed={mood === s}
              className={mood === s ? 'is-active' : undefined}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <AgentVoiceButton mood={mood} listening={listening} error={error} onToggle={toggle} />
    </section>
  );
}
