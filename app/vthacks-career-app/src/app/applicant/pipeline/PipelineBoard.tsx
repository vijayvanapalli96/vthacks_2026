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

import {
  interviewUnlocked,
  putPreparedSession,
  type InterviewSessionPayload,
} from '@/lib/interview-contract';
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

  const [preparing, setPreparing] = useState(false);
  const [navigating, startNavigation] = useTransition();
  /** Saving a stage, preparing the room and loading the page are one wait to the person clicking. */
  const busy = saving || preparing || navigating;

  /**
   * PREPARE THE ROOM, THEN SWITCH TO IT.
   *
   * The room used to be opened cold: navigate, and only once the page had mounted
   * did it ask for a session — a cold warehouse read plus a model call, spent
   * looking at an empty room. The wait now happens here, on a button that says it
   * is working, and the room opens with its questions already in hand.
   *
   * The payload is handed over in sessionStorage rather than a query parameter,
   * because it carries a signed conversation credential and a URL gets logged,
   * copied and shared. The room CONSUMES it, so a session is never minted twice:
   * each mint writes a telemetry row and spends a Gemini call.
   *
   * A FAILED PREFETCH STILL NAVIGATES — the room asks for its own session when
   * there is no handoff, so the worst case is the behaviour we had before rather
   * than a dead button. Only a failed STAGE write stops it, because the room's
   * server-side gate would then turn the student away at the door.
   */
  const startInterview = useCallback(async () => {
    setPreparing(true);
    try {
      if (card.status === 'applied') await onChange(card, 'interviewing');
      try {
        const response = await fetch(`/api/interview/${encodeURIComponent(card.job_id)}/session`, {
          cache: 'no-store',
        });
        if (response.ok) putPreparedSession(card.job_id, (await response.json()) as InterviewSessionPayload);
      } catch {
        // Offline, or the warehouse said no. The room will ask for itself.
      }
      startNavigation(() => router.push(`/applicant/interview/${encodeURIComponent(card.job_id)}`));
    } finally {
      setPreparing(false);
    }
  }, [card, onChange, router]);

  return (
    <li className="pipe-card">
      {/* THE CARD IS THE ROLE AND THE ACTION. Everything else folds away.

          It had grown to nine things competing for one glance: title, company,
          an outbound posting link, a match score, a reason paragraph, an age, an
          event count, a stage select with its own explanatory line, and a note
          box. Every one of them earns its place SOMEWHERE — none of them earns
          being the first thing you read on a board you are scanning.

          So: the role, and one button. The rest lives in a disclosure, which
          keeps it a single keystroke away, keyboard reachable and announced, and
          costs nothing to ignore. Nothing was deleted.

          The title opens the role's own page, always. It previously changed
          destination with the stage, which meant the same gesture did two
          different things on two cards in the same column. */}
      <p className="pipe-card-title">
        <Link href={`/applicant/jobs/${encodeURIComponent(card.job_id)}`}>
          {card.title ?? 'Untitled role'}
          <span className="sr-only"> at {card.company ?? 'this company'} — open this role and its tools</span>
        </Link>
      </p>
      <p className="pipe-card-company">
        {card.company ?? 'Company not recorded'}
        {card.location ? <span className="pipe-muted"> · {card.location}</span> : null}
      </p>

      {/* The one sentence worth interrupting for: this has been sitting. */}
      {stalled ? <p className="pipe-card-stalled">{stalled}</p> : null}

      {/* THE ACTION. Applied records the reply first, through the board's single
          write path, and says so. Saved and below get nothing — rehearsing for an
          interview nobody offered is anxiety with a button on it. */}
      {interviewUnlocked(card.status) || card.status === 'applied' ? (
        <p className="pipe-card-rehearse">
          <button
            type="button"
            className="pipe-rehearse-button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void startInterview()}
          >
            {busy ? 'Preparing the room…' : 'Start mock interview'}
            <span className="sr-only">
              {' '}
              for {card.title ?? 'this role'} at {card.company ?? 'this company'}
              {card.status === 'applied'
                ? '. This marks the role as Interviewing on your board and opens the mock interview room.'
                : '. Opens the mock interview room.'}
            </span>
          </button>
          {card.status === 'applied' && !busy ? (
            <span className="pipe-muted pipe-rehearse-hint">Marks this Interviewing first.</span>
          ) : null}
        </p>
      ) : null}

      <details className="pipe-card-more">
        <summary>
          Details and stage
          <span className="sr-only"> for {card.title ?? 'this role'} at {card.company ?? 'this company'}</span>
        </summary>

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
          {/* events_total on screen is the append-only proof made legible: the
              row count grows, the card does not fork. */}
          {card.events_total > 1 ? ` · ${card.events_total} events logged` : ''}
        </p>

        {card.note ? <p className="pipe-card-note">“{card.note}”</p> : null}

        {card.source_url ? (
          <p className="pipe-muted pipe-card-source">
            <a href={card.source_url} target="_blank" rel="noreferrer">
              Original posting
              <span className="sr-only"> for {card.title ?? 'this role'}, opens in a new tab</span>
            </a>
          </p>
        ) : null}

        <div className="pipe-field">
          {/* A real label, visible, associated by htmlFor. It names the JOB as
              well as the control, because "Stage" repeated down a list tells a
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

        <label className="pipe-note-label" htmlFor={`${noteId}-input`}>
          Note for {card.title ?? 'this role'}
        </label>
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
