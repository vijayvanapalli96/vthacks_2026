'use client';

/**
 * The right-hand drawer: the transcript, and the typed way in.
 *
 * Collapses to a single square icon button at the edge, the way a code host's
 * file sidebar does. Fixed, so opening it never reflows the page behind it.
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
import { CornerDownLeft, MapPin, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { TranscriptEntry } from '@/lib/voice-contract';

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
  proactive,
  onDismissProactive,
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
  proactive: ProactivePrompt | null;
  onDismissProactive: () => void;
}) {
  const panelId = useId();
  const inputId = useId();
  const [value, setValue] = useState('');
  /**
   * Which questions this panel has already filed an answer for.
   *
   * Tracked locally because `options` is the queue the SERVER handed us and it is
   * only refetched on mount and on each connect — so it does not shrink as
   * answers land, and reading "the first outstanding question" straight off it
   * would park the form on question one forever. Keyed by fieldKey rather than by
   * index so a fresh session with a different queue simply stops matching.
   */
  const [answered, setAnswered] = useState<string[]>([]);
  const listRef = useRef<HTMLOListElement | null>(null);

  // Tell the document the drawer is open, so the page can make room for it
  // instead of being covered. One attribute on <html>; the width and the easing
  // live in CSS next to everything else that has to respond to it.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.transcript = open ? 'open' : 'closed';
    return () => {
      delete root.dataset.transcript;
    };
  }, [open]);

  // DERIVED, not synchronised in an effect: the current question is simply the
  // first one in the server's order that has not been answered yet. An effect that
  // mirrored this into state would re-render twice for no reason and, worse, could
  // momentarily file an answer against the wrong field between the two renders.
  const current = options.find((option) => !answered.includes(option.fieldKey)) ?? null;
  const fieldKey = current?.fieldKey ?? '';

  /* Don't print the question twice. While a conversation is live the agent SAYS it
     and that arrives as a real entry, so the pending prompt would sit directly
     under an identical agent bubble. Exact match only: speech is usually a
     rephrasing, and a fuzzy comparison here would be guesswork. */
  const lastAgentText = entries.filter((entry) => entry.role === 'agent').at(-1)?.text?.trim();
  const promptQuestion =
    current && lastAgentText !== current.question.trim() ? current.question : null;

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
    // Advance only once the write has actually returned, so a failed answer leaves
    // the same question on screen rather than silently skipping it.
    setAnswered((prev) => (prev.includes(fieldKey) ? prev : [...prev, fieldKey]));
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
        {open ? (
          <PanelRightClose size={20} aria-hidden="true" />
        ) : (
          <PanelRightOpen size={20} aria-hidden="true" />
        )}
        <span className="sr-only">
          {open ? 'Hide transcript' : 'Show transcript'}
          {entries.length ? `, ${entries.length} entries` : ''}
        </span>
        {!open && entries.length ? <span className="vt-tab-count">{entries.length}</span> : null}
      </button>

      {open ? (
        <section className="vt-panel" id={panelId} aria-label="Voice conversation transcript">
          <header className="vt-panel-head">
            <h2>Transcript</h2>
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

            {/* The outstanding question, as a turn in the conversation rather than
                as a field label above a form. It is the agent asking, in the same
                bubble the spoken agent uses, and the reply box below is just a
                reply box. Typed answers already push a 'user' turn (see
                onTypedAnswer in VoiceAgent), so question and answer alternate the
                way they do when it is spoken aloud. */}
            {promptQuestion ? (
              <li className="vt-entry vt-agent vt-asking" aria-live="polite">
                <span className="vt-who">Agent</span>
                <span className="vt-said">{promptQuestion}</span>
              </li>
            ) : null}
          </ol>

          {note ? (
            <p className="vt-note" role="status">
              {note}
            </p>
          ) : null}

          {/* Just a reply box. No heading, no "question N of M", no field labels —
              the question is in the conversation above, which is where a question
              belongs. One question is answerable at a time and it is always the
              current one, so a typist walks the same queue in the same order the
              voice agent does and cannot jump ahead to question seven. */}
          <form className="vt-reply" onSubmit={submit}>
            <input
              id={inputId}
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={current ? 'Type your reply' : 'Nothing to answer right now'}
              aria-label={current ? current.question : 'Your reply'}
              autoComplete="off"
              maxLength={600}
              disabled={!current}
            />
            <button
              type="submit"
              className="vt-send vt-send-icon"
              disabled={busy || !value.trim() || !current}
            >
              <CornerDownLeft size={16} aria-hidden="true" />
              <span className="vt-sr-only">{busy ? 'Sending your reply' : 'Send reply'}</span>
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
