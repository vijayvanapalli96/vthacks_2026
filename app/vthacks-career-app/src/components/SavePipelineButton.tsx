'use client';

/**
 * Save this posting into the application pipeline.
 *
 * Writes through POST /api/pipeline/status, the ONE write path (hard rule 5 —
 * everything voice can do, typing can do, at the API layer). There is no second
 * query in here and no direct table access.
 *
 * APPEND, NOT TOGGLE. The pipeline is an append-only event log, so this is not a
 * bookmark that can be un-clicked: saving twice records two facts and that is
 * correct. The button therefore never offers "unsave" — moving a job out of the
 * funnel is a status change (withdrawn), not a deletion, and that belongs on the
 * board where the other stages live.
 *
 * `initialStatus` is what the server already read from application_events, so
 * the control renders the truth on first paint rather than flashing "Save" at
 * someone who saved this yesterday.
 */

import { useState } from 'react';
import { BookmarkCheck, BookmarkPlus, Loader2 } from 'lucide-react';

import { STATUS_LABEL, type PipelineStatus } from '@/lib/pipeline-contract';

type Result = {
  ok?: boolean;
  status?: PipelineStatus;
  previous_status?: string | null;
  at?: string;
  error?: string;
};

export function SavePipelineButton({
  jobId,
  initialStatus,
}: {
  jobId: string;
  /** The latest stage already recorded for this job, or null if it is not on the board. */
  initialStatus: PipelineStatus | null;
}) {
  const [status, setStatus] = useState<PipelineStatus | null>(initialStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/pipeline/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // source: 'ui' because this is the typed path. The voice lane sends
        // 'voice' to the same endpoint with the same body.
        body: JSON.stringify({ job_id: jobId, status: 'saved', source: 'ui' }),
      });
      const body = (await response.json()) as Result;
      if (!response.ok || body.error) {
        throw new Error(body.error ?? `The pipeline returned HTTP ${response.status}.`);
      }
      setStatus('saved');
      setJustSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this job.');
    } finally {
      setSaving(false);
    }
  }

  // Already further down the funnel: saving again would be a backwards step in
  // the story even though the log would accept it. Say where it is instead.
  const beyondSaved = status !== null && status !== 'saved';

  return (
    <div className="pipeline-save">
      <button type="button" className="primary" onClick={save} disabled={saving || beyondSaved}>
        {saving ? (
          <Loader2 className="spin" size={16} aria-hidden="true" />
        ) : status ? (
          <BookmarkCheck size={16} aria-hidden="true" />
        ) : (
          <BookmarkPlus size={16} aria-hidden="true" />
        )}
        {saving
          ? 'Saving…'
          : beyondSaved
            ? `Already ${STATUS_LABEL[status].toLowerCase()} in your pipeline`
            : status
              ? 'Saved to your pipeline'
              : 'Save to my pipeline'}
      </button>

      <p aria-live="polite">
        {error ? (
          <span role="alert">{error}</span>
        ) : justSaved ? (
          'Recorded. It is on your pipeline board under Saved.'
        ) : beyondSaved ? (
          'Change the stage from the pipeline board — this posting is already past Saved.'
        ) : status === 'saved' ? (
          'This posting is on your pipeline board under Saved.'
        ) : (
          'Stores this posting against your account so it appears on your pipeline board. Nothing is sent to the employer.'
        )}
      </p>
    </div>
  );
}
