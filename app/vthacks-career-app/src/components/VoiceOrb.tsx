'use client';

import { useEffect, useRef } from 'react';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'refusing';

const TICKS = 64;
const R = 74;
const SIZE = 260;
const C = SIZE / 2;

/** What the screen reader says when the state changes. Same information the
 *  sighted user gets from the ring — this is the accessibility claim, not a
 *  nicety. See docs/FRONTEND_UIUX_PLAN.txt §1. */
const SPOKEN: Record<OrbState, string> = {
  idle: 'Idle. Say "hey" or press slash to type.',
  listening: 'Listening.',
  thinking: 'Working on it.',
  speaking: 'Speaking.',
  refusing: 'Stopped. That employer could not prove who it is. Nothing was sent.',
};

/**
 * The signature object. One ring, 64 radial ticks, driven by real audio
 * amplitude — mic while listening, the agent's own output while speaking.
 *
 * Never decorative: every visual state corresponds to something the agent is
 * actually doing, and every state is announced.
 */
export function VoiceOrb({
  state = 'idle',
  stream = null,
  size = SIZE,
}: {
  state?: OrbState;
  stream?: MediaStream | null;
  size?: number;
}) {
  const ticksRef = useRef<(SVGLineElement | null)[]>([]);
  const ringRef = useRef<SVGCircleElement>(null);
  const stateRef = useRef<OrbState>(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Audio analyser — only while a stream is attached.
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    if (!stream) {
      analyserRef.current = null;
      return;
    }
    const Ctx: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    analyserRef.current = analyser;
    dataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

    return () => {
      source.disconnect();
      analyser.disconnect();
      void ctx.close();
      analyserRef.current = null;
    };
  }, [stream]);

  // One rAF loop for the lifetime of the component. Writes straight to the DOM
  // via refs — re-rendering React 64 times a frame would drop frames.
  useEffect(() => {
    let frame = 0;
    const start = performance.now();

    // Read once and keep it current, rather than querying matchMedia per frame.
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reduced = e.matches;
    };
    mq.addEventListener('change', onChange);

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const t = (now - start) / 1000;
      const s = stateRef.current;

      const analyser = analyserRef.current;
      const data = dataRef.current;
      const live = (s === 'listening' || s === 'speaking') && analyser && data;
      if (live) analyser.getByteFrequencyData(data);

      // Ring breathes slowly at rest, jolts inward on refusal.
      let ringR = R;
      if (!reduced) {
        if (s === 'idle') ringR = R + Math.sin(t * 1.1) * 2.4;
        else if (s === 'thinking') ringR = R + Math.sin(t * 2.6) * 1.4;
        else if (s === 'refusing') ringR = R - 5;
      }
      ringRef.current?.setAttribute('r', String(ringR));

      for (let i = 0; i < TICKS; i++) {
        const el = ticksRef.current[i];
        if (!el) continue;
        const angle = (i / TICKS) * Math.PI * 2 - Math.PI / 2;

        let len: number;
        if (reduced) {
          len = s === 'refusing' ? 3 : 8;
        } else if (live) {
          // Mirror the spectrum so the shape is symmetric rather than lopsided.
          const half = Math.floor(TICKS / 2);
          const bin = i < half ? i : TICKS - 1 - i;
          const v = data[Math.floor((bin / half) * (data.length * 0.6))] / 255;
          len = 5 + v * 42;
        } else if (s === 'thinking') {
          len = 6 + Math.max(0, Math.sin(t * 2.2 - i * 0.22)) * 16;
        } else if (s === 'refusing') {
          len = 3;
        } else {
          len = 7 + Math.sin(t * 1.1 + i * 0.35) * 2.2;
        }

        const inner = ringR + 6;
        const outer = inner + len;
        el.setAttribute('x1', String(C + Math.cos(angle) * inner));
        el.setAttribute('y1', String(C + Math.sin(angle) * inner));
        el.setAttribute('x2', String(C + Math.cos(angle) * outer));
        el.setAttribute('y2', String(C + Math.sin(angle) * outer));
      }
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      mq.removeEventListener('change', onChange);
    };
  }, []);

  return (
    <div className={`orb orb--${state}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={size} height={size} aria-hidden="true" focusable="false">
        <circle ref={ringRef} cx={C} cy={C} r={R} className="orb__ring" />
        <circle cx={C} cy={C} r={R - 13} className="orb__inner" />
        <g className="orb__ticks">
          {Array.from({ length: TICKS }, (_, i) => (
            <line
              key={i}
              ref={(el) => {
                ticksRef.current[i] = el;
              }}
              x1={C}
              y1={C}
              x2={C}
              y2={C}
            />
          ))}
        </g>
      </svg>

      <span className="orb__label">{state}</span>

      {/* The same state, for people who cannot see the ring. */}
      <p className="sr-only" role="status" aria-live="polite">
        {SPOKEN[state]}
      </p>
    </div>
  );
}
