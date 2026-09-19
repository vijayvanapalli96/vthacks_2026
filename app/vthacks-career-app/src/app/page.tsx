import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

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

      <section className="split">
        <Reveal className="split__brand">
          <h1>Why HireWire?</h1>

          <div className="split__why">
            <p>
              Applying to forty jobs costs a sighted student twelve hours of clicking. On a screen
              reader it is closer to impossible. And a share of the postings that reach either of
              you are not real at all.
            </p>
            <p>
              Both sides of a hire should have to prove who they are before anything private
              changes hands. Here, both sides do.
            </p>
          </div>
        </Reveal>

        <div className="split__paths">
          {paths.map((p, i) => (
            <Reveal as="article" className="path" key={p.eyebrow} index={i + 1}>
              <p className="eyebrow">{p.eyebrow}</p>
              <h2>{p.title}</h2>
              <p className="path__body">{p.body}</p>
              <Link className="path__cta" href={p.href}>
                {p.cta} <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </Reveal>
          ))}
        </div>
      </section>

      <Reveal as="footer" onScroll>
        <strong>Human approval is always required.</strong>
        <span>The system recommends; you control every external action.</span>
      </Reveal>
    </main>
  );
}
