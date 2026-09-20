/**
 * /employer/candidates — the opt-in talent surface, and the invitation.
 *
 * `/api/candidates/discovery` and `/api/recruit/invite` were both finished and
 * neither had a caller anywhere in the app. This is the screen for them: the
 * students who published a profile, and a button that verifies their agent and
 * sends a signed invitation to it.
 *
 * OPT-IN IS THE WHOLE POINT and it is enforced in the query, not here — see
 * `discoveryProfiles`. What a student publishes is a headline, skills, target
 * roles and locations, under their agent's ANS name. There is no contact detail
 * on this page to leak: reaching them means going through their agent, which is
 * the product's argument in the opposite direction.
 */
import { Users } from 'lucide-react';

import { EmployerNav } from '@/components/EmployerNav';
import { InviteCandidate } from '@/components/InviteCandidate';
import { discoveryProfiles } from '@/lib/employer';
import { A2A_PLACEHOLDER_JOB, DEMO_JOB } from '@/lib/jobs';

import '../../applicant/apply/apply.css';

export const metadata = { title: 'Find candidates · HireWire' };
export const dynamic = 'force-dynamic';

/** A cold warehouse, and this page is a warehouse read. */
export const maxDuration = 120;

/**
 * The roles an invitation can name. These are the two postings this employer
 * agent actually answers for; there is no table of employer-owned openings, and
 * inventing a list of roles is exactly what this page exists to stop doing.
 */
const invitableJobs = [
  { job_id: DEMO_JOB.job_id, label: `${DEMO_JOB.job_title} · ${DEMO_JOB.location_text ?? ''}`.trim() },
  { job_id: A2A_PLACEHOLDER_JOB.job_id, label: `${A2A_PLACEHOLDER_JOB.job_title} · HireWire` },
];

export default async function EmployerCandidatesPage() {
  const candidates = await discoveryProfiles(50);

  return (
    <main id="main">
      <EmployerNav current="candidates" />

      <section className="hero trust-hero">
        <p className="eyebrow">FIND CANDIDATES</p>
        <h1>Students who published themselves.</h1>
        <p>
          Opt-in profiles only, and no contact details in any of them. To reach someone you invite their agent, which
          verifies yours before it accepts anything — the same handshake as an application, running the other way.
        </p>
      </section>

      {candidates === null ? (
        <p className="auth-error" role="alert">
          The candidate table could not be read just now. The warehouse cold-starts in 20 to 30 seconds and
          occasionally returns a transient permission error; reloading usually fixes it. This is a failed read, not
          an empty talent pool.
        </p>
      ) : candidates.length === 0 ? (
        <section className="panel trust-step">
          <div className="trust-body">
            <h2>Nobody has opted in yet</h2>
            <p className="muted">
              A student publishes a headline, their skills, the roles they want and where they will work, under their
              agent&rsquo;s ANS name. Until someone does, this list is genuinely empty rather than seeded with
              examples.
            </p>
          </div>
        </section>
      ) : (
        <section className="panel" aria-labelledby="candidates-h">
          <header>
            <div>
              <small>OPT-IN PROFILES</small>
              <h2 id="candidates-h">{candidates.length} published</h2>
            </div>
            <Users aria-hidden="true" />
          </header>
          <ul className="audit-list">
            {candidates.map((candidate) => (
              <li key={candidate.applicant_ans_name} className="panel audit-item">
                <div className="audit-head">
                  <span className="audit-kind">{candidate.applicant_ans_name}</span>
                  {candidate.updated_at ? (
                    <span className="muted">updated {candidate.updated_at.slice(0, 10)}</span>
                  ) : null}
                </div>
                {candidate.headline ? <p>{candidate.headline}</p> : null}
                <dl className="trust-receipt">
                  {candidate.skills.length ? (
                    <>
                      <dt>skills</dt>
                      <dd>{candidate.skills.join(', ')}</dd>
                    </>
                  ) : null}
                  {candidate.target_roles.length ? (
                    <>
                      <dt>looking for</dt>
                      <dd>{candidate.target_roles.join(', ')}</dd>
                    </>
                  ) : null}
                  {candidate.locations.length ? (
                    <>
                      <dt>locations</dt>
                      <dd>{candidate.locations.join(', ')}</dd>
                    </>
                  ) : null}
                </dl>
                <InviteCandidate applicantAnsName={candidate.applicant_ans_name} jobs={invitableJobs} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel trust-step">
        <div className="trust-body">
          <h2>What an invitation actually is</h2>
          <p className="muted">
            Your agent resolves the student&rsquo;s ANS name, checks the identity certificate and published card,
            scores the same five trust dimensions they score you on, and only then signs a message with this
            employer&rsquo;s key and posts it to their agent. Every one of those, including the refusals, is written
            to the audit log.
          </p>
        </div>
      </section>
    </main>
  );
}
