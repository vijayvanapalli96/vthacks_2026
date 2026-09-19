'use client';

import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';


type Stage = {
  n: string;
  group?: string;
  title: string;
  lede: string;
  points: string[];
  stack: [string, string][];
};

/** Plain language on the card, the technology named in the stack block.
 *  A visitor should understand the benefit; a judge should find their own
 *  product without reading the repo. */
const STAGES: Stage[] = [
  {
    n: '01',
    group: 'Understand you',
    title: 'Profile agent',
    lede: 'Upload your resume. It reads it properly.',
    points: [
      'Understands the real PDF — columns, tables and all',
      'Remembers every fact, and where it came from',
      'Tells you what is still missing',
    ],
    stack: [
      ['Gemini', 'reads the PDF itself, not scraped text'],
      ['Databricks', 'stores your profile — nothing overwritten'],
    ],
  },
  {
    n: '02',
    group: 'Understand you',
    title: 'Voice agent',
    lede: 'Just talk. It handles the rest.',
    points: [
      'Interrupt it mid-sentence, like a real conversation',
      'Two voices — an assistant, and an interviewer for practice',
      'Anything you can say, you can also type',
    ],
    stack: [['ElevenLabs Agents', 'the whole conversation, voice in and voice out']],
  },
  {
    n: '03',
    group: 'Find the work',
    title: 'Job sourcing',
    lede: 'Real openings, straight from the source.',
    points: [
      'Reads Greenhouse, Lever and Ashby directly — no scraping',
      'Drops closed roles before they waste your time',
      'Keeps the intern and entry-level jobs students want',
    ],
    stack: [
      ['Databricks', 'every posting stored once, never rewritten'],
      ['career-ops (MIT)', '99 job-board readers'],
    ],
  },
  {
    n: '04',
    group: 'Find the work',
    title: 'Match agent',
    lede: 'Ranked against your skills and your coursework.',
    points: [
      'Tells you why a job fits, not just a score',
      'Shows exactly which skills you are missing',
      'Flags postings that are not real',
    ],
    stack: [['Databricks', 'embeddings and fit scoring in SQL']],
  },
  {
    n: '05',
    group: 'Find the work',
    title: 'Tailor agent',
    lede: 'A resume, cover letter and email for each job.',
    points: [
      'Written for that one posting, not from a template',
      'Every claim checked against your real profile',
      'Nothing invented, ever',
    ],
    stack: [['Databricks', 'the whole packet in a single call']],
  },
  {
    n: '06',
    group: 'Prove who is real',
    title: 'Applicant agent',
    lede: 'Checks the employer is real before sending anything.',
    points: [
      'Confirms the company owns the domain it claims',
      'Scores them on five things, each with a reason',
      'You approve before a single detail leaves',
    ],
    stack: [['GoDaddy ANS', 'verified, domain-anchored agent identity']],
  },
  {
    n: '07',
    group: 'Prove who is real',
    title: 'Employer agent',
    lede: 'Employers meet people, not bots.',
    points: [
      'The checks run in both directions',
      'Fake applicants stop at the door',
    ],
    stack: [
      ['GoDaddy ANS', 'identity verified both ways'],
      ['Vultr', 'hosts the employer agent'],
    ],
  },
  {
    n: '08',
    group: 'Prove who is real',
    title: 'Audit console',
    lede: 'A record of everything, including what we refused.',
    points: [
      'Every decision logged, permanently',
      'Exactly which details went where',
      'Watch live attacks get blocked',
    ],
    stack: [['MongoDB Atlas', 'the permanent audit log']],
  },
  {
    n: '09',
    group: 'See what works',
    title: 'Funnel analytics',
    lede: 'The first honest look at your job search.',
    points: [
      'Where every application stands, live',
      'Which roles reply, and which never do',
      'Apply sooner, hear back more',
    ],
    stack: [['TigerData', 'real-time application tracking']],
  },
  {
    n: '10',
    group: 'Always',
    title: 'The guarantees',
    lede: 'Four rules we do not break.',
    points: [
      'Nothing sends until the employer is verified',
      'A refusal sends zero information',
      'Every score comes with a reason',
      'You click apply — not us',
    ],
    stack: [],
  },
];

export function ArchitectureRail() {
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  // Cards are a fixed width, so the travel has to be measured rather than
  // derived from a fraction. Re-measured on resize so it stays flush.
  const [travel, setTravel] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setTravel(Math.max(0, track.scrollWidth - track.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  }, []);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end'],
  });

  const x = useTransform(scrollYProgress, [0, 1], [0, -travel]);

  if (reduced) {
    return (
      <section className="rail rail--static" aria-labelledby="rail-h">
        <h2 id="rail-h" className="rail__title">
          How it works
          <span>student speaks or types → agents act → verified apply, or an out-loud refusal</span>
        </h2>
        <div className="rail__stack">
          {STAGES.map((s) => (
            <Card key={s.n} stage={s} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      ref={sectionRef}
      className="rail"
      style={{ height: `${STAGES.length * 100}vh` }}
      aria-labelledby="rail-h"
    >
      <div className="rail__pin">
        <h2 id="rail-h" className="rail__title">
          How it works
          <span>student speaks or types → agents act → verified apply, or an out-loud refusal</span>
        </h2>
        <motion.div className="rail__track" ref={trackRef} style={{ x }}>
          {STAGES.map((s) => (
            <Card key={s.n} stage={s} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function Card({ stage }: { stage: Stage }) {
  return (
    <article className="stage">
      {/* The caption is FIRST in the DOM so the heading labels the card that
          follows it, and is moved below visually with flex order. Screen
          readers and tab order follow the DOM; only the paint order changes. */}
      <div className="stage__caption">
        <h3>{stage.title}</h3>
        <p>{stage.stack.length ? stage.stack.map(([who]) => who).join(' · ') : stage.group}</p>
      </div>

      <div className="stage__card">
        <p className="stage__n">
          {stage.n}
          {stage.group ? <span>{stage.group}</span> : null}
        </p>
        <p className="stage__lede">{stage.lede}</p>
        <ul className="stage__points">
          {stage.points.map((pt) => (
            <li key={pt}>{pt}</li>
          ))}
        </ul>
        {stage.stack.length ? (
        <dl className="stage__stack">
          {stage.stack.map(([who, what]) => (
            <div key={who}>
              <dt>{who}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        ) : null}
      </div>
    </article>
  );
}
