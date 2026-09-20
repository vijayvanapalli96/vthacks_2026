/**
 * /applicant/pipeline — the application pipeline board.
 *
 * NOT /applicant/activity. That page already exists and is a different thing: the
 * ANS decision audit trail, read from MongoDB via src/lib/audit.ts. This one is
 * the user's own stage tracking, read from Delta.
 *
 * Server-rendered first, so the board is present in the HTML before any
 * JavaScript runs and is readable with JS off. The interactive half is
 * PipelineBoard.tsx; everything stateful lives there.
 */
import Link from 'next/link';

import { AccountButton } from '@/components/AccountButton';
import { ApplicantNav } from '@/components/ApplicantNav';
import { hasDatabricks, sql } from '@/lib/databricks';
import { readBoard, readMatchMap } from '@/lib/pipeline';
import { emptyBoard, PIPELINE_STATUSES, type PipelineCard } from '@/lib/pipeline-contract';
import { requireRole } from '@/lib/session';

import { PipelineBoard } from './PipelineBoard';
import './pipeline.css';

export const metadata = { title: 'Pipeline · HireWire' };

/** Per-user live state read from a Delta view. Caching it would serve a stale board. */
export const dynamic = 'force-dynamic';

/** Two reads against a warehouse that cold-starts in 20-30s. */
export const maxDuration = 120;

export default async function PipelinePage() {
  const user = await requireRole('applicant');

  let cards: PipelineCard[] = [];
  let loadError: string | null = null;

  if (!hasDatabricks()) {
    loadError = 'Databricks is not configured in this environment.';
  } else {
    try {
      const matches = await readMatchMap(sql, user.id);
      const board = await readBoard(sql, user.id, matches);
      // Flattened in stage order so the server HTML lists cards in the same order
      // the board renders them — the DOM order a screen reader follows.
      cards = PIPELINE_STATUSES.flatMap((stage) => board.stages[stage]);
    } catch (error) {
      cards = emptyBoard().stages.saved;
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <main>
      <ApplicantNav current="pipeline" account={<AccountButton />} />
      <section className="hero">
        <p className="eyebrow">PIPELINE</p>
        <h1>Every role you are chasing, and how long it has been waiting.</h1>
        <p>
          Set a stage and it is <strong>appended</strong> to this job&rsquo;s history — never overwritten. That is why the
          board can tell you an application has sat for eleven days, and why changing your mind costs nothing: the
          correction is just the next event. Marking a stage works from the keyboard alone; there is no drag and drop to
          get stuck in.
        </p>
        <p className="pipe-muted">
          Roles come from <Link href="/applicant/jobs">Jobs</Link>. Your agent&rsquo;s verification decisions live in{' '}
          <Link href="/applicant/activity">Activity</Link>.
        </p>
      </section>

      <PipelineBoard cards={cards} loadError={loadError} />
    </main>
  );
}
