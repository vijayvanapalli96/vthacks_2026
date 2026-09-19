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

/** Straight from the build notes, with owners, ticket IDs and status stripped.
 *  Every claim is something the system does — a judge will ask. */
const STAGES: Stage[] = [
  {
    n: '01',
    group: 'Understand the student',
    title: 'Profile agent',
    lede: 'Reads the resume PDF and LinkedIn export, and writes facts it can defend.',
    points: [
      'Append-only facts, each with its source and a confidence',
      'Nothing is ever overwritten — current state is a view over history',
      'Lists what is still missing, in the order worth asking',
    ],
    stack: [
      ['Gemini', 'multimodal PDF understanding — the file goes in, not scraped text'],
      ['Databricks', 'append-only profile memory and the current-state view'],
    ],
  },
  {
    n: '02',
    group: 'Understand the student',
    title: 'Voice agent',
    lede: 'One agent owns the whole conversation. There is no separate router.',
    points: [
      'Speech-to-text, turn-taking and barge-in, reasoning and voice, end to end',
      'Server tools are webhooks to our own endpoints: search_jobs, match, explain_match, tailor, verify_employer, apply, status',
      'Two personas as two agents — a calm assistant, and an interviewer for practice',
      'Asks for the profile gaps in order, and confirms goals by reading them back',
      'Speaks the refusal verbatim from spoken_reason, never paraphrased',
      'Client tools drive the screen: open a job, show the trust card, open the dashboard',
    ],
    stack: [['ElevenLabs Agents', 'the entire conversation — voice and UI call the same endpoints']],
  },
  {
    n: '03',
    group: 'Find and fit the work',
    title: 'Job sourcing agent',
    lede: 'A zero-token scan of open, no-login public job boards. No scraping, no browser.',
    points: [
      'Reads Greenhouse, Lever and Ashby board APIs, with ~95 more providers available',
      "Finds a company's board from its name or domain before scanning",
      'Canonical URL key, so each posting is stored once and never rewritten',
      'Liveness check drops closed postings before they cost a match',
      'Repost detector flags the same role re-listed under a new URL',
      'Seniority classifier keeps intern and entry-level roles for students',
    ],
    stack: [
      ['Databricks', 'write-once ingestion into job_snapshots'],
      ['career-ops (MIT)', 'provider modules, URL keys, liveness and repost detection'],
    ],
  },
  {
    n: '04',
    group: 'Find and fit the work',
    title: 'Match agent',
    lede: 'Ranks with embeddings, then explains every fit it claims.',
    points: [
      'Zero-LLM skill gap per job: already on the resume, supported elsewhere on it, or missing',
      'Every requirement tagged by evidence — stated in the posting, implied by its structure, or inferred',
      'An inferred requirement can never be a hard blocker',
      'Five scores roll into one verdict: CV match, goals fit, comp, culture, red flags — 4.0 is the apply line',
      'Posting-legitimacy check flags ghost jobs: is the job real, is the employer real',
      'Coursework lever — which course unlocks the most postings',
    ],
    stack: [
      ['Databricks', 'ai_query embeddings and fit scoring in plain SQL'],
      ['career-ops (MIT)', 'skill extraction and gap classification'],
    ],
  },
  {
    n: '05',
    group: 'Find and fit the work',
    title: 'Tailor agent',
    lede: 'Builds the packet for one chosen job, and refuses to invent anything.',
    points: [
      'Tailored resume, cover letter and outreach email in one call',
      'Fact gate: every claim checked against the profile before it is shown',
      'The tailoring plan comes from the match gaps, not from generic keywords',
      'Reuses a prior tailored resume when a new posting is near-identical',
      'Print stylesheet for the downloadable copy',
    ],
    stack: [
      ['Databricks', 'one ai_query call returning the whole packet as structured JSON'],
      ['career-ops (MIT)', 'fact verification and letter generation'],
    ],
  },
  {
    n: '06',
    group: 'Prove who is on the other side',
    title: 'Applicant agent',
    lede: 'Proves who it is talking to before anything private moves.',
    points: [
      "Finds the employer's agent from the job's own domain",
      'Checks the identity certificate against that domain',
      'Trust Index across five dimensions, each carrying a reason',
      "Applies the student's policy, then waits for human approval",
      'Releases only approved fields — or refuses, and says why out loud',
    ],
    stack: [['GoDaddy ANS', 'domain-anchored agent identity, certificates and Trust Index']],
  },
  {
    n: '07',
    group: 'Prove who is on the other side',
    title: 'Employer agent',
    lede: 'Verification runs both ways. The fake-applicant flood stops at the door.',
    points: [
      'Publishes its agent card at a public, reachable endpoint',
      'Verifies the applicant agent back before accepting anything',
      'Accepts the application and returns its own match explanation',
    ],
    stack: [
      ['GoDaddy ANS', 'the second registered agent, verifying in both directions'],
      ['Vultr', 'public HTTPS host — ANS has to be able to reach it'],
    ],
  },
  {
    n: '08',
    group: 'Prove who is on the other side',
    title: 'Audit and attack console',
    lede: 'Every verdict, and exactly which fields went to whom.',
    points: [
      'Immutable log of each handshake, including the refusals',
      'Live forged, replayed and swapped attacks against a hostile agent',
      'A blocked counter that climbs while you watch',
    ],
    stack: [['MongoDB Atlas', 'immutable audit log of every verdict and field release']],
  },
  {
    n: '09',
    group: 'Know what is working',
    title: 'Funnel analytics',
    lede: 'The first honest measurement of a job search.',
    points: [
      'Every step is an event on a time-series hypertable',
      'Rolling callback rate by company, role and skill',
      'Callback rate against days-since-posting — apply late, hear back less',
    ],
    stack: [['TigerData', 'application events hypertable and continuous aggregates']],
  },
  {
    n: '10',
    group: 'Every stage, always',
    title: 'The guarantees',
    lede: 'Four rules the system holds to, not aspirations.',
    points: [
      'No personal data moves before identity, certificate, trust and policy all pass',
      'A refusal always releases zero fields',
      'Every score carries a reason, and no claim is invented',
      'Voice and UI call the same endpoints, and a human clicks apply',
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
