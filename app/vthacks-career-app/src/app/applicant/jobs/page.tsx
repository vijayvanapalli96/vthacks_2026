import { BriefcaseBusiness, Target } from 'lucide-react';

import { ApplicantNav } from '@/components/ApplicantNav';
import { JobVerificationList } from '@/components/JobVerificationList';
import { MatchList } from '@/components/MatchList';
import { MatchRunButton } from '@/components/MatchRunButton';
import { applicantJobVerificationMemory } from '@/lib/audit';
import { DEMO_JOB, listJobs } from '@/lib/jobs';
import { readMatches } from '@/lib/match-read';
import { requireRole } from '@/lib/session';

import '../apply/apply.css';

export const metadata = { title: 'Jobs · HireWire' };
export const dynamic = 'force-dynamic';

/**
 * Two panels, and the order is the argument.
 *
 * RANKED FIRST. These are the roles the match agent scored against this student's
 * skills and coursework, each with its percentage and the sentence that explains
 * it. It reads the CACHED run — zero model calls — so this page is fast and does
 * not re-run the agent just because somebody navigated to it.
 *
 * OPENINGS SECOND, and deliberately not merged into the first. It is the raw
 * discovery feed in posted order: no score, no ranking, no claim about fit. Mixing
 * scored and unscored rows into one list would make the unscored ones look like
 * 0% matches, which is a statement about the jobs rather than about what we have
 * read. It also carries the labelled ANS demo employer, which is the verified-apply
 * path and has to stay reachable whatever the match agent says.
 */
export default async function JobsPage() {
  const user = await requireRole('applicant');
  const [{ jobs, source }, memory, matches] = await Promise.all([
    listJobs(40),
    applicantJobVerificationMemory(user.id),
    readMatches(user.id),
  ]);

  const hasRankedMatches = matches.state === 'ok' && matches.matches.length > 0;

  return (
    <main>
      <ApplicantNav current="jobs" />
      <section className="hero trust-hero">
        <p className="eyebrow">JOBS</p>
        <h1>Real openings, checked before you apply.</h1>
        <p>
          Select a posting and your agent checks the employer in the background. The result stays attached to
          that job in your workspace. No verified agent, no data sent.
        </p>
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

      <section className="panel" aria-labelledby="jobs-h">
        <header>
          <div>
            <small>{source === 'open_us_jobs' ? 'US · POSTED IN THE LAST 3 DAYS' : 'LATEST POSTINGS'}</small>
            <h2 id="jobs-h">Openings, unscored and in posted order</h2>
          </div>
          <BriefcaseBusiness aria-hidden="true" />
        </header>
        <JobVerificationList jobs={[DEMO_JOB, ...jobs]} initialMemory={memory} />
        {jobs.length === 0 ? (
          <p className="job-empty">
            {source === 'unavailable'
              ? 'The job feed could not be reached just now. The demo posting still works.'
              : 'No real postings yet. The discovery pipeline fills this list every five minutes once it is running.'}
          </p>
        ) : null}
      </section>
    </main>
  );
}
