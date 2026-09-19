'use client';

import { useEffect, useState } from 'react';

import { AgentFace, type FaceMood } from './AgentFace';

/** A short loop of the states the agent really goes through on a job
 *  application, so the homepage shows the product rather than a mascot. */
const SCRIPT: { mood: FaceMood; caption: string; hold: number }[] = [
  { mood: 'idle', caption: 'Say “find me backend internships.”', hold: 3200 },
  { mood: 'listening', caption: 'Listening…', hold: 2400 },
  { mood: 'thinking', caption: 'Matching 512 roles to your skills and coursework…', hold: 3000 },
  { mood: 'speaking', caption: '“Nine fit. Shall I tailor your resume for the top three?”', hold: 3600 },
  { mood: 'happy', caption: 'Applied to Northstar Labs — employer verified.', hold: 3000 },
  { mood: 'refusing', caption: 'Stopped. That employer could not prove who it is.', hold: 3800 },
];

export function AgentGreeter() {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setTimeout(() => setI((n) => (n + 1) % SCRIPT.length), SCRIPT[i].hold);
    return () => clearTimeout(t);
  }, [i]);

  const step = SCRIPT[i];

  return (
    <div className="greeter">
      <AgentFace mood={step.mood} />
      <p className={`greeter__caption${step.mood === 'refusing' ? ' is-failure' : ''}${step.mood === 'happy' ? ' is-success' : ''}`}>
        {step.caption}
      </p>
    </div>
  );
}
