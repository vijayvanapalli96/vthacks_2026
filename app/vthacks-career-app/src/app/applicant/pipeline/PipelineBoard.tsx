'use client';

/**
 * PipelineBoard — the board. Seven columns, one card per tracked job.
 *
 * ACCESSIBILITY DECIDED THE INTERACTION MODEL, not the other way round
 * (CLAUDE.md hard rule 6, which is the thesis of this product):
 *
 *  * The status control is a NATIVE <select> with a real <label>. Not a listbox
 *    role, not a custom popover, not a drag handle. A native select is keyboard
 *    reachable, arrow-navigable, screen-reader announced and touch-friendly for
 *    free, and gets the platform's own picker on mobile.
 *  * THERE IS NO DRAG AND DROP. It was optional and it was skipped. A
 *    keyboard-only board is a complete feature; a mouse-only board would violate
 *    rule 6. Nothing here is reachable by pointer alone.
 *  * Every change is announced through an aria-live="polite" region, naming the
 *    job and both stages: "Stripe, Software Engineer Intern: moved from Saved to
 *    Applied." A silent optimistic move is invisible to a screen-reader user.
 *  * FOCUS IS RESTORED after a move. Changing a stage moves the card to another
 *    column, which unmounts its <select> — so focus would land on <body> and a
 *    keyboard user would lose their place. The `focusJobId` effect below puts it
 *    back on the same control in its new column. This is the single least
 *    obvious thing in this file and the reason it is a client component at all.
 *  * The control is never disabled while saving. Disabling a focused element
 *    throws focus to the document; `aria-busy` says the same thing without
 *    stealing it.
 *  * Stage is never conveyed by colour alone: every badge carries its label and
 *    a STATUS_MARK numeral.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { interviewUnlocked } from '@/lib/interview-contract';
import {
  FUNNEL_STAGES,
  PIPELINE_STATUSES,
  STATUS_HINT,
  STATUS_LABEL,
  STATUS_MARK,
  daysPhrase,
  stalledSentence,
  type PipelineCard,
  type PipelineStatus,
} from '@/lib/pipeline-contract';

type Props = {
  cards: PipelineCard[];
  /** Surfaced rather than swallowed: a board that silently shows nothing is a lie. */
  loadError?: string | null;
};

function cardName(card: PipelineCard): string {
  const title = card.title ?? 'Untitled role';
  return card.company ? `${card.company}, ${title}` : title;
}

