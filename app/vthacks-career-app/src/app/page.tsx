import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { auth } from '@/auth';
import { AgentGreeter } from '@/components/AgentGreeter';
import { ArchitectureRail } from '@/components/ArchitectureRail';
import { CountUp } from '@/components/CountUp';
import { FeatureMarquee } from '@/components/FeatureMarquee';
import { Reveal } from '@/components/Reveal';

/** What it does besides the verification, in as few words as each will take.
 *  Each one is kept short enough to hold a single line at 19px in a half-column,
 *  because six items where two of them wrap reads as a ragged list. */
const SKILLS = [
  'Files your applications automatically',
  'Rewrites your resume for each role',
  'Drafts the cover letter',
  'Names the skills you are missing',
  'Runs mock interviews out loud',
  'Logs every handshake, both ways',
];

/**
 * The arithmetic behind the three-billion-hour claim, set so a reader can check
 * it instead of taking it.
 *
 * Two columns rather than one stacked ledger, because the symmetry IS the
 * argument: the same week is lost on both sides of the same hire. Each column
 * multiplies down to a weekly figure and the two sums sit on the same baseline,
 * so the shape of the section says what the copy says.
 *
 * Figure first, label under it. The old layout put the label on the left and the
 * number far away on the right, which made the eye travel the width of the page
 * for every row.
 *
 * A note hangs only off the two figures that are population counts, because
 * those are the two a sceptic wants a source for: BLS CPS for occupational
 * employment, BLS JOLTS for open roles. The rates are ours and the copy says so.
 * Hard rule 8, in two lines rather than a paragraph of caveats nobody finishes.
 */
type Step = { value: string; label: string; note?: string };

const SIDES: { side: string; steps: Step[]; sum: Step }[] = [
  {
    side: 'The applicant side',
    steps: [
      {
        value: '60,000,000',
        label: 'white-collar workers in the US',
        note: 'BLS counts 65 million in management and professional roles alone. We rounded down.',
      },
      { value: '× 12%', label: 'in an active search in a given week' },
      { value: '× 5 hours', label: 'each, every week' },
    ],
    sum: { value: '36,000,000', label: 'applicant hours, every week' },
  },
  {
    side: 'The employer side',
    steps: [
      {
        value: '4,300,000',
        label: 'open white-collar roles',
        note: 'Sixty per cent of the 7.2 million openings in BLS JOLTS.',
      },
      { value: '× 5 hours', label: 'of recruiter and hiring-manager time on each' },
    ],
    sum: { value: '21,500,000', label: 'employer hours, every week' },
  },
];

/** What three billion hours converts into, for a reader who does not think in hours. */
const TOLLS = [
  {
    value: '1,440,000',
    line: 'people working full time, all year, producing nothing but job-search admin. Twice the US Postal Service.',
  },
  {
    value: '$105 billion',
    line: 'of white-collar labour at $35 an hour, spent getting to the interview rather than on the work.',
  },
];

/** The release order from hard rule 3, as the reader meets it. Nothing private
 *  moves until every gate before it has passed. */
const GATE = [
  'ANS resolve',
  'Certificate check',
  'Trust Index',
  'Policy gate',
  'Human confirm',
  'Fields released',
];

/**
 * One handshake, as it actually runs. Two agents, then you.
 *
 * `from` drives which side of the page the turn sits on: yours left, theirs
 * right. The geometry carries the direction, which is why the labels are a bare
 * speaker name now and not "Your agent → their agent" on every line — the
 * alternation shows the exchange instead of describing it seven times.
 *
 * All seven turns are load-bearing (three of verification, three of negotiation,
 * one of human approval) and cutting any breaks the arc, so the block is kept
 * short by tightening the lines rather than by dropping turns.
 */
