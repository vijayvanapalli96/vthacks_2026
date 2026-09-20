/**
 * /employer/applicants — who has actually applied through the agent.
 *
 * Every row is an audit document written when an applicant agent completed the
 * handshake with ours. Nothing on this page is composed for the demo: the
 * applicant is the ANS name that signed the envelope, the verdicts are the two
 * agents' real conclusions about each other, and the receipt id is the one our
 * agent issued.
 *
 * IT SHOWS FIELD NAMES, NOT VALUES, because that is all the log holds. A hiring
 * manager reads the candidate's details from what the candidate's agent sent
 * them, not from our record that a transfer happened. Saying "they released
 * full_name, email and skills" is the honest thing this page can say.
 */
import Link from 'next/link';
import { BadgeCheck, Inbox, ShieldAlert } from 'lucide-react';

import { EmployerNav } from '@/components/EmployerNav';
import { EMPLOYER_ANS_NAME } from '@/lib/ans/production';
import { inboundApplications, jobTitles } from '@/lib/employer';

import '../../applicant/apply/apply.css';

export const metadata = { title: 'Applicants · HireWire' };
export const dynamic = 'force-dynamic';

/** A cold warehouse for the titles, on top of the Atlas read. */
export const maxDuration = 120;

export default async function EmployerApplicantsPage() {
  const applications = await inboundApplications(50);
  const titles = applications
    ? await jobTitles(applications.map((application) => application.job_id).filter((id): id is string => Boolean(id)))
    : {};

  return (
    <main id="main">
      <EmployerNav current="applicants" />

      <section className="hero trust-hero">
        <p className="eyebrow">APPLICANTS</p>
        <h1>Everyone whose agent completed the handshake.</h1>
        <p>
          One row per application your agent accepted, read back from the audit log. Each shows which applicant
          agent signed it, what it released, and the verdict each side reached about the other.
        </p>
        <p className="muted">Reporting on {EMPLOYER_ANS_NAME}.</p>
      </section>

      {applications === null ? (
        <p className="auth-error" role="alert">
          The audit log is not reachable right now, so this page cannot say who has applied. That is a failed read,
          not an empty inbox — nothing has been lost.
        </p>
      ) : applications.length === 0 ? (
        <section className="panel trust-step">
          <div className="trust-body">
            <h2>No applications yet</h2>
            <p className="muted">
              When an applicant agent verifies this employer agent and sends a signed packet, it lands here with its
              receipt. Refusals land on the activity page rather than here.
            </p>
          </div>
        </section>
      ) : (
        <section className="panel" aria-labelledby="inbound-h">
          <header>
            <div>
              <small>INBOUND</small>
              <h2 id="inbound-h">{applications.length} applications received</h2>
            </div>
            <Inbox aria-hidden="true" />
          </header>
          <ul className="audit-list">
            {applications.map((application) => {
              const accepted = application.outcome === 'submitted';
              return (
                <li
                  key={application.audit_id}
                  className={`panel audit-item ${accepted ? 'is-pass' : 'is-refusing'}`}
                >
                  <div className="audit-head">
                    <span className="audit-kind">
                      {accepted ? (
                        <BadgeCheck size={16} aria-hidden="true" />
                      ) : (
                        <ShieldAlert size={16} aria-hidden="true" />
                      )}
                      {application.applicant}
                    </span>
                    <span className={`pill ${accepted ? 'pill-pass' : 'pill-refuse'}`}>
                      {application.outcome.replace(/_/g, ' ')}
                    </span>
                  </div>

                  <p>
                    <strong>
                      {application.job_id
                        ? (titles[application.job_id] ?? application.job_id)
                        : 'No role recorded'}
                    </strong>
                  </p>
                  <p className="muted">{application.spoken_reason}</p>

                  <dl className="trust-receipt">
                    <dt>fields released</dt>
                    <dd>
                      <code>{JSON.stringify(application.fields_released)}</code>
                    </dd>
                    <dt>their check on us</dt>
                    <dd>{application.their_verdict ?? 'not recorded'}</dd>
                    <dt>our check on them</dt>
                    <dd>
                      {application.our_verdict
                        ? `${application.our_verdict}${
                            application.our_dimensions.length
                              ? ` · ${Math.round(
                                  application.our_dimensions.reduce((sum, dimension) => sum + dimension.score, 0) /
                                    application.our_dimensions.length,
                                )} of 100 across ${application.our_dimensions.length} dimensions`
                              : ''
                          }`
                        : 'not recorded'}
                    </dd>
                    <dt>released by</dt>
                    {/* Straight from the log. After 2026-09-20 an application can
                        be released automatically once we verify, and a hiring
                        manager should be able to see which of the two it was. */}
                    <dd>
                      {application.approval_mode === 'auto'
                        ? 'their agent, automatically on passing our check'
                        : application.approval_mode === 'confirmed'
                          ? 'the candidate, field by field'
                          : 'not recorded'}
                    </dd>
                    <dt>receipt</dt>
                    <dd>
                      <code>{application.receipt_id ?? 'not recorded'}</code>
                    </dd>
                    <dt>received</dt>
                    <dd>{new Date(application.at).toLocaleString()}</dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="panel trust-step">
        <div className="trust-body">
          <h2>Nobody here you were hoping for?</h2>
          <p className="muted">
            Students who have published an opt-in profile can be found and invited directly, with the same
            verification running in the other direction.
          </p>
          <p className="job-source-link">
            <Link href="/employer/candidates">Find candidates</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
