/**
 * A2ALaneCard — the placeholder HireWire internship, drawn as a match card.
 *
 * It sits at the TOP of the jobs page and wears the same `match-row` skin as the
 * ranked roles below it, because it is the same kind of thing to click: a role,
 * its one-sentence explanation, and the link that acts on it. Two visual systems
 * on one list made the A2A lane read as an afterthought at the bottom of the
 * page rather than as the thing the product is for.
 *
 * WHAT IT DELIBERATELY DOES NOT BORROW is the number. The match agent never
 * scored this posting — it is not a posting — so the score column carries a
 * label, "A2A LANE", and never a percentage, a meter or a band word. Hard rule 4
 * is about a score with no reason; inventing a score to fill a column the other
 * cards happen to have would be worse. For the same reason the rank column is
 * empty: it is not ranked among them.
 *
 * The card links straight to /applicant/apply, skipping the job detail page,
 * which is the whole point of it.
 */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { A2A_PLACEHOLDER_JOB, employerHostForJob } from '@/lib/jobs';

import './match.css';

export function A2ALaneCard() {
  const job = A2A_PLACEHOLDER_JOB;
  const href = `/applicant/apply?host=${encodeURIComponent(employerHostForJob(job))}&job=${encodeURIComponent(job.job_id)}`;

  return (
    <ol className="match-list">
      <li className="match-row">
        {/* Same trick as MatchRowView: the whole card is a mouse target, hidden
            from assistive tech because the title link below already reaches it. */}
        <Link className="match-row-open" href={href} aria-hidden="true" tabIndex={-1} />
        <div className="match-head">
          <span className="match-rank" aria-hidden="true" />
          <span className="match-who">
            <Link className="match-title-link" href={href}>
              <strong>{job.job_title}</strong>
            </Link>
            <small>
              {job.company_name}
              {job.location_text ? ` · ${job.location_text}` : ''}
            </small>
            {/* The same "not checked yet" slot the scored cards carry, and for
                the same reason: this employer IS registered in ANS, but nothing
                on this page has checked it. The check runs on the next screen,
                and claiming its result here would be the badge doing the work
                the handshake is supposed to do. */}
            <span className="job-tag muted-tag">Employer checked when you open it</span>
          </span>
          {/* Where the percentage sits on a scored card. A label, not a number:
              nothing scored this, so there is nothing to put here. */}
          <span className="match-score">
            <span className="match-score-word is-strong">A2A lane</span>
          </span>
        </div>

        <p className="match-reason">
          A placeholder internship at HireWire, not a real posting and not scored against your profile. Opening it
          goes straight to the agent-to-agent screen, where your agent verifies the employer agent and, once it
          passes, releases your details without asking again. The exchange is shown message by message as it happens.
        </p>

        <p className="match-meta">
          <span>Placeholder — not from the discovery pipeline</span>
          <span>{employerHostForJob(job)}</span>
          <Link className="match-open" href={href}>
            Open the agent-to-agent lane
            <span className="sr-only"> — {job.job_title} at {job.company_name}</span>
            <ChevronRight size={15} aria-hidden="true" />
          </Link>
        </p>
      </li>
    </ol>
  );
}
