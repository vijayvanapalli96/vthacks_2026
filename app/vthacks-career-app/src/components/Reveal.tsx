'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Entrance motion.
 *
 * `index` staggers siblings on load. `onScroll` defers the reveal until the
 * element enters the viewport, which is what makes smooth scrolling worth
 * having — Lenis controls the pace, these react to it.
 *
 * Under prefers-reduced-motion the element renders at rest immediately. The
 * content is identical; only the travel is removed.
 */
export function Reveal({
  children,
  index = 0,
  className,
  as = 'div',
  onScroll = false,
}: {
  children: ReactNode;
  index?: number;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'aside' | 'footer';
  onScroll?: boolean;
}) {
  const reduced = useReducedMotion();
  const Tag = motion[as];

  const rest = { opacity: 1, y: 0 };
  const start = reduced ? false : { opacity: 0, y: onScroll ? 28 : 14 };
  const transition = {
    duration: onScroll ? 0.7 : 0.5,
    delay: reduced || onScroll ? 0 : index * 0.06,
    ease: [0.22, 1, 0.36, 1] as const,
  };

  if (onScroll) {
    return (
      <Tag
        className={className}
        initial={start}
        whileInView={rest}
        viewport={{ once: true, amount: 0.25 }}
        transition={transition}
      >
        {children}
      </Tag>
    );
  }

  return (
    <Tag className={className} initial={start} animate={rest} transition={transition}>
      {children}
    </Tag>
  );
}
