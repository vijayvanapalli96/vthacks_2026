/**
 * /employer/activity — every handshake this employer agent was part of.
 *
 * The applicant side has had this page since F7.8; the employer side had a
 * sentence in a footer claiming it ("Every handshake is logged, including the
 * ones we refused") and no page to show it. Same collection, scoped the other
 * way: documents where this agent is the subject of someone's check or the
 * verifier in its own.
 *
 * REFUSALS ARE THE POINT of this page rather than an embarrassment on it. An
 * attack probe that was blocked and an applicant agent that failed the Trust
 * Index are the evidence the gate does something.
 */
import { ShieldAlert, ShieldCheck } from 'lucide-react';

import { EmployerNav } from '@/components/EmployerNav';
import { EMPLOYER_ANS_NAME } from '@/lib/ans/production';
import { employerAudits } from '@/lib/employer';

import '../../applicant/apply/apply.css';

export const metadata = { title: 'Activity · HireWire' };
export const dynamic = 'force-dynamic';

const kindLabel: Record<string, string> = {
  verify: 'Verification',
  apply: 'Application',
  invitation: 'Recruiting invitation',
  attack: 'Attack probe',
};

export default async function EmployerActivityPage() {
  const events = await employerAudits(100);

  return (
    <main id="main">
      <EmployerNav current="activity" />

      <section className="hero trust-hero">
        <p className="eyebrow">AUDIT TRAIL</p>
        <h1>Every handshake, including the refused ones.</h1>
        <p>
          Written once to MongoDB Atlas and never changed. Each entry records which fields were released and to whom —
          the names of the fields, never their contents, so the log itself cannot leak anyone&rsquo;s data.
        </p>
        <p className="muted">Reporting on {EMPLOYER_ANS_NAME}.</p>
      </section>

      {events === null ? (
        <p className="auth-error" role="alert">
          The audit log is not reachable right now. Applications still work; this page will fill in once it is
          connected.
        </p>
      ) : events.length === 0 ? (
        <section className="panel trust-step">
          <div className="trust-body">
            <h2>Nothing recorded yet</h2>
            <p className="muted">
              The first time an applicant agent checks this employer, or this employer invites one, it lands here with
              its reason.
            </p>
          </div>
        </section>
      ) : (
        <ul className="audit-list">
          {events.map((event) => {
            const refused = event.verdict === 'refuse';
            const inbound = event.subject === EMPLOYER_ANS_NAME;
            return (
              <li key={event.audit_id} className={`panel audit-item ${refused ? 'is-refusing' : 'is-pass'}`}>
                <div className="audit-head">
                  <span className="audit-kind">
                    {refused ? <ShieldAlert size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
                    {kindLabel[event.kind] ?? event.kind}
                    <span className="muted"> · {inbound ? 'inbound' : 'outbound'}</span>
                  </span>
                  <span className={`pill ${refused ? 'pill-refuse' : 'pill-pass'}`}>
                    {event.outcome.replace(/_/g, ' ')}
                  </span>
                </div>
                <p>
                  <strong>{inbound ? event.verifier : event.subject}</strong>
                </p>
                <p className="muted">{event.spoken_reason}</p>
                <dl className="trust-receipt">
                  <dt>fields released</dt>
                  <dd>
                    <code>{JSON.stringify(event.fields_released ?? [])}</code>
                  </dd>
                  {event.job_id ? (
                    <>
                      <dt>role</dt>
                      <dd>
                        <code>{event.job_id}</code>
                      </dd>
                    </>
                  ) : null}
                  <dt>at</dt>
                  <dd>{new Date(event.at).toLocaleString()}</dd>
                  <dt>audit_id</dt>
                  <dd>
                    <code>{event.audit_id}</code>
                  </dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
