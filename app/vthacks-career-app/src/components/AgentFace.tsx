'use client';

import { animate, createTimer, svg, utils } from 'animejs';
import { useEffect, useRef } from 'react';

export type FaceMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'refusing';

/** Per-mood pose. Eyes are scaled/offset, brows rotate, the mouth's control
 *  point bends. Every number here is a deliberate expression, not a tween. */
const POSE: Record<
  FaceMood,
  { eyeY: number; eyeScale: number; browY: number; browTilt: number; curve: number; lean: number }
> = {
  idle: { eyeY: 0, eyeScale: 1, browY: 0, browTilt: 0, curve: 4, lean: 0 },
  listening: { eyeY: -2, eyeScale: 1.22, browY: -5, browTilt: -3, curve: 6, lean: 3 },
  thinking: { eyeY: -5, eyeScale: 0.9, browY: -2, browTilt: 11, curve: -1, lean: -4 },
  speaking: { eyeY: 0, eyeScale: 1.05, browY: -2, browTilt: 0, curve: 10, lean: 0 },
  happy: { eyeY: 1, eyeScale: 0.72, browY: -4, browTilt: -6, curve: 15, lean: 0 },
  refusing: { eyeY: 1, eyeScale: 0.6, browY: 3, browTilt: -15, curve: -7, lean: 0 },
};

const MOUTH_X1 = 62;
const MOUTH_X2 = 98;
const MOUTH_Y = 98;

const mouthPath = (curve: number) =>
  `M ${MOUTH_X1} ${MOUTH_Y} Q 80 ${MOUTH_Y + curve} ${MOUTH_X2} ${MOUTH_Y}`;

/**
 * The agent's face. Cute on purpose, but every expression corresponds to a real
 * state the agent is in — the same five the voice orb shows, plus "happy" for a
 * completed task. It is aria-hidden: the state is already announced by the
 * status region next to it, and a face read aloud twice is noise.
 */
export function AgentFace({ mood = 'idle', size = 190 }: { mood?: FaceMood; size?: number }) {
  const rootRef = useRef<SVGSVGElement>(null);
  const moodRef = useRef<FaceMood>(mood);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  // Entrance: draw the face on, the way a pen would.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const drawables = svg.createDrawable(root.querySelectorAll('.face__draw'));
    animate(drawables, {
      draw: ['0 0', '0 1'],
      ease: 'inOutSine',
      duration: 1500,
      delay: utils.stagger(140),
    });
  }, []);

  // Blink, at irregular human intervals. Skipped entirely under reduced motion.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const eyes = root.querySelectorAll('.face__eye');
    let cancelled = false;

    const timer = createTimer({
      duration: 3400,
      loop: true,
      onLoop: () => {
        if (cancelled) return;
        // Don't blink mid-refusal — the stare is the point.
        if (moodRef.current === 'refusing') return;
        animate(eyes, {
          scaleY: [1, 0.08, 1],
          duration: 190,
          ease: 'inOutQuad',
        });
      },
    });

    return () => {
      cancelled = true;
      timer.pause();
    };
  }, []);

  // Expression change.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const p = POSE[mood];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reduced ? 0 : 520;
    const ease = mood === 'happy' ? 'outElastic(1, .55)' : 'outQuad';

    animate(root.querySelectorAll('.face__eye'), {
      translateY: p.eyeY,
      scale: p.eyeScale,
      duration,
      ease,
    });

    const browL = root.querySelector('.face__brow--l');
    const browR = root.querySelector('.face__brow--r');
    if (browL) animate(browL, { translateY: p.browY, rotate: p.browTilt, duration, ease });
    if (browR) animate(browR, { translateY: p.browY, rotate: -p.browTilt, duration, ease });

    animate(root, { rotate: p.lean, duration, ease });

    // Bend the mouth by animating its control point, not by morphing paths —
    // same point count guaranteed, so it can never snap.
    const mouth = root.querySelector('.face__mouth');
    const proxy = { c: Number(mouth?.getAttribute('data-curve') ?? 4) };
    animate(proxy, {
      c: p.curve,
      duration,
      ease,
      onUpdate: () => {
        mouth?.setAttribute('d', mouthPath(proxy.c));
        mouth?.setAttribute('data-curve', String(proxy.c));
      },
    });

    // Speaking: the mouth keeps moving while it talks.
    if (mood === 'speaking' && !reduced) {
      const talk = animate(proxy, {
        c: [p.curve, p.curve * 0.25, p.curve],
        duration: 420,
        loop: true,
        ease: 'inOutSine',
        onUpdate: () => {
          mouth?.setAttribute('d', mouthPath(proxy.c));
        },
      });
      return () => {
        talk.pause();
      };
    }

    return undefined;
  }, [mood]);

  return (
    <svg
      ref={rootRef}
      className={`face face--${mood}`}
      viewBox="0 0 160 160"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="face__draw face__head" cx="80" cy="80" r="58" />

      <g className="face__brow face__brow--l">
        <path className="face__draw" d="M 50 58 Q 58 53 66 57" />
      </g>
      <g className="face__brow face__brow--r">
        <path className="face__draw" d="M 94 57 Q 102 53 110 58" />
      </g>

      <circle className="face__eye face__eye--l" cx="58" cy="76" r="5.5" />
      <circle className="face__eye face__eye--r" cx="102" cy="76" r="5.5" />

      <path className="face__draw face__mouth" data-curve="4" d={mouthPath(4)} />
    </svg>
  );
}
