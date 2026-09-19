'use client';

import { useEffect } from 'react';

/**
 * Smooth scroll, but only for people who want motion. Lenis hijacks the
 * scrollbar, which can trigger motion sickness and interferes with a screen
 * reader's virtual cursor — on this product that is not a footnote, it is the
 * thesis. Under prefers-reduced-motion we never construct it at all.
 */
export function LenisProvider() {
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;

    let lenis: { raf: (t: number) => void; destroy: () => void } | null = null;
    let frame = 0;
    let cancelled = false;

    import('lenis').then(({ default: Lenis }) => {
      if (cancelled) return;
      lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 1 });
      const loop = (time: number) => {
        lenis?.raf(time);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      lenis?.destroy();
    };
  }, []);

  return null;
}
