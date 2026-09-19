'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Entrance motion for a list of siblings. `index` staggers them.
 * Under prefers-reduced-motion everything renders instantly at rest — the
 * content is identical, only the travel is removed.
 */
export function Reveal({
  children,
  index = 0,
  className,
  as = 'div',
}: {
  children: ReactNode;
  index?: number;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'aside' | 'footer';
}) {
  const reduced = useReducedMotion();
  const Tag = motion[as];

  return (
    <Tag
      className={className}
      initial={reduced ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: reduced ? 0 : index * 0.06, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </Tag>
  );
}
