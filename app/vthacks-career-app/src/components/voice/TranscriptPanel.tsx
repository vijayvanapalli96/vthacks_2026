'use client';

/**
 * The left collapsible tab: the transcript, and the typed way in.
 *
 * TWO NON-NEGOTIABLES LIVE HERE.
 *
 * 1. The typed input is P0, not polish. It posts to the SAME /api/voice/answer the
 *    spoken client tool does — hard rule 5 — and it is the path that still works when
 *    the microphone is denied, the room is loud, or the demo laptop decides today is
 *    the day. Anything you can say, you can type, and it is the same endpoint either
 *    way rather than two handlers that drift.
 *
 * 2. The list is aria-live="polite", so a screen-reader user hears turns as they
 *    arrive instead of having to go looking. When the panel is COLLAPSED the list is
 *    unmounted — an unmounted region announces nothing — so a visually hidden live
 *    region takes over and reads the latest line. Collapsing the panel must not
 *    silently switch the product's accessibility off.
 *
 * Collapsed state is persisted by the parent, which owns the localStorage read.
 */
import { ChevronLeft, ChevronRight, CornerDownLeft, MapPin } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { MatchBrief, TranscriptEntry, VoiceJobStatus } from '@/lib/voice-contract';

import { MatchDigest } from './MatchDigest';
import { TranscriptAction } from './TranscriptAction';

export type TypedOption = { fieldKey: string; question: string };

/**
 * The words the agent WOULD have volunteered, when no conversation is open.
 *
 * This is the whole of "proactive without being creepy". When a match run lands and a
 * conversation is already live, the agent says it. When one is not, the app shows the
 * SAME SENTENCE as text with a button — it does not open a microphone to tell you
 * something. See the note in VoiceAgent.tsx: ElevenLabs bills per conversation-minute
 * and an unasked microphone is a consent problem before it is a billing one.
 */
export type ProactivePrompt = {
  /** Exactly what the agent would have said. Not a paraphrase of it. */
  text: string;
  /** The primary thing to do about it, e.g. open the strongest match. */
  actionLabel: string | null;
  onAction: (() => void) | null;
};