const WIRE: { from: 'you' | 'them' | 'human'; who: string; line: string }[] = [
  {
    from: 'you',
    who: 'Your agent',
    line: 'Before anything private moves: resolve your name, present a certificate.',
  },
  {
    from: 'them',
    who: 'Their agent',
    line: 'ans://v1.0.0.employer.<their-domain>. Certificate presented, chain valid.',
  },
  {
    from: 'you',
    who: 'Your agent',
    line: 'Trust Index 0.91. Five dimensions, each with a reason. Proceeding.',
  },
  {
    from: 'you',
    who: 'Your agent',
    line: 'Is the posted range real? Remote-eligible? Will you sponsor?',
  },
  {
    from: 'them',
    who: 'Their agent',
    line: 'Real and funded. Hybrid, two days. Sponsorship yes. Distributed systems is the one non-negotiable. Evidence?',
  },
  {
    from: 'you',
    who: 'Your agent',
    line: 'CS 3214 Computer Systems, two internships shipped to production. Every claim carries its source.',
  },
  {
    from: 'human',
    who: 'Your agent, to you',
    line: 'Match 0.87, gaps named. Release resume, transcript and email?',
  },
];

const paths = [
  {
    eyebrow: 'FOR STUDENTS',
    title: 'Apply with your voice.',
    body: 'Your agent reads your resume and your coursework, finds the roles that actually fit, and writes the materials for each one. Then it checks the employer is real, and refuses out loud if they cannot prove it. Start to finish without touching a mouse.',
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

export default async function Home() {
  // Reading the session makes this route server-rendered per request rather than
  // static. Deliberate: the alternative is shipping both labels and choosing on
  // the client, which flashes the wrong one.
  const session = await auth();

  return (
    <main id="main">
      {/* One control.
          Signing up is not lost: both pathway CTAs at the foot of the page go
          straight to /signup with the role already chosen, and /signin carries
          its own link across.
          Already signed in, the same slot becomes the way back in. It points at
          /continue rather than at a dashboard, because /continue is the one place
          that knows where a person belongs — it resolves the role and, for an
          applicant, whether resume/LinkedIn intake is still outstanding.
          Hard-coding /applicant here would duplicate that gate and land someone
          mid-funnel on a dashboard they have not earned yet. */}
      <nav>
        <strong>HireWire</strong>
        {session?.user ? (
          <Link href="/continue">Go to console</Link>
        ) : (
          <Link href="/signin">Sign in</Link>
        )}
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

      <ArchitectureRail />

      {/* Screen three: the question, answered. */}
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
            Almost no employer proves who they are before asking for your documents. Nobody makes
            them. <strong>We do.</strong> Nothing private moves until both agents have presented a
            certificate, and that runs in both directions.
          </p>
          <p className="eyebrow skills__label">And while it is at it</p>
          <ul className="skills">
            {SKILLS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Reveal>
      </section>

      {/* Screen four: the same waste, counted for the whole country. */}
      <section className="argue" aria-labelledby="cost-h">
        <div className="argue__head">
          <Reveal className="argue__title" onScroll>
            <p className="eyebrow">The scale</p>
            <h2 id="cost-h">A country spends three billion hours a year applying for jobs.</h2>
          </Reveal>
          <Reveal className="argue__lead" onScroll>
            <p>
              Nobody bills for this time, so nobody counts it. Count it anyway: every white-collar
              worker in the country, only the fraction searching in a given week, five hours each,
              then the same again on the recruiter&apos;s side of the desk.
            </p>
            <p>
              <strong>Three billion hours a year, and it buys nothing.</strong> No product ships,
              nobody is taught anything. It is the toll on matching people to work, paid by both
              sides, over and over.
            </p>
          </Reveal>
        </div>

        <Reveal className="count" onScroll>
          <div className="sides">
            {SIDES.map((s) => (
              <div className="side" key={s.side}>
                <p className="eyebrow">{s.side}</p>
                <dl className="side__steps">
                  {s.steps.map((st) => (
                    <div key={st.label}>
                      <dt>{st.value}</dt>
                      <dd>
                        {st.label}
                        {st.note ? <span className="side__note">{st.note}</span> : null}
                      </dd>
                    </div>
                  ))}
                </dl>
                {/* margin-top:auto in CSS, so both columns' sums land on one
                    baseline even though one side has a step the other does not. */}
                <p className="side__sum">
                  <strong>{s.sum.value}</strong>
                  <span>{s.sum.label}</span>
                </p>
              </div>
            ))}
          </div>

          <div className="tally">
            <p className="tally__n">
              <CountUp to={2_990_000_000} />
            </p>
            <p className="tally__u">hours a year, in the United States alone.</p>
          </div>

          <div className="tolls">
            {TOLLS.map((t) => (
              <article key={t.value}>
                <strong>{t.value}</strong>
                <p>{t.line}</p>
              </article>
            ))}
          </div>
        </Reveal>
      </section>

      {/* Screen five: and a large share of those hours were spent on doors that
          were never real. */}
      <section className="argue" aria-labelledby="fraud-h">
        <div className="argue__head">
          <Reveal className="argue__title" onScroll>
            <p className="eyebrow">The second problem</p>
            <h2 id="fraud-h">Some of those doors were never real.</h2>
            <p className="eyebrow gate__label">Nothing private moves until</p>
            <ol className="gate" aria-label="Order in which any private field is released">
              {GATE.map((g, i) => (
                <li className={i === GATE.length - 1 ? 'gate__last' : undefined} key={g}>
                  {g}
                </li>
              ))}
            </ol>
          </Reveal>
          <Reveal className="argue__lead" onScroll>
            <p>
              A posting costs nothing to publish and nobody has to prove it leads to a job. Some
              exist only to collect a resume, a phone number, a date of birth, an ID, from someone
              who was never going to be hired. Recruiter surveys keep landing near one posting in
              five that is not a live opening, and{' '}
              <strong>a form never asks who is on the other end of it.</strong>
            </p>
            <p>
              So here there is nothing to send a resume to. There is an employer{' '}
              <strong>agent</strong>: a name anchored to its own domain, a certificate to present,
              and a Trust Index on five dimensions, each with a reason you can read. If it cannot
              prove itself your agent refuses out loud and releases nothing. It runs both ways, so
              fabricated applicants stop at the same door.
            </p>
          </Reveal>
        </div>
      </section>

      {/* Screen six: what replaces the application. */}
      <section className="argue" aria-labelledby="machine-h">
        <div className="argue__head">
          <Reveal className="argue__title" onScroll>
            <p className="eyebrow">What we are actually building</p>
            <h2 id="machine-h">The application is the wrong primitive.</h2>
          </Reveal>
          <Reveal className="argue__lead" onScroll>
            <p>
              A hire begins with a document thrown over a wall. One PDF, one attempt, no
              conversation, and a keyword filter deciding whether a person is read at all.{' '}
              <strong>Replace the document with a negotiation between two agents.</strong>
            </p>
            <p>
              Your agent has memory: every resume, every posting you open, every answer you give out
              loud, appended with its source and never overwritten, so it sharpens the longer you use
              it. Theirs holds the role the same way. Then the two of them talk continually, not
              once, and nobody is ghosted because an agent always replies.
            </p>
          </Reveal>
        </div>

        <Reveal onScroll>
          <ol className="wire" aria-label="One verified handshake, step by step">
            {WIRE.map((w) => (
              <li className={`wire__turn wire__turn--${w.from}`} key={w.line}>
                <p className="wire__who">{w.who}</p>
                <p className="wire__line">{w.line}</p>
              </li>
            ))}
          </ol>
        </Reveal>

        <div className="duet">
          <Reveal as="article" onScroll>
            <p className="eyebrow">Your agent</p>
            <h3>Remembers, and negotiates.</h3>
            <p>
              A memory that grows with use, and a mandate to argue range, location and sponsorship
              before you spend a minute on any of it.
            </p>
          </Reveal>
          <Reveal as="article" onScroll>
            <p className="eyebrow">Their agent</p>
            <h3>Answers for the role.</h3>
            <p>
              Published once, then available to every candidate&apos;s agent at once. States the
              requirement, proves the company, screens without a human re-reading a PDF.
            </p>
          </Reveal>
          <Reveal as="article" onScroll>
            <p className="eyebrow">You</p>
            <h3>Keep the only decision.</h3>
            <p>
              A match score with its reasoning, the gaps named, the handshake logged. Nothing
              external happens until you approve it. The judgement stays yours.
            </p>
          </Reveal>
        </div>
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
