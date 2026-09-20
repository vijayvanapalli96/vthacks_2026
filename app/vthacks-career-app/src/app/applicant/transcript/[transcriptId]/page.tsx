/**
 * /applicant/transcript/[transcriptId] — one saved agent-to-agent exchange.
 *
 * The live chain on the apply screen disappears when the student navigates away.
 * This is the same chain read back from `hirewire.a2a_transcripts`, so "show me
 * what the two agents actually said" survives the demo, the reload, and the
 * judge who asks the day after.
 *
 * Scoped to its owner by the query itself (`transcript_id` AND `user_id`), so a
 * guessed id returns a 404 rather than someone else's exchange.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { A2ATranscript } from '@/components/A2ATranscript';
import { ApplicantNav } from '@/components/ApplicantNav';
import { readTranscript } from '@/lib/a2a/transcript';
import { requireRole } from '@/lib/session';

import '../../apply/apply.css';

export const metadata = { title: 'Transcript · HireWire' };
export const dynamic = 'force-dynamic';

const outcomeLabel: Record<string, string> = {
  submitted: 'Application sent',
  refused: 'Refused — nothing was sent',
  delivery_failed: 'Delivery failed',
};

export default async function TranscriptPage({ params }: { params: Promise<{ transcriptId: string }> }) {
  const user = await requireRole('applicant');
  const { transcriptId } = await params;
  const transcript = await readTranscript(decodeURIComponent(transcriptId), user.id);
  if (!transcript) notFound();

  const elapsed = transcript.finished_at.getTime() - transcript.started_at.getTime();

  return (
    <main>
      <ApplicantNav current="activity" />
      <section className="hero trust-hero">
        <p className="eyebrow">SAVED TRANSCRIPT</p>
        <h1>{outcomeLabel[transcript.outcome] ?? transcript.outcome}</h1>
        <ul className="jd-meta">
          <li>{transcript.employer}</li>
          <li>{transcript.turns.length} messages</li>
          <li>{(elapsed / 1000).toFixed(1)}s end to end</li>
          <li>{new Date(transcript.started_at).toLocaleString()}</li>
          {transcript.audit_id ? <li>audit {transcript.audit_id.slice(0, 8)}</li> : null}
        </ul>
        <p className="muted">
          Written once and never changed, like the audit log it links to. It records field names, endpoints,
          envelope claims and verdicts — never the value of a field.
          {transcript.narrator === 'gemini'
            ? ' Your agent’s own lines were written by Gemini after the exchange finished, from this record.'
            : ' No narration was attached to this one; the record is complete without it.'}
        </p>
        <p className="job-source-link">
          <Link href="/applicant/activity">
            <ArrowLeft size={14} aria-hidden="true" /> Back to your activity
          </Link>
        </p>
      </section>

      <A2ATranscript turns={transcript.turns} narrator={transcript.narrator} />
    </main>
  );
}
