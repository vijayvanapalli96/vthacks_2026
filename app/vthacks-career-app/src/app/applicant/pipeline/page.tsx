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
      <ApplicantNav current="pipeline" />
      {/* Trimmed: the how-it-works paragraph was three lines of explanation
          above a board that demonstrates the same thing by existing. The
          append-only promise still appears where it is actually relevant --
          under the stage control on each card. */}
      <section className="hero hero-compact">
        <p className="eyebrow">PIPELINE</p>
        <h1>Roles you are chasing</h1>
        <p className="pipe-muted">
          From <Link href="/applicant/jobs">Jobs</Link>. Verification decisions live in{' '}
          <Link href="/applicant/activity">Activity</Link>.
        </p>
      </section>

      <PipelineBoard cards={cards} loadError={loadError} />
    </main>
  );
}
