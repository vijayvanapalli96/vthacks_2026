'use client';

import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { AgentFace } from './AgentFace';


type Stage = {
  n: string;
  act: string;
  title: string;
  line: string;
};

/** The story, in ten beats. Three of pain, one of arrival, six of how it works.
 *  Each card is an image; the words live underneath it. */
const STAGES: Stage[] = [
  {
    n: '01',
    act: 'The problem',
    title: 'Another hundred applications.',
    line: 'Every day. Most of them never answered.',
  },
  {
    n: '02',
    act: 'The problem',
    title: 'The same details. Every single site.',
    line: 'Name, education, experience, upload the same PDF again.',
  },
  {
    n: '03',
    act: 'The problem',
    title: 'Hours gone. Nothing back.',
    line: 'Repetitive work that leads nowhere, and no way to tell what worked.',
  },
  {
    n: '04',
    act: 'The turn',
    title: 'So we built HireWire.',
    line: 'One agent that does the applying, and refuses when something is wrong.',
  },
  {
    n: '05',
    act: 'How it works',
    title: 'Just talk to it.',
    line: 'Say what you are looking for. No forms, no mouse, no tabs.',
  },
  {
    n: '06',
    act: 'How it works',
    title: 'Your resume in, the right jobs out.',
    line: 'Add your resume and LinkedIn once. Get roles matched to you, not keywords.',
  },
  {
    n: '07',
    act: 'How it works',
    title: 'Wait — is this employer real?',
    line: 'Before anything is sent, it asks the question you never get to ask.',
  },
  {
    n: '08',
    act: 'How it works',
    title: 'Our agent asks theirs to prove it.',
    line: 'Only once the employer is verified does your resume leave your hands.',
  },
  {
    n: '09',
    act: 'How it works',
    title: 'Hiring? It runs both ways.',
    line: 'The employer agent verifies the applicant too. No bots at the door.',
  },
  {
    n: '10',
    act: 'The future',
    title: 'Agents talk. You decide.',
    line: 'The repetitive part disappears. You are brought in only when it matters.',
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
      {/* Words first in the DOM so the heading labels the image that follows it;
          flex order paints them underneath. Tab and reading order are unchanged. */}
      <div className="stage__caption">
        <p className="stage__act">
          <span>{stage.n}</span>
          {stage.act}
        </p>
        <h3>{stage.title}</h3>
        <p className="stage__line">{stage.line}</p>
      </div>

      <div className="stage__card">
        {stage.n === '04' ? (
          /* The turn. At the moment the copy says we built it, show the thing
             itself rather than a photograph of an idea. */
          <div className="stage__agent">
            <AgentFace mood="happy" size={240} />
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- the file may not
             exist yet; next/image throws on a missing local asset, a plain img
             just leaves the frame empty. */
          <img src={`/collage/story-${stage.n}.jpg`} alt="" loading="lazy" />
        )}
      </div>
    </article>
  );
}
