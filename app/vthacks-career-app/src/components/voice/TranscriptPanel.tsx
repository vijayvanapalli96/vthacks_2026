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
import { ChevronLeft, ChevronRight, CornerDownLeft } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { TranscriptEntry } from '@/lib/voice-contract';

import { TranscriptAction } from './TranscriptAction';

export type TypedOption = { fieldKey: string; question: string };

export function TranscriptPanel({
  entries,
  options,
  open,
  onToggle,
  onTypedAnswer,
  busy,
  note,
}: {
  entries: TranscriptEntry[];
  options: TypedOption[];
  open: boolean;
  onToggle: () => void;
  onTypedAnswer: (fieldKey: string, value: string) => Promise<void>;
  busy: boolean;
  note: string | null;
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
              Everything said, in order, and every change it made to your profile. Voice and typing
              go to the same place.
            </p>
          </header>

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
           tab order. */
        <p className="vt-sr-only" aria-live="polite">
          {latest ? `${latest.role === 'action' ? 'Action' : latest.role === 'user' ? 'You said' : 'Agent said'}: ${latest.text}` : ''}
        </p>
      )}
    </div>
  );
}
