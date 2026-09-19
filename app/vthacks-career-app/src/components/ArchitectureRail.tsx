'use client';

import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { StageArt } from './StageArt';

type Stage = {
  n: string;
  title: string;
  lede: string;
  points: string[];
  stack: [string, string][];
};

/** Every claim here is something the system actually does. Nothing aspirational
 *  goes on this rail — a judge will ask, and a caught exaggeration costs more
 *  than a gap. */
const STAGES: Stage[] = [
  {
    n: '01',
    title: 'Profile agent',
    lede: 'Reads the resume PDF and LinkedIn export, and writes facts it can defend.',
    points: [
      'Append-only memory — every fact carries its source and a confidence',
      'Nothing is ever overwritten; current state is a view over history',
      'Reports what is still missing, in the order worth asking',
    ],
    stack: [
      ['Gemini', 'multimodal PDF understanding — the file goes in, not scraped text'],
      ['Databricks', 'profile_memory + profile_current view'],
    ],
  },
  {
    n: '02',
    title: 'Voice agent',
    lede: 'One agent owns the whole conversation. There is no separate router.',
    points: [
      'Speech-to-text, turn-taking, barge-in, reasoning and voice in one loop',
      'Server tools are webhooks to our own endpoints — voice and UI call the same API',
      'Two personas: a calm assistant, and an interviewer for practice',
      'Speaks a refusal verbatim from spoken_reason, never paraphrased',
    ],
    stack: [['ElevenLabs Agents', 'end-to-end conversation, server tools, two voices']],
  },
  {
    n: '03',
    title: 'Job sourcing agent',
    lede: 'A zero-token scan of public job boards. No scraping, no browser.',
    points: [
      'Reads Greenhouse, Lever and Ashby board APIs directly',
      "Finds a company's board from its name or domain before scanning",
      'Canonical URL key — a posting is stored once and never rewritten',
      'Liveness check drops closed roles; a repost detector catches re-listings',
      'Seniority classifier keeps intern and entry-level roles for students',
    ],
    stack: [
      ['Databricks', 'job_snapshots, MERGE INTO write-once ingestion'],
      ['career-ops (MIT)', '99 provider modules, url-key, liveness, repost detection'],
    ],
  },
  {
    n: '04',
    title: 'Match agent',
    lede: 'Ranks by embedding, then explains every fit it claims.',
    points: [
      'Zero-LLM skill gap per job: on the resume, supported elsewhere, or missing',
      'Requirements tagged by evidence — stated, implied, or inferred',
      'An inferred requirement can never be a hard blocker',
      'Five scores roll into one verdict; 4.0 is the apply line',
      'Posting-legitimacy check pairs with ANS: is the job real, is the employer real',
      'Coursework lever — which course unlocks the most postings',
    ],
    stack: [
      ['Databricks', 'ai_query embeddings (gte-large-en, 1024-dim), cosine match in SQL'],
    ],
  },
  {
    n: '05',
    title: 'Tailor agent',
    lede: 'Builds the packet for one chosen job, and refuses to invent anything.',
    points: [
      'Resume, cover letter and outreach email in a single call',
      'Fact gate: every claim checked against the profile before it is shown',
      'The tailoring plan comes from the match gaps, not generic keywords',
      'Reuses a prior tailored resume when a new posting is near-identical',
    ],
    stack: [['Databricks', 'one ai_query call returning structured JSON']],
  },
  {
    n: '06',
    title: 'Applicant agent',
    lede: 'Proves who it is talking to before anything private moves.',
    points: [
      "Resolves the employer's agent from the job's own domain",
      'Checks the identity certificate against that domain',
      'Trust Index across five dimensions, each carrying a reason',
      'Applies the student policy, then waits for a human to approve',
      'Releases only approved fields — or refuses and says why out loud',
    ],
    stack: [['GoDaddy ANS', 'domain-anchored agent identity, certificates, Trust Index']],
  },
  {
    n: '07',
    title: 'Employer agent',
    lede: 'Verification runs both ways. The flood stops at the door.',
    points: [
      'Publishes its agent card at a public, reachable endpoint',
      'Verifies the applicant agent back before accepting anything',
      'Returns its own explanation of the match',
    ],
    stack: [
      ['GoDaddy ANS', 'the second registered agent, bidirectional verification'],
      ['Vultr', 'public HTTPS host — ANS has to be able to reach it'],
    ],
  },
  {
    n: '08',
    title: 'Audit and attack console',
    lede: 'Every verdict, and exactly which fields went to whom.',
    points: [
      'Immutable log of each handshake, including the refusals',
      'Live forged, replayed and swapped attacks against a hostile agent',
      'A blocked counter that climbs while you watch',
    ],
    stack: [['MongoDB Atlas', 'immutable a2a_audit log of every verdict and field release']],
  },
  {
    n: '09',
    title: 'Funnel analytics',
    lede: 'The first honest measurement of a job search.',
    points: [
      'Every step is an event on a time-series hypertable',
      'Rolling callback rate by company, role and skill',
      'Callback rate against days-since-posting — apply late, hear back less',
    ],
    stack: [['TigerData', 'application_events hypertable, continuous aggregates']],
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
        <p>{stage.stack.map(([who]) => who).join(' · ')}</p>
      </div>

      <div className="stage__card">
        <p className="stage__n">{stage.n}</p>
        <StageArt id={stage.n} />
        <p className="stage__lede">{stage.lede}</p>
        <dl className="stage__stack">
          {stage.stack.map(([who, what]) => (
            <div key={who}>
              <dt>{who}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}
