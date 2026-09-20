'use client';

import { animate, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';

/**
 * A figure that counts up to itself when it first scrolls into view.
 *
 * Four things worth knowing about the shape of this:
 *
 * 1. THE FINAL VALUE IS WHAT RENDERS ON THE SERVER. Nothing here starts at zero
 *    in the HTML, so the number is correct with JavaScript off, correct for a
 *    crawler, and correct in the moment before hydration. The reset to zero
 *    happens on mount, which for a figure this far down the page is long before
 *    anyone can see it.
 * 2. IT WRITES TO THE DOM, NOT TO STATE. `setState` on every frame would put
 *    ~130 React renders through a page that is also running a pinned scroll
 *    rail. `textContent` on a ref costs nothing.
 * 3. IT RUNS ONCE. `once: true` — a number that re-counts every time it scrolls
 *    past stops reading as a fact and starts reading as a widget.
 * 4. A SCREEN READER NEVER HEARS THE COUNT. The animated span is aria-hidden and
 *    a static sibling carries the value, so the figure is announced once, in
 *    full, instead of as a stream of changing digits.
 */
export function CountUp({
  to,
  duration = 2.1,
  className,
}: {
  to: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduced = useReducedMotion();
  const final = to.toLocaleString('en-US');

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;

    // Park it at zero the moment we know we can animate, so the count starts
    // from the bottom rather than jumping down to it when the section arrives.
    if (!inView) {
      el.textContent = '0';
      return;
    }

    const controls = animate(0, to, {
      duration,
      // Expo-out: most of the travel happens early and it decelerates into the
      // figure, which is what makes the last digits legible instead of a blur.
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = Math.round(v).toLocaleString('en-US');
      },
    });

    return () => controls.stop();
  }, [inView, reduced, to, duration]);

  return (
    <span className={className}>
      <span className="sr-only">{final}</span>
      <span ref={ref} aria-hidden="true">
        {final}
      </span>
    </span>
  );
}