export function TranscriptPanel({
  entries,
  options,
  open,
  onToggle,
  onTypedAnswer,
  busy,
  note,
  pageName,
  matches,
  matchesStale,
  refreshing,
  proactive,
  onDismissProactive,
  onRefreshMatches,
  onOpenJob,
  onExplainJob,
  onSetJobStatus,
}: {
  entries: TranscriptEntry[];
  options: TypedOption[];
  open: boolean;
  onToggle: () => void;
  onTypedAnswer: (fieldKey: string, value: string) => Promise<void>;
  busy: boolean;
  note: string | null;
  /** What the server says this page is. Never parsed from the URL in the browser. */
  pageName: string | null;
  matches: MatchBrief[];
  matchesStale: boolean;
  refreshing: boolean;
  proactive: ProactivePrompt | null;
  onDismissProactive: () => void;
  onRefreshMatches: () => void;
  onOpenJob: (jobId: string, target: 'job' | 'apply') => void;
  onExplainJob: (jobId: string) => void;
  onSetJobStatus: (jobId: string, status: VoiceJobStatus) => void;
}) {
  const panelId = useId();
  const selectId = useId();
  const inputId = useId();
  const [chosen, setChosen] = useState('');
  const [value, setValue] = useState('');
  const listRef = useRef<HTMLOListElement | null>(null);

  // DERIVED, not synchronised in an effect. The select defaults to the first
  // outstanding question and honours an explicit choice for as long as that choice
  // is still in the list. Doing this with a useEffect + setState would re-render
  // twice for no reason and, worse, could momentarily file an answer against the
  // wrong field in the gap between the two renders.
  const fieldKey = options.some((option) => option.fieldKey === chosen)
    ? chosen
    : (options[0]?.fieldKey ?? '');

  // Keep the newest turn in view. scrollTop rather than scrollIntoView: the latter
  // scrolls the whole page when the panel is taller than the viewport.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries]);

  const latest = entries[entries.length - 1];

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || !fieldKey || busy) return;
    // Cleared before awaiting so a slow warehouse cannot cause a double submit of
    // the same sentence when someone presses Enter twice.
    setValue('');
    await onTypedAnswer(fieldKey, trimmed);
  }

  return (
    <div className={`vt-dock ${open ? 'is-open' : 'is-closed'}`}>
      <button
        type="button"
        className="vt-tab"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        {open ? <ChevronLeft size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span className="vt-tab-label">
          Transcript
          {entries.length ? ` (${entries.length})` : ''}
        </span>
      </button>

      {open ? (
        <section className="vt-panel" id={panelId} aria-label="Voice conversation transcript">
          <header className="vt-panel-head">
            <h2>Transcript</h2>
            <p>
              Everything said and everything done, in order. Voice and typing go to the same
              endpoints — there is no action here you can only reach with a microphone.
            </p>
            {/* The agent's page awareness, shown rather than merely claimed. If the
                agent is wrong about where you are, you can see that it is wrong. */}
            {pageName ? (
              <p className="vt-page" role="status">
                <MapPin size={13} aria-hidden="true" />
                <span>
                  The agent knows you are on <strong>{pageName}</strong>.
                </span>
              </p>
            ) : null}
          </header>

          {/* Proactivity as TEXT when no conversation is open. Announced politely so a
              screen-reader user is told matches landed without the focus being stolen. */}
          {proactive ? (
            <div className="vt-proactive" role="status">
              <p>{proactive.text}</p>
              <div className="vt-proactive-actions">
                {proactive.actionLabel && proactive.onAction ? (
                  <button type="button" className="vt-mini" onClick={proactive.onAction} disabled={busy}>
                    {proactive.actionLabel}
                  </button>
                ) : null}
                <button type="button" className="vt-mini vt-mini-quiet" onClick={onDismissProactive}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}

          <ol className="vt-list" ref={listRef} aria-live="polite" aria-relevant="additions text">
            {entries.length === 0 ? (
              <li className="vt-entry vt-empty">
                Nothing yet. Start the voice control, or type an answer below — both write to the
                same endpoint.
              </li>
            ) : null}
            {entries.map((entry) =>
              entry.role === 'action' ? (
                <TranscriptAction key={entry.id} entry={entry} />
              ) : (
                <li key={entry.id} className={`vt-entry vt-${entry.role}`}>
                  <span className="vt-who">{entry.role === 'user' ? 'You' : 'Agent'}</span>
                  <span className="vt-said">{entry.text}</span>
                </li>
              ),
            )}
          </ol>

          {note ? (
            <p className="vt-note" role="status">
              {note}
            </p>
          ) : null}

          {/* Every spoken action has its button here, calling the same endpoint. */}
          <MatchDigest
            matches={matches}
            stale={matchesStale}
            refreshing={refreshing}
            busy={busy}
            onRefresh={onRefreshMatches}
            onOpen={onOpenJob}
            onExplain={onExplainJob}
            onSetStatus={onSetJobStatus}
          />

          <form className="vt-typed" onSubmit={submit}>
            <h3>Type an answer instead</h3>
            <div className="vt-typed-row">
              <label htmlFor={selectId}>Which question</label>
              <select
                id={selectId}
                value={fieldKey}
                onChange={(event) => setChosen(event.target.value)}
                disabled={options.length === 0}
              >
                {options.length === 0 ? <option value="">Nothing outstanding</option> : null}
                {options.map((option) => (
                  <option key={option.fieldKey} value={option.fieldKey}>
                    {option.question}
                  </option>
                ))}
              </select>
            </div>
            <div className="vt-typed-row">
              <label htmlFor={inputId}>Your answer</label>
              <input
                id={inputId}
                type="text"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Type it exactly as you would say it"
                autoComplete="off"
                maxLength={600}
                disabled={options.length === 0}
              />
            </div>
            <button type="submit" className="vt-send" disabled={busy || !value.trim() || !fieldKey}>
              <CornerDownLeft size={15} aria-hidden="true" />
              {busy ? 'Saving…' : 'Record this answer'}
            </button>
          </form>
        </section>
      ) : (
        /* The panel is closed, so the list above is unmounted and announces nothing.
           This keeps turns audible without putting a hidden, focusable panel in the
           tab order. The proactive prompt is announced here too: matches landing is
           the one thing that happens without the user doing anything, so it is the
           one thing that must not be silent behind a collapsed panel. */
        <p className="vt-sr-only" aria-live="polite">
          {proactive
            ? `${proactive.text} Open the transcript to act on it.`
            : latest
              ? `${latest.role === 'action' ? 'Action' : latest.role === 'user' ? 'You said' : 'Agent said'}: ${latest.text}`
              : ''}
        </p>
      )}
    </div>
  );
}
