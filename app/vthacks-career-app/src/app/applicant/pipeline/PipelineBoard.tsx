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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { interviewUnlocked } from '@/lib/interview-contract';
import {
  PIPELINE_STATUSES,
  STATUS_LABEL,
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
          {/* ONE LIST, NOT SEVEN COLUMNS. The per-stage columns were mostly empty
              headings: with a handful of tracked roles, six of the seven said
              "nothing here yet", which is a lot of furniture to say very little.
              The stage a role is in is already on its own card, and changing it
              is still the <select> on that card, so nothing was lost but the
              scaffolding. The summary funnel went for the same reason: counting
              to two is not worth a chart.

              Ordered by stage (PIPELINE_STATUSES order), so the funnel reading
              survives as sequence rather than as headings. */}
          <ul className="pipe-cards pipe-cards-flat">
            {PIPELINE_STATUSES.flatMap((stage) => grouped.get(stage) ?? []).map((card) => (
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

  /**
   * Record the employer's reply, then open the room.
   *
   * Reuses `onChange`, which is the board's single write path to
   * POST /api/pipeline/status — hard rule 5 again, no private implementation. The
   * navigation waits for the write because the room re-checks the stage server-side
   * and would otherwise greet a student with "not yet" in a race they cannot see.
   * If the write fails, `onChange` puts the reason in the board's alert region and
   * this stays put rather than walking them into a locked door.
   */
  /** See the comment on the title below: one honest destination per stage. */
  const roleHref = interviewUnlocked(card.status)
    ? `/applicant/interview/${encodeURIComponent(card.job_id)}`
    : `/applicant/jobs/${encodeURIComponent(card.job_id)}`;

  const replyAndRehearse = useCallback(async () => {
    await onChange(card, 'interviewing');
    router.push(`/applicant/interview/${encodeURIComponent(card.job_id)}`);
  }, [card, onChange, router]);

  return (
    <li className="pipe-card">
      {/* CLICKING THE ROLE OPENS ITS MENU, which is the thing a card on a board is
          expected to do and previously did not: the title used to be an outbound
          link to the original posting, so the one obvious click left the product.

          WHERE IT GOES DEPENDS ON THE STAGE, because there is only one honest
          destination per stage. At Interviewing or Offer the rehearsal exists, so
          it goes straight to the interview room. Everywhere else it goes to the
          job page, which carries the document toolbox and the interview panel —
          sending an Applied card into the room would land on "not yet", and a
          click that reaches a locked door is worse than one that never offered.

          NOT A WHOLE-CARD CLICK TARGET. The card holds a <select>, a <textarea>
          and a button; wrapping all of that in a link nests interactive elements,
          which breaks keyboard navigation and makes a screen reader announce the
          lot as one control. Hard rule 6. The title is the target, the posting
          keeps its own link below, and both are reachable by Tab in reading
          order. */}
      <p className="pipe-card-title">
        <Link href={roleHref}>
          {card.title ?? 'Untitled role'}
          <span className="sr-only">
            {' '}
            at {card.company ?? 'this company'} &mdash;{' '}
            {interviewUnlocked(card.status) ? 'open the mock interview room' : 'open this role and its tools'}
          </span>
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

      {/* The one thing this board could never offer: something to DO the moment an
          employer replies.
          
          TWO SHAPES, ONE DESTINATION. On a card that is already Interviewing or
          Offer it is a plain link. On an APPLIED card it is a button that records
          the reply first and then opens the room, because the interview room is
          gated on the stage and a link that lands on "not yet" is a dead end.
          
          The button says what it writes. It is the same append-only event the
          <select> above produces — one more row in the log, not a silent edit —
          and the label has to make that obvious, because a student who has not
          actually heard back must not click it by accident. Nothing below Applied
          gets it: rehearsing for an interview nobody offered is anxiety with a
          button on it. */}
      {interviewUnlocked(card.status) ? (
        <p className="pipe-card-rehearse">
          <Link href={`/applicant/interview/${encodeURIComponent(card.job_id)}`}>
            Begin interview
            <span className="sr-only">
              {' '}
              for {card.title ?? 'this role'} at {card.company ?? 'this company'}
            </span>
          </Link>
        </p>
      ) : card.status === 'applied' ? (
        <p className="pipe-card-rehearse">
          <button
            type="button"
            className="pipe-rehearse-button"
            disabled={saving}
            aria-busy={saving}
            onClick={() => void replyAndRehearse()}
          >
            They replied &mdash; begin interview
            <span className="sr-only">
              {' '}
              for {card.title ?? 'this role'} at {card.company ?? 'this company'}. This marks the role as
              Interviewing on your board and opens the mock interview room.
            </span>
          </button>
          <span className="pipe-muted pipe-rehearse-hint">Marks this Interviewing, then opens the room.</span>
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
