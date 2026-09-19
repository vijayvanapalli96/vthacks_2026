'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FaceMood } from '@/components/AgentFace';

/**
 * Owns the microphone and the agent's current expression.
 *
 * Split out of VoiceConsole so any page can hang a HireWire face off it —
 * the face is the contact button for voice everywhere, and the mic must not
 * be opened twice by two components that both think they own it.
 */
export function useVoiceAgent() {
  const [mood, setMood] = useState<FaceMood>('idle');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => release, [release]);

  const stop = useCallback(() => {
    release();
    setListening(false);
    setMood('idle');
  }, [release]);

  const listen = useCallback(async () => {
    setError(null);
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      setListening(true);
      setMood('listening');
    } catch {
      setError('Microphone unavailable. Check browser permission, then try again.');
      setListening(false);
      setMood('idle');
    }
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
    else void listen();
  }, [listen, listening, stop]);

  /** Put the face into a state directly — what backend events will drive.
   *  Asking for "listening" opens the mic rather than just posing. */
  const show = useCallback(
    (next: FaceMood) => {
      if (next === 'listening') {
        void listen();
        return;
      }
      if (listening) release();
      setListening(false);
      setMood(next);
    },
    [listen, listening, release],
  );

  return { mood, listening, error, toggle, show, stop };
}
