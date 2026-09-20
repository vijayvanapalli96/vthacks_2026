import Link from 'next/link';
import { MessagesSquare, ShieldAlert, ShieldCheck } from 'lucide-react';

import { AccountButton } from '@/components/AccountButton';
import { ApplicantNav } from '@/components/ApplicantNav';
import { recentTranscripts } from '@/lib/a2a/transcript';
import { recentAudits } from '@/lib/audit';
import { requireRole } from '@/lib/session';

import '../apply/apply.css';

export const metadata = { title: 'Activity · HireWire' };
export const dynamic = 'force-dynamic';

const kindLabel: Record<string, string> = {
  verify: 'Verification',
  apply: 'Application',
  invitation: 'Recruiting invitation',
  attack: 'Attack probe',
};

export default async function ActivityPage() {
  const user = await requireRole('applicant');
  // The audit log answers "what was decided". The transcripts answer "what was
  // said", which is a different question and a different collection.
  const [events, transcripts] = await Promise.all([
    recentAudits({ userId: user.id, limit: 50 }),
    recentTranscripts(user.id, 10),
  ]);

  return (
    <main>
      <ApplicantNav current="activity" account={<AccountButton />} />
      <section className="hero trust-hero">
        <p className="eyebrow">AUDIT TRAIL</p>
        <h1>Every decision your agent made, and what it sent.</h1>
        <p>
          Written once to MongoDB Atlas and never changed. Each entry records which fields were released and to whom —
          the names of the fields, never their contents, so the log itself cannot leak your data.
        </p>
      </section>

      {transcripts?.length ? (
        <section className="panel" aria-labelledby="transcripts-h">
          <header>
            <div>
              <small>AGENT TO AGENT</small>
              <h2 id="transcripts-h">Saved exchanges</h2>
            </div>
            <MessagesSquare aria-hidden="true" />
          </header>
          <p>
            The message-by-message record of each handshake — the registry lookup, the published card, the trust
            gate, the signed envelope, and the employer&rsquo;s verdict on your agent coming back.
          </p>
          <ul className="job-list">
            {transcripts.map((transcript) => (
              <li key={transcript.transcript_id}>
                <Link
                  className="job-row job-row-link"
                  href={`/applicant/transcript/${encodeURIComponent(transcript.transcript_id)}`}
                >
                  <span>
                    <strong>{transcript.employer}</strong>
                    <small>
                      {transcript.turns.length} messages · {new Date(transcript.finished_at).toLocaleString()}
                    </small>
                  </span>
                  <span className={`pill ${transcript.outcome === 'submitted' ? 'pill-pass' : 'pill-refuse'}`}>
                    {transcript.outcome.replace(/_/g, ' ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {events === null ? (
        <p className="auth-error" role="status">
          The audit log is not reachable right now. Your applications still work; this page will fill in once it is
          connected.
        </p>
      ) : events.length === 0 ? (
        <section className="panel trust-step">
          <div className="trust-body">
            <h2>Nothing recorded yet</h2>
            <p className="muted">
              Verify an employer or send an application, and every step lands here with its reason.
            </p>
          </div>
        </section>
      ) : (
        <ul className="audit-list">
          {events.map((event) => {
            const refused = event.verdict === 'refuse';
            return (
              <li key={event.audit_id} className={`panel audit-item ${refused ? 'is-refusing' : 'is-pass'}`}>
                <div className="audit-head">
                  <span className="audit-kind">
                    {refused ? <ShieldAlert size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
                    {kindLabel[event.kind] ?? event.kind}
                  </span>
                  <span className={`pill ${refused ? 'pill-refuse' : 'pill-pass'}`}>{event.outcome.replace(/_/g, ' ')}</span>
                  <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString()}</time>
                </div>
                <p className="audit-subject">{event.subject}</p>
                <p className="audit-reason">{event.spoken_reason}</p>
                <dl className="audit-facts">
                  <dt>fields released</dt>
                  <dd>
                    <code>{JSON.stringify(event.fields_released)}</code>
                  </dd>
                  {event.dimensions?.length ? (
                    <>
                      <dt>trust</dt>
                      <dd>{event.dimensions.map((dimension) => `${dimension.name} ${dimension.score}`).join(' · ')}</dd>
                    </>
                  ) : null}
                  {event.envelope ? (
                    <>
                      <dt>message id</dt>
                      <dd>
                        <code>{event.envelope.jti}</code>
                      </dd>
                    </>
                  ) : null}
                  <dt>audit id</dt>
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
