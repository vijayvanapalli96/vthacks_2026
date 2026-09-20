import { ArrowRight, BriefcaseBusiness, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ApplicantNav } from '@/components/ApplicantNav';
import { IntakeProgress } from '@/components/IntakeProgress';
import { JobVerificationList } from '@/components/JobVerificationList';
import { MatchList } from '@/components/MatchList';
import { MatchRunButton } from '@/components/MatchRunButton';
import { Reveal } from '@/components/Reveal';
import { applicantJobVerificationMemory } from '@/lib/audit';
import { intakeGate } from '@/lib/intake';
import { DEMO_JOB, listJobs } from '@/lib/jobs';
import { readMatches } from '@/lib/match-read';
import { requireRole } from '@/lib/session';

import './intake/intake.css';
import './apply/apply.css';

/**
 * The dashboard IS the landing page, including while onboarding finishes.
 *
 * The COLLECT gate lives in this page rather than the applicant layout, because the
 * intake pages are themselves under /applicant: a layout-level redirect would fire on
 * the very pages it sends you to, and a server layout has no reliable view of the
 * current path to exempt them. Gating the dashboard gives the same behaviour with no
 * loop possible.
 *
 * The READ step has no url of its own. It used to redirect to
 * /applicant/intake/processing, which put an implementation detail in the address bar
 * of the first page a new user ever lands on. Now the analysis runs in place, here,
 * with the live log above the workspace — so the URL after signing up is just
 * /applicant and the work is still visible.
 *
 * WHAT IS NOT ON THIS PAGE. A metrics row reading 24 / 8 / 5 / 3 and an "approval
 * required" panel listing Resume.pdf and Cover-letter.pdf as Ready. Both were
 * fixture values with nothing behind them, presented as this user's own numbers and
 * this user's own files — hard rule 7, and the first thing a judge would click. The
 * match queue below stays because it now reads real postings.
 */
export default async function ApplicantDashboard() {
  const user = await requireRole('applicant');
  const { nextStep, needsAnalysis } = await intakeGate(user.id);
  if (nextStep) redirect(nextStep);
  /**
   * Three independent reads, issued together.
   *
   * `readMatches` is the CHEAP one: it reads the last cached match run, so it costs
   * zero model calls and does not run the agent. This page deliberately does NOT
   * auto-run a match — that would be a forty-second page load and 21 model calls
   * for anyone who merely opened their dashboard. The automatic run happens once,
   * in IntakeProgress, when intake finishes.
   *
   * The posting list is still fetched unconditionally, because it is the fallback
   * for an account with no run yet AND the carrier of the labelled ANS demo row.
   */
  const [{ jobs }, verificationMemory, matches] = await Promise.all([
    listJobs(3),
    applicantJobVerificationMemory(user.id),
    readMatches(user.id),
  ]);
  const queue = [DEMO_JOB, ...jobs].slice(0, 4);
  const hasRankedMatches = matches.state === 'ok' && matches.matches.length > 0;

  return (
    <main id="main">
      <ApplicantNav current="overview" />

      {needsAnalysis ? (
        <Reveal as="section" className="setup-band">
          <p className="eyebrow">SETTING UP YOUR WORKSPACE</p>
          <h1>Reading everything you gave me.</h1>
          <p className="muted">
            Reading your resume and LinkedIn together, so gaps in one get filled by the other.
            Here is what I find as I go.
          </p>
          <IntakeProgress />
        </Reveal>
      ) : (
        <Reveal as="section" className="hero hero--center">
          <p className="eyebrow">APPLICATION COMMAND CENTER</p>
          <h1>
            Find the right role.
            <br />
            Stay in control.
          </h1>
          <p>
            Evaluate opportunities, create evidence-backed materials, and approve every external
            action.
          </p>
          <Link className="primary" href="/applicant/jobs">
            Review best match <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </Reveal>
      )}

      <Reveal as="section" className="panel handshake" index={1}>
        <div>
          <small>BEFORE ANYTHING IS SENT</small>
          <h2>Your agent proves who is asking</h2>
          <p>
            Every application goes through a live check against GoDaddy&apos;s Agent Name Service. Try a verified
            employer, then an impostor.
          </p>
        </div>
        <div className="handshake-actions">
          <Link className="primary" href="/applicant/apply?host=employer.hirewire.biz">
            <ShieldCheck size={18} aria-hidden="true" /> Verified employer
          </Link>
          <Link className="secondary" href="/applicant/apply?host=fraud.webmesh.ai">
            Impostor agent
          </Link>
        </div>
      </Reveal>

      {/* Full width rather than in the old two-column .grid: the "approval required"
          aside that used to fill the narrow column is gone, and one panel sitting in
          a 1.6fr slot beside 0.85fr of nothing reads as a layout bug. */}
      <Reveal className="panel" onScroll>
        <header>
          <div>
            <small>MATCH QUEUE</small>
            <h2>{hasRankedMatches ? 'Scored against what you actually know' : 'Jobs worth your attention'}</h2>
          </div>
          <BriefcaseBusiness aria-hidden="true" />
        </header>

        {/* MatchList renders nothing for state:'none' and an honest alert for
            state:'error', so the posting list below is never asked to stand in for
            a failure it knows nothing about. */}
        <MatchList result={matches} limit={5} />

        {hasRankedMatches ? (
          <>
            <p className="job-empty">
              <Link href="/applicant/jobs">See every scored role, and the postings behind them</Link>.
            </p>
            {/* The ANS verification path stays reachable from the dashboard whatever
                the match agent said. It is our own employer agent and it says so. */}
            <JobVerificationList jobs={[DEMO_JOB]} initialMemory={verificationMemory} />
          </>
        ) : (
          <>
            <JobVerificationList jobs={queue} initialMemory={verificationMemory} />
            {queue.length <= 1 ? (
              <p className="job-empty">
                Real postings appear here as the discovery pipeline fills them in.{' '}
                <Link href="/applicant/jobs">See all jobs</Link>.
              </p>
            ) : null}
            {/* No cached run inside the 45-minute window. The postings above are a
                plain list in posted order, NOT a ranking — so the honest offer is a
                button that says what it will do, not a silent auto-run. */}
            <MatchRunButton label="Score these against my profile" />
          </>
        )}
      </Reveal>

      {/* THE VOICE DOCK IS NOT MOUNTED HERE ANY MORE.
          It moved to app/applicant/layout.tsx (voice lane, PR #29) so the
          conversation survives navigating between /applicant and /applicant/jobs —
          a page-level mount tears the WebSocket down on every route change, which
          is the one thing a live conversation cannot survive.

          Mounting it in both places is what the voice lane's
          src/components/voice/mount-claim.ts exists to arbitrate, and two docks
          briefly flashing on this page is the symptom it was written for. Removing
          this render is the other half of that fix.

          ORDERING, because it matters: this branch removes the mount, PR #29 adds
          it to the layout. If this lands FIRST, /applicant has no voice dock until
          #29 lands. Merge #29 first, or merge them together. */}
    </main>
  );
}
