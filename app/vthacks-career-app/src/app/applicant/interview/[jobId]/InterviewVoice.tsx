'use client';

/**
 * InterviewVoice — persona 2 actually speaking, and a wave that moves with it.
 *
 * WHAT WAS MISSING. The room already asked the server for a signed conversation
 * URL and rendered a "the interviewer voice is off" line when there was none. It
 * never opened the conversation, so even a fully configured deployment sat silent
 * and the questions stayed on screen. This is the half that was never wired.
 *
 * THE MICROPHONE NEVER OPENS BY ITSELF — the same rule VoiceAgent.tsx holds, for
 * the same two reasons. Grabbing a microphone unasked is a consent problem, and
 * ElevenLabs bills per conversation-minute on a free-tier account, so a room left
 * open in a background tab must not quietly spend money. There is a button, the
 * student presses it, and the session ends on unmount and when the tab is hidden.
 *
 * THE AGENT DOES NOT DRIVE THE INTERVIEW, IT VOICES IT. The queue, the answers,
 * the critique and every write belong to the room. The agent is provisioned with
 * no tools at all (scripts/provision-interviewer-agent.mjs) and is told to ask the
 * queue verbatim. That keeps one source of truth for what was asked: the thing
 * critiqued is the thing on screen, not a follow-up the model improvised.
 *
 * WHAT THE WAVE IS. Not decoration and not a random generator: each column is a
 * frequency band of the agent's ACTUAL output audio, read every frame from
 * getOutputByteFrequencyData(). So it moves with the voice — it peaks on a
 * stressed syllable and it is flat during a pause, because that is what the audio
 * is doing. A visualiser that animates while the room is silent is a lie about
 * whether the thing is working, and this one is also the fastest way to see that
 * the agent has stopped talking and is waiting for you.
 */

import { ConversationProvider, useConversation } from '@elevenlabs/react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Props = {
  signedUrl: string;
  dynamicVariables: Record<string, string>;
  /** Shown in the transcript line so the student can see what it just asked. */
  onAgentLine?: (text: string) => void;
  /**
   * The question the ROOM is on, and its position. The room owns the order; this
   * is how the agent is told where it has got to. See the effect below.
   */
  currentQuestion: { id: string; text: string } | null;
  questionNumber: number;
  questionCount: number;
};

/**
 * The provider owns the conversation singleton; the panel owns our state.
 *
 * THIS SPLIT IS NOT OPTIONAL. `useConversation` throws "must be used within a
 * ConversationProvider" on render, and because it throws during render rather
 * than returning null, the whole route dies — the room showed "This page
 * couldn't load" the moment the interview started and the panel mounted. The
 * server logs were clean, because nothing was wrong on the server.
 *
 * VoiceAgent.tsx has the same two-component shape for the same reason and says
 * so; this file was written without it and shipped the crash.
 */
export function InterviewVoice(props: Props) {
  return (
    <ConversationProvider>
      <InterviewVoicePanel {...props} />
    </ConversationProvider>
  );
}