export function PipelineBoard({ cards: initial, loadError = null }: Props) {
  const [cards, setCards] = useState<PipelineCard[]>(initial);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savingJobId, setSavingJobId] = useState<string | null>(null);
  const [focusJobId, setFocusJobId] = useState<string | null>(null);

  const selectRefs = useRef(new Map<string, HTMLSelectElement>());

  // Restore focus after a card moves column and React remounts its <select>.
  // Without this, a keyboard user is dropped onto <body> every time they change a
  // stage, which is the difference between a usable board and a demo.
  useEffect(() => {
    if (!focusJobId) return;
    selectRefs.current.get(focusJobId)?.focus();
    setFocusJobId(null);
  }, [focusJobId]);

  const grouped = useMemo(() => {
    const byStage = new Map<PipelineStatus, PipelineCard[]>(PIPELINE_STATUSES.map((stage) => [stage, []]));
    for (const card of cards) byStage.get(card.status)?.push(card);
    return byStage;
  }, [cards]);

  const counts = useMemo(() => {
    const out = {} as Record<PipelineStatus, number>;
    for (const stage of PIPELINE_STATUSES) out[stage] = grouped.get(stage)?.length ?? 0;
    return out;
  }, [grouped]);

  const change = useCallback(
    async (card: PipelineCard, next: PipelineStatus, note?: string) => {
      const from = STATUS_LABEL[card.status];
      const to = STATUS_LABEL[next];
      setSavingJobId(card.job_id);
      setError(null);
      setAnnouncement(`Saving ${cardName(card)} as ${to}.`);

      try {
        // THE one write path — the same endpoint the voice agent calls, differing
        // only in `source`. No parallel implementation (hard rule 5).
        const response = await fetch('/api/pipeline/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ job_id: card.job_id, status: next, note, source: 'ui' }),
        });
        const payload = (await response.json()) as { error?: string; at?: string };
        if (!response.ok) throw new Error(payload.error ?? `Could not save (${response.status}).`);

        // Applied AFTER the write, not before. An optimistic move that the
        // warehouse then rejects leaves the board claiming something untrue, and
        // this board's whole value is that it is the record.
        setCards((current) =>
          current.map((existing) =>
            existing.job_id === card.job_id
              ? {
                  ...existing,
                  status: next,
                  status_changed_at: payload.at ?? existing.status_changed_at,
                  days_in_stage: 0,
                  // The log appended, so the count goes up. This number being
                  // visible is what makes append-only legible on screen.
                  events_total: existing.events_total + 1,
                  note: note?.trim() ? note.trim() : existing.note,
                }
              : existing,
          ),
        );
        setAnnouncement(
          next === card.status
            ? `${cardName(card)}: still ${to}, and the change was logged.`
            : `${cardName(card)}: moved from ${from} to ${to}.`,
        );
        setFocusJobId(card.job_id);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(`${cardName(card)} stayed in ${from}. ${message}`);
        // Announced too, not just coloured red: an alert region reaches a
        // screen-reader user, a red border does not.
        setAnnouncement(`Could not move ${cardName(card)}. It is still ${from}.`);
      } finally {
        setSavingJobId(null);
      }
    },
    [],
  );

  const tracked = cards.length;

  return (
    <>
      {/* Both regions are always in the DOM. A live region added at the moment it
          gets content is frequently not announced — the assistive tech has to be
          observing it beforehand. */}
      <div className="pipe-live sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <div className="pipe-alert" role="alert">
        {error ? <p className="auth-error">{error}</p> : null}
      </div>

      {loadError ? (
        <p className="auth-error" role="status">
          The pipeline could not be read just now, so this board may be incomplete. {loadError}
        </p>
      ) : null}

      {tracked === 0 ? (
        <section className="panel pipe-empty">
          <h2>Nothing in the pipeline yet</h2>
          <p className="pipe-muted">
            Open <Link href="/applicant/jobs">Jobs</Link>, pick a role worth your time, and mark it <strong>Saved</strong>.
            From then on every stage you set is appended to your history — nothing is ever overwritten, so you can see
            how long each application has been waiting.
          </p>
        </section>
      ) : (
        <>
          <section className="pipe-funnel" aria-labelledby="pipe-funnel-h">
            <h2 id="pipe-funnel-h">Where {tracked} tracked {tracked === 1 ? 'role' : 'roles'} stand</h2>
            {/* A definition list, not a chart: the numbers ARE the content, and
                the bar is decoration on top of text that already reads correctly. */}
            <dl className="pipe-funnel-list">
              {FUNNEL_STAGES.map((stage) => (
                <div key={stage} className="pipe-funnel-row">
                  <dt>
                    <span className="pipe-mark" aria-hidden="true">
                      {STATUS_MARK[stage]}
                    </span>
                    {STATUS_LABEL[stage]}
                  </dt>
                  <dd>
                    <span
                      className="pipe-bar"
                      aria-hidden="true"
                      style={{ inlineSize: `${tracked ? (counts[stage] / tracked) * 100 : 0}%` }}
                    />
                    <strong>{counts[stage]}</strong>
                  </dd>
                </div>
              ))}
              <div className="pipe-funnel-row is-exit">
                <dt>Closed out</dt>
                <dd>
                  <strong>{counts.rejected + counts.withdrawn}</strong>{' '}
                  <span className="pipe-muted">
                    ({counts.rejected} rejected, {counts.withdrawn} withdrawn)
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <div className="pipe-board">
            {PIPELINE_STATUSES.map((stage) => {
              const stageCards = grouped.get(stage) ?? [];
              const headingId = `pipe-col-${stage}`;
              return (
                <section key={stage} className="pipe-col" aria-labelledby={headingId}>
                  <header className="pipe-col-head">
                    <h2 id={headingId}>
                      <span className="pipe-mark" aria-hidden="true">
                        {STATUS_MARK[stage]}
                      </span>
                      {STATUS_LABEL[stage]}
                      {/* The count is inside the heading so a screen-reader user
                          hears "Applied, 3 roles" when they land on the column,
                          instead of having to explore it to find out. */}
                      <span className="pipe-count">
                        {stageCards.length} {stageCards.length === 1 ? 'role' : 'roles'}
                      </span>
                    </h2>
                    <p className="pipe-muted pipe-col-hint">{STATUS_HINT[stage]}</p>
                  </header>

                  {stageCards.length === 0 ? (
                    <p className="pipe-muted pipe-col-empty">
                      {stage === 'saved'
                        ? 'Save a role from Jobs and it starts here.'
                        : `Nothing at ${STATUS_LABEL[stage].toLowerCase()} yet.`}
                    </p>
                  ) : (
                    <ul className="pipe-cards">
                      {stageCards.map((card) => (
                        <Card
                          key={card.job_id}
                          card={card}
                          saving={savingJobId === card.job_id}
                          onChange={change}
                          registerRef={(element) => {
                            if (element) selectRefs.current.set(card.job_id, element);
                            else selectRefs.current.delete(card.job_id);
                          }}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function Card({
  card,
  saving,
  onChange,
  registerRef,
}: {
  card: PipelineCard;
  saving: boolean;
  onChange: (card: PipelineCard, next: PipelineStatus, note?: string) => Promise<void>;
  registerRef: (element: HTMLSelectElement | null) => void;
}) {
  const selectId = `pipe-status-${card.job_id}`;
  const noteId = `pipe-note-${card.job_id}`;
  const [note, setNote] = useState('');
  const stalled = stalledSentence(card);
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();

  /**
   * Open the room, recording the employer's reply first when there is one to
   * record.
   *
   * The write goes through `onChange`, the board's single path to
   * POST /api/pipeline/status — hard rule 5, no private implementation — and the
   * navigation waits for it, because the room re-checks the stage server-side and
   * would otherwise greet the student with "not yet" in a race they cannot see.
   * A failed write leaves the reason in the board's alert region and stays put,
   * rather than walking them into a locked door.
   */
  const openRoom = useCallback(async () => {
    if (card.status === 'applied') await onChange(card, 'interviewing');
    startNavigation(() => {
      router.push(`/applicant/interview/${encodeURIComponent(card.job_id)}`);
    });
  }, [card, onChange, router]);

  /** Saving the stage and loading the page are one wait to the person clicking. */
  const busy = saving || navigating;

  return (
    <li className="pipe-card">
      {/* The role opens its own page. It used to be an outbound link to the
          original posting, so the one obvious click left the product; and for a
          while it changed destination with the stage, which meant the same
          gesture did two different things on two cards in the same column. One
          destination, always. The interview has its own button below. */}
      <p className="pipe-card-title">
        <Link href={`/applicant/jobs/${encodeURIComponent(card.job_id)}`}>
          {card.title ?? 'Untitled role'}
          <span className="sr-only"> at {card.company ?? 'this company'} &mdash; open this role and its tools</span>
        </Link>
      </p>
      <p className="pipe-card-company">
        {card.company ?? 'Company not recorded'}
        {card.location ? <span className="pipe-muted"> · {card.location}</span> : null}
      </p>
      {card.source_url ? (
        <p className="pipe-muted pipe-card-source">
          <a href={card.source_url} target="_blank" rel="noreferrer">
            Original posting
            <span className="sr-only"> for {card.title ?? 'this role'}, opens in a new tab</span>
          </a>
        </p>
      ) : null}

      {/* Score and reason only when the match cache has them. A pipeline card is
          useful without a score, so there is no "—" placeholder to read past. */}
      {card.match_score !== null ? (
        <p className="pipe-card-score">
          Match {Math.round(card.match_score)} out of 100
          {card.match_reason ? <span className="pipe-card-reason">{card.match_reason}</span> : null}
        </p>
      ) : null}

      <p className="pipe-muted pipe-card-age">
        In {STATUS_LABEL[card.status]} {daysPhrase(card.days_in_stage)}
        {card.days_tracked !== null && card.days_tracked !== card.days_in_stage
          ? `, tracked ${daysPhrase(card.days_tracked)}`
          : ''}
        {/* events_total on screen is the append-only proof made legible: the row
            count grows, the card does not fork. */}
        {card.events_total > 1 ? ` · ${card.events_total} events logged` : ''}
      </p>

      {stalled ? <p className="pipe-card-stalled">{stalled}</p> : null}
      {card.note ? <p className="pipe-card-note">“{card.note}”</p> : null}

      {/* ONE BUTTON FOR THE INTERVIEW, and it tells you it is working.

          There were three ways in before this — the title, a link, and a second
          link with different wording on Applied cards — which is three things to
          read on a card that already carries a stage, a score, a reason, an age
          and a note box. Now there is one control and one label.

          IT SHOWS A PENDING STATE BECAUSE THE WAIT IS REAL. Opening the room
          reads the posting and the match row off a warehouse that cold-starts in
          20-30 seconds and then asks a model for the questions. A button that
          looks inert for that long reads as broken, and the student clicks it
          again. useTransition keeps the pending state tied to the actual
          navigation rather than to a timer we invented.

          An Applied card records the reply first, through the same
          POST /api/pipeline/status the <select> uses, so the label says so.
          Saved and below get nothing: rehearsing for an interview nobody offered
          is anxiety with a button on it. */}
      {interviewUnlocked(card.status) || card.status === 'applied' ? (
        <p className="pipe-card-rehearse">
          <button
            type="button"
            className="pipe-rehearse-button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void openRoom()}
          >
            {busy ? 'Preparing the room…' : 'Prepare for interview'}
            <span className="sr-only">
              {' '}
              for {card.title ?? 'this role'} at {card.company ?? 'this company'}
              {card.status === 'applied'
                ? '. This marks the role as Interviewing on your board and opens the mock interview room.'
                : '. Opens the mock interview room.'}
            </span>
          </button>
          {card.status === 'applied' ? (
            <span className="pipe-muted pipe-rehearse-hint">Marks this Interviewing first.</span>
          ) : null}
        </p>
      ) : null}

      <div className="pipe-field">
        {/* A real label, visible, associated by htmlFor. It names the JOB as well
            as the control, because "Stage" repeated down a column tells a
            screen-reader user nothing about which job they are changing. */}
        <label htmlFor={selectId}>
          Stage<span className="sr-only"> for {card.title ?? 'this role'} at {card.company ?? 'this company'}</span>
        </label>
        <select
          id={selectId}
          ref={registerRef}
          className="pipe-select"
          value={card.status}
          aria-busy={saving}
          aria-describedby={noteId}
          onChange={(event) => {
            void onChange(card, event.target.value as PipelineStatus, note || undefined);
          }}
        >
          {PIPELINE_STATUSES.map((stage) => (
            <option key={stage} value={stage}>
              {STATUS_LABEL[stage]}
            </option>
          ))}
        </select>
        <p id={noteId} className="pipe-muted pipe-field-hint">
          {saving ? 'Saving…' : 'Changing this appends an event. Nothing is overwritten.'}
        </p>
      </div>

      {/* Notes are optional and folded away, so the primary keyboard path is
          exactly two stops per card: the title link, then the stage select. */}
      <details className="pipe-note-box">
        <summary>Add a note</summary>
        <label htmlFor={`${noteId}-input`}>Note for {card.title ?? 'this role'}</label>
        <textarea
          id={`${noteId}-input`}
          value={note}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Recruiter said two weeks."
        />
        <button
          type="button"
          className="primary"
          onClick={() => {
            void onChange(card, card.status, note || undefined).then(() => setNote(''));
          }}
        >
          Log note at {STATUS_LABEL[card.status]}
        </button>
      </details>
    </li>
  );
}
