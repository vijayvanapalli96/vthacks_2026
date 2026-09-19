'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { VoiceOrb, type OrbState } from './VoiceOrb';

const STATES: OrbState[] = ['idle', 'listening', 'thinking', 'speaking', 'refusing'];

/**
 * Drives the orb. Owns the mic stream and the current state.
 *
 * The state buttons are a harness for building and for the demo dry-run — the
 * real agent loop will set these same states from backend events. Nothing here
 * fakes amplitude: "listening" reads the actual microphone.
 */
export function VoiceConsole() {
  const [state, setState] = useState<OrbState>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const listen = useCallback(async () => {
    setMicError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStream(s);
      setState('listening');
    } catch {
      setMicError('Microphone unavailable. Check browser permission, then try again.');
      setState('idle');
    }
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setStream(null);
    setState('idle');
  }, []);

  const pick = useCallback(
    (next: OrbState) => {
      if (next === 'listening') {
        void listen();
        return;
      }
      if (stream) stop();
      setState(next);
    },
    [listen, stop, stream],
  );

  return (
    <section className="console" aria-labelledby="console-h">
      <div>
        <small>VOICE</small>
        <h2 id="console-h">Talk to it</h2>
        <p>
          Everything you can say, you can type. The ring shows what the agent is doing and every
          state is announced aloud.
        </p>

        <div className="console__states" role="group" aria-label="Agent state">
          {STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => pick(s)}
              aria-pressed={state === s}
              className={state === s ? 'is-active' : undefined}
            >
              {s}
            </button>
          ))}
        </div>

        {stream ? (
          <button type="button" className="primary" onClick={stop}>
            Stop listening
          </button>
        ) : null}

        {micError ? (
          <p className="is-failure console__error" role="alert">
            {micError}
          </p>
        ) : null}
      </div>

      <VoiceOrb state={state} stream={state === 'listening' ? stream : null} />
    </section>
  );
}