function InterviewVoicePanel({
  signedUrl,
  dynamicVariables,
  onAgentLine,
  currentQuestion,
  questionNumber,
  questionCount,
}: Props) {
  const [failed, setFailed] = useState<string | null>(null);

  // useConversation returns a fresh object every render, so anything read inside
  // an animation frame or an unmount handler goes through a ref. Same discipline,
  // and the same reason, as the `live` ref in VoiceAgent.tsx.
  const live = useRef<{ end: () => void; update: (text: string) => void }>({
    end: () => {},
    update: () => {},
  });

  const conversation = useConversation({
    onMessage: ({ message, source }) => {
      if (source === 'ai' && onAgentLine) onAgentLine(message);
    },
    onError: (message: string) => setFailed(message),
  });

  const { status, isSpeaking, getOutputByteFrequencyData } = conversation;
  const connected = status === 'connected';

  useEffect(() => {
    live.current.end = conversation.endSession;
    live.current.update = conversation.sendContextualUpdate;
  }, [conversation]);

  /**
   * KEEP THE AGENT IN STEP WITH THE ROOM.
   *
   * The agent was handed the whole queue at the start and then asked it on its
   * own clock. The room advances when an answer is SENT, so the moment a student
   * typed an answer instead of speaking it the two drifted: the screen showed
   * question three while the voice was still on question two.
   *
   * The room owns the order. Every time the current question changes, the agent
   * is told where we are with a CONTEXTUAL UPDATE - a message it reads but does
   * not speak - and asked for that exact question next. One source of truth, and
   * the thing critiqued stays the thing on screen.
   *
   * The first question is skipped: the agent's own opening line already asks it,
   * and an update racing the greeting makes it ask twice.
   */
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'connected' || !currentQuestion) return;
    if (askedRef.current === currentQuestion.id) return;

    const first = askedRef.current === null;
    askedRef.current = currentQuestion.id;
    if (first) return;

    live.current.update(
      `The candidate has answered. You are now on question ${questionNumber} of ${questionCount}. ` +
        `Acknowledge briefly and neutrally, then ask exactly this question next: "${currentQuestion.text}"`,
    );
  }, [currentQuestion, questionCount, questionNumber, status]);

  // End the session on unmount, and again when the tab is hidden. A conversation
  // left running in a background tab bills by the minute.
  //
  // TWO EFFECTS, NOT ONE, and the split is deliberate: react-hooks/exhaustive-deps
  // flags `live.current` read inside a cleanup that also does something else, and
  // the bare `() => () => ...` form is the idiom VoiceAgent.tsx already uses for
  // exactly this. The listener's own handler is not a cleanup, so it is fine.
  useEffect(() => () => live.current.end(), []);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') live.current.end();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, []);

  const start = useCallback(() => {
    setFailed(null);
    try {
      conversation.startSession({ signedUrl, connectionType: 'websocket', dynamicVariables });
    } catch (error) {
      setFailed((error as Error).message);
    }
  }, [conversation, dynamicVariables, signedUrl]);

  return (
    <section className="iv-voice" aria-labelledby="iv-voice-heading">
      <h3 id="iv-voice-heading" className="iv-h3">
        Interviewer
      </h3>

      <PixelWave active={connected} speaking={isSpeaking} read={getOutputByteFrequencyData} />

      {/* Status in WORDS. The wave is the glanceable version and is useless to a
          screen reader, so the state it conveys is also written here. */}
      <p className="iv-muted" role="status" aria-live="polite">
        {failed
          ? `The interviewer voice stopped: ${failed} The questions are on screen and everything else still works.`
          : connected
            ? isSpeaking
              ? 'The interviewer is speaking.'
              : 'The interviewer is listening.'
            : status === 'connecting'
              ? 'Connecting the interviewer.'
              : 'The interviewer is not connected. The questions are on screen either way.'}
      </p>

      {connected ? (
        <button type="button" className="iv-button iv-button-quiet" onClick={() => conversation.endSession()}>
          Stop the interviewer
        </button>
      ) : (
        <button type="button" className="iv-button" disabled={status === 'connecting'} onClick={start}>
          Let the interviewer ask out loud
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- wave */

/** Columns across. Enough to read as a wave, few enough to stay crisp as squares. */
const COLUMNS = 48;
/** Rows per column. The wave is quantised to this many steps — the "pixel" part. */
const ROWS = 12;

/**
 * The pixel wave.
 *
 * A grid of squares. Each column takes one band of the output spectrum and lights
 * that fraction of its rows from the middle out, so speech reads as a band that
 * swells and collapses rather than as bars growing off a floor.
 *
 * DRAWN ON A CANVAS, NOT IN THE DOM. 48 columns at 60fps is ~2,900 elements being
 * restyled every frame if this were divs, which is a jank machine on a laptop that
 * is also encoding webcam JPEGs for the steadiness read.
 *
 * IT STOPS WHEN THERE IS NOTHING TO SAY. No connection means no animation frame
 * loop at all, and `prefers-reduced-motion` gets a single static row: an animation
 * nobody asked for, running next to a camera preview, is exactly what that setting
 * exists to turn off.
 */
function PixelWave({
  active,
  speaking,
  read,
}: {
  active: boolean;
  speaking: boolean;
  read: () => Uint8Array;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const readRef = useRef(read);

  useEffect(() => {
    readRef.current = read;
  }, [read]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The ink colour is read from the cascade rather than hard-coded, so the wave
    // follows the theme like everything else on the page.
    const ink = getComputedStyle(canvas).getPropertyValue('color').trim() || '#000';

    const cell = Math.floor(canvas.width / COLUMNS);
    const gap = Math.max(1, Math.floor(cell * 0.18));
    const size = cell - gap;

    const draw = (levels: number[]) => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = ink;
      for (let column = 0; column < COLUMNS; column += 1) {
        // Lit rows for this column, always at least one so the grid never vanishes
        // entirely — a blank panel reads as broken rather than as silent.
        const lit = Math.max(1, Math.round(levels[column] * ROWS));
        const from = Math.floor((ROWS - lit) / 2);
        for (let row = from; row < from + lit; row += 1) {
          // Quieter towards the edges of the band: the difference between a lit
          // square and its neighbour is what makes it read as a wave.
          context.globalAlpha = 0.35 + 0.65 * (1 - Math.abs(row - (ROWS - 1) / 2) / (ROWS / 2));
          context.fillRect(column * cell, row * cell, size, size);
        }
      }
      context.globalAlpha = 1;
    };

    if (!active || reduced) {
      draw(new Array(COLUMNS).fill(0));
      return;
    }

    let frame = 0;
    // Smoothed frame to frame. Raw FFT output jitters hard enough to strobe, and
    // a decay that is slower than the attack is what makes a voice look like a
    // voice rather than like static.
    const smoothed = new Array<number>(COLUMNS).fill(0);

    const tick = () => {
      let data: Uint8Array;
      try {
        data = readRef.current();
      } catch {
        // The analyser is gone mid-teardown. Nothing to draw, nothing to report.
        return;
      }

      const bins = data.length || 1;
      for (let column = 0; column < COLUMNS; column += 1) {
        // Low frequencies carry speech, so the columns sample the bottom 60% of
        // the spectrum. Sampling the whole range leaves most of the grid dead.
        const index = Math.floor((column / COLUMNS) * bins * 0.6);
        const next = (data[index] ?? 0) / 255;
        smoothed[column] = next > smoothed[column] ? next : smoothed[column] * 0.82 + next * 0.18;
      }
      draw(smoothed);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className="iv-wave"
      width={COLUMNS * 8}
      height={ROWS * 8}
      /* The wave duplicates what the status line below already says in words. */
      aria-hidden="true"
      data-speaking={speaking ? 'true' : 'false'}
    />
  );
}
