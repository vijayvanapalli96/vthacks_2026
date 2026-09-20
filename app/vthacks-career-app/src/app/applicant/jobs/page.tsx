import Link from 'next/link';
import { BadgeCheck, ChevronRight, Radio, Target } from 'lucide-react';

import { A2ALaneCard } from '@/components/A2ALaneCard';
import { AccountButton } from '@/components/AccountButton';
import { ApplicantNav } from '@/components/ApplicantNav';
import { MatchList } from '@/components/MatchList';
import { MatchRunButton } from '@/components/MatchRunButton';
import { applicantJobVerificationMemory } from '@/lib/audit';
import { DEMO_JOB } from '@/lib/jobs';
import { readMatches } from '@/lib/match-read';
import { requireRole } from '@/lib/session';

import '../apply/apply.css';

export const metadata = { title: 'Jobs · HireWire' };
export const dynamic = 'force-dynamic';

/**
 * ONE RANKED LIST. Every row the match agent scored, each with its percentage,
 * the sentence that explains it, the verification memory for that employer, and
 * a link into that job's own screen where the check runs and apply is offered.
 *
 * The raw unscored feed used to sit underneath this. It was removed: it repeated
 * most of the same postings without a score or a reason, and the ranked rows are
 * now the thing you act on, so the second list was a second route to the same
 * screen with less information attached.
 *
 * THE DEMO EMPLOYER STAYS, separately and unscored. It is the ANS-registered
 * verified-apply path, it is not a real posting, and the match agent does not
 * rank it — so if it were folded into the list above it would either vanish or
 * have to be given a fabricated score. It is labelled as a demo on screen.
 *
 * FIRST ON THE PAGE is a placeholder internship at HireWire whose card does not
 * open a job at all: it links into /applicant/apply, the agent-to-agent screen.
 * It is there so the A2A lane can be reached in one click without first passing
 * the employer check on a detail page, and it is labelled a placeholder — it
 * wears the ranked cards' skin but carries no score, because nothing scored it.
 *
 * Reads the CACHED run — zero model calls — so navigating here does not re-run
 * the agent.
 */
export default async function JobsPage() {
  const user = await requireRole('applicant');
  const [memory, matches] = await Promise.all([
    applicantJobVerificationMemory(user.id),
    readMatches(user.id),
  ]);

  const hasRankedMatches = matches.state === 'ok' && matches.matches.length > 0;

  return (
    <main>
      <ApplicantNav current="jobs" account={<AccountButton />} />
      <section className="hero trust-hero">
        <p className="eyebrow">JOBS</p>
        <h1>Real openings, checked before you apply.</h1>
        <p>
          Select a posting and your agent checks the employer in the background. The result stays attached to
          that job in your workspace. No verified agent, no data sent.
        </p>
      </section>

      {/* FIRST ON THE PAGE, and in the same card skin as the ranked roles below.
          It is a placeholder, not a posting and not scored — see A2ALaneCard for
          what it borrows from a match card and what it refuses to borrow. It is
          first because the agent-to-agent handshake is the thing this product is
          for, and at the bottom of the page it read as a footnote to it. */}
      <section className="panel" aria-labelledby="a2a-h">
        <header>
          <div>
            <small>AGENT TO AGENT</small>
            <h2 id="a2a-h">Open the A2A lane directly</h2>
          </div>
          <Radio aria-hidden="true" />
        </header>
        <A2ALaneCard />
      </section>

      <section className="panel" aria-labelledby="match-h">
        <header>
          <div>
            <small>RANKED FOR YOU</small>
            <h2 id="match-h">Scored against your skills and coursework</h2>
          </div>
          <Target aria-hidden="true" />
        </header>

        {/* Renders nothing when there is no cached run, and an explicit alert when the
            read failed — it never presents a failure as an empty list. */}
        <MatchList
          result={matches}
          verificationMemory={memory}
          emptyNote="The last run finished and nothing cleared the bar. That is a real answer, not a failure — the numbers below say what was scanned and what the eligibility gate removed."
        />

        {matches.state === 'none' ? (
          <p className="job-empty">
            Nothing scored yet, or the last run is more than 45 minutes old. A run reads your profile,
            embeds it, and asks the model to read the top 20 postings against what you actually know —
            about 30 to 60 seconds and 21 model calls.
          </p>
        ) : null}

        {hasRankedMatches ? null : <MatchRunButton />}
      </section>

      {/* Not a list of openings any more — one labelled row, kept because the
          verified-apply path has to stay reachable whatever the match agent
          says, and the agent never ranks a demo posting. */}
      <section className="panel" aria-labelledby="demo-h">
        <header>
          <div>
            <small>VERIFIED APPLY</small>
            <h2 id="demo-h">The ANS-registered demo employer</h2>
          </div>
          <BadgeCheck aria-hidden="true" />
        </header>
        <p>
          Not a real opening and not scored against your profile. It is our own registered employer agent,
          kept here so the end-to-end verified handshake is always reachable.
        </p>
        <ul className="job-list">
          <li>
            <Link
              className="job-row job-row-link"
              href={`/applicant/jobs/${encodeURIComponent(DEMO_JOB.job_id)}`}
            >
              <span>
                <strong>{DEMO_JOB.job_title}</strong>
                <small>
                  {DEMO_JOB.company_name}
                  {DEMO_JOB.location_text ? ` · ${DEMO_JOB.location_text}` : ''}
                </small>
              </span>
              <span className="job-tag">ANS demo employer</span>
              <ChevronRight size={17} aria-hidden="true" />
            </Link>
          </li>
        </ul>
      </section>

    </main>
  );
}
