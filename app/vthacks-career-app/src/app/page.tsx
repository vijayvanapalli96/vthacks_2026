import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { AgentGreeter } from '@/components/AgentGreeter';
import { FeatureMarquee } from '@/components/FeatureMarquee';
import { Reveal } from '@/components/Reveal';

const paths = [
  {
    eyebrow: 'FOR STUDENTS',
    title: 'Apply with your voice.',
    body: 'Your agent reads your resume and your coursework, finds the roles that actually fit, and writes the materials for each one. Then it checks the employer is real — and refuses out loud if they cannot prove it. Start to finish without touching a mouse.',
    cta: 'Start as an applicant',
    href: '/signup?role=applicant',
  },
  {
    eyebrow: 'FOR RECRUITERS',
    title: 'Meet people, not bots.',
    body: 'Publish a role once and let your agent answer for it. Every application arrives from an agent with a domain-anchored, certificate-backed identity, so the fake-applicant flood stops at the door and your day goes back to reading real candidates.',
    cta: 'Start as an employer',
    href: '/signup?role=employer',
  },
];

export default function Home() {
  return (
    <main id="main">
      <nav>
        <strong>HireWire</strong>
        <Link href="/signin">Sign in</Link>
        <Link href="/signup">Create account</Link>
      </nav>

      {/* Screen one: the name, a single line, nothing else. */}
      <Reveal as="section" className="opening">
        <h1>HireWire</h1>
        <p className="opening__tag">
          A voice-first job application agent. Neither side moves until both prove who they are.
        </p>
        <AgentGreeter />

        <FeatureMarquee />

        <p className="opening__scroll" aria-hidden="true">
          Scroll
        </p>
      </Reveal>

      {/* Screen two: the question, answered. */}
      <section className="why" aria-labelledby="why-h">
        <Reveal className="why__q" onScroll>
          <h2 id="why-h">Why HireWire?</h2>
        </Reveal>
        <Reveal className="why__a" onScroll>
          <p>
            Applying to forty jobs costs a sighted student twelve hours of clicking. On a screen
            reader it is closer to impossible. And a share of the postings that reach either of you
            are not real at all.
          </p>
          <p>
            Both sides of a hire should have to prove who they are before anything private changes
            hands. Here, both sides do.
          </p>
        </Reveal>
      </section>

      <section className="paths" aria-label="Choose your pathway">
        {paths.map((p) => (
          <Reveal as="article" className="path" key={p.eyebrow} onScroll>
            <p className="eyebrow">{p.eyebrow}</p>
            <div>
              <h2>{p.title}</h2>
              <p className="path__body">{p.body}</p>
              <Link className="path__cta" href={p.href}>
                {p.cta} <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </div>
          </Reveal>
        ))}
      </section>

      <Reveal as="footer" onScroll>
        <strong>Human approval is always required.</strong>
        <span>The system recommends; you control every external action.</span>
      </Reveal>
    </main>
  );
}
