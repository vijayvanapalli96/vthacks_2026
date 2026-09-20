'use client';

/**
 * VoiceAgent — the orchestration. Owns the transcript, the session, and the one
 * function both input methods call.
 *
 * WHY `useConversation` AND NOT THE `<elevenlabs-convai>` WIDGET. The drop-in widget
 * is two lines and wrong for this product: it renders its own bubble, keeps its own
 * transcript, and gives us no hook to show what a turn DID to the user's data. The
 * transcript, the action lines and the typed fallback are the feature; the widget
 * would have hidden all three behind an iframe we do not control.
 *
 * WHY A CLIENT TOOL AND NOT A SERVER WEBHOOK. An ElevenLabs server tool calls an
 * HTTPS URL directly, so it needs a public one — `localhost:3001` has none, and
 * tunnelling is a demo dependency waiting to break on stage. A client tool runs in
 * this browser, so `fetch('/api/voice/answer')` carries the session cookie and the
 * answer is attributed by the same requireRole() guard as every other route, rather
 * than by a user id the model was told to pass along.
 *
 * WHY THE WRITE IS RACED AGAINST A TIMER. Each answer is several Databricks
 * statements against a warehouse that cold-starts in 20-30 seconds. Blocking the
 * agent's next question on that makes the conversation feel broken, so the tool
 * returns an honest "recording it now" once OPTIMISTIC_MS has passed and the
 * transcript line settles to confirmed or failed when the write actually lands. The
 * user sees the truth either way; they just do not sit in silence waiting for it.
 *
 * COST. ElevenLabs bills per conversation-minute. The session is ended on unmount
 * and when the tab is hidden, and it is never started without a click. An idle open
 * microphone is a privacy problem first and a bill second.
 */
import { ConversationProvider, useConversation } from '@elevenlabs/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { AgentFaceLive } from '@/components/AgentFaceLive';
import type {
  TranscriptEntry,
  VoiceAnswerResponse,
  VoiceSessionPayload,
} from '@/lib/voice-contract';

import { TranscriptPanel, type TypedOption } from './TranscriptPanel';
import { VoiceWidget, type VoiceStatus, type VoiceVisualState } from './VoiceWidget';
import './voice.css';

/** How long the client tool waits for the write before answering optimistically. */
const OPTIMISTIC_MS = 3_500;

const TRANSCRIPT_KEY = 'hirewire.voice.transcript-open';

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/* ------------------------------------------------- the persisted open/closed bit */

/**
 * Whether the transcript is expanded, as an external store rather than component
 * state.
 *
 * localStorage cannot be read during render — the server and the client would
 * produce different HTML and React 19 discards the tree — and it cannot be read in an
 * effect that calls setState without triggering the cascading re-render
 * `react-hooks/set-state-in-effect` exists to prevent. useSyncExternalStore is the
 * mechanism built for exactly this: `serverSnapshot` is what SSR renders, `snapshot`
 * is what the browser reads, and React reconciles the two after hydration without
 * calling it a mismatch.
 *
 * The 'storage' subscription is a small bonus: two tabs open on the dashboard stay in
 * agreement about whether the panel is showing.
 */
const TRANSCRIPT_LISTENERS = new Set<() => void>();

function subscribeTranscript(onChange: () => void): () => void {
  TRANSCRIPT_LISTENERS.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    TRANSCRIPT_LISTENERS.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function transcriptSnapshot(): boolean {
  try {
    // Default OPEN. A transcript nobody can find does not satisfy "you can always
    // read exactly what was said".
    return window.localStorage.getItem(TRANSCRIPT_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function transcriptServerSnapshot(): boolean {
  return true;
}

function persistTranscriptOpen(next: boolean): void {
  try {
    window.localStorage.setItem(TRANSCRIPT_KEY, next ? 'open' : 'closed');
  } catch {
    // A blocked localStorage costs persistence for this session, not the feature.
  }
  for (const listener of TRANSCRIPT_LISTENERS) listener();
}

function newId(): string {
  // randomUUID needs a secure context; http://localhost counts as one, but a plain
  // http:// LAN address does not, and the demo has been driven from one before.
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function VoiceAgent() {
  // The provider owns the conversation singleton; the shell owns our state. Split
  // because useConversation must be called inside the provider.
  return (
    <ConversationProvider>
      <VoiceAgentShell />
    </ConversationProvider>
  );
}

function VoiceAgentShell() {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [options, setOptions] = useState<TypedOption[]>([]);
  const [gapsRemaining, setGapsRemaining] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useSyncExternalStore(subscribeTranscript, transcriptSnapshot, transcriptServerSnapshot);

  const conversationId = useRef('');
  /** The most recent thing the user said, so the persisted turn is their words. */
  const lastUserText = useRef('');
  const loadedOnce = useRef(false);

  const push = useCallback((entry: TranscriptEntry) => {
    setEntries((previous) => [...previous, entry]);
  }, []);

  /* ------------------------------------------------------------ the session */

  const loadSession = useCallback(async (): Promise<VoiceSessionPayload | null> => {
    try {
      const res = await fetch('/api/voice/session', { cache: 'no-store' });
      if (!res.ok) {
        setUnavailable(`The voice session could not be prepared (${res.status}). You can still type your answers.`);
        return null;
      }
      const payload = (await res.json()) as VoiceSessionPayload;
      // NOT filtered as answers land: leaving the whole original queue in the select
      // is what makes "I misspoke, let me correct that" possible without a reload.
      setOptions(payload.gaps.map((gap) => ({ fieldKey: gap.fieldKey, question: gap.question })));
      setGapsRemaining(payload.gaps.length);
      setUnavailable(payload.unavailableReason);
      return payload;
    } catch (error) {
      setUnavailable(`The voice session could not be prepared — ${(error as Error).message}. You can still type your answers.`);
      return null;
    }
  }, []);

  // Once, on mount. This mints a signed URL but does NOT start a conversation, so
  // it costs no ElevenLabs minutes — and it warms the Databricks write path so the
  // first answer is not the one that pays the cold start. React 19 runs effects
  // twice in development; the ref is what stops two sessions being prepared.
  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    void loadSession();
  }, [loadSession]);

  const toggleTranscript = useCallback(() => {
    persistTranscriptOpen(!transcriptSnapshot());
  }, []);

  /* -------------------------------------------------------- the write path */

  /**
   * The one function both the spoken tool and the typed form call. It never rejects:
   * a failure is a `failed` transcript line and an ok:false payload, because the
   * agent has to be able to say out loud that the answer did not save.
   */
  const submitAnswer = useCallback(
    async (
      fieldKey: string,
      value: string,
      source: 'voice' | 'form',
      spokenText?: string,
    ): Promise<VoiceAnswerResponse> => {
      const localId = newId();
      push({
        id: localId,
        role: 'action',
        kind: 'profile_updated',
        state: 'pending',
        text: `Recording ${fieldKey}: ${value}`,
        fieldKey,
        at: Date.now(),
      });

      const settle = (payload: VoiceAnswerResponse) => {
        setEntries((previous) =>
          previous.map((entry) =>
            entry.id === localId && entry.role === 'action'
              ? { ...entry, state: payload.ok ? 'done' : 'failed', text: payload.action }
              : entry,
          ),
        );
        if (payload.ok) setGapsRemaining(payload.gapsRemaining);
        return payload;
      };

      try {
        const res = await fetch('/api/voice/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fieldKey,
            value,
            source,
            // Omitted for the typed path with the mic never touched; the server mints
            // a typed:<uuid> so the turns still group.
            conversationId: conversationId.current || undefined,
            spokenText,
            // turn_index is deliberately NOT sent. The browser's transcript includes
            // agent speech that is not persisted, so its indices would leave holes
            // and could collide; the server takes max(turn_index)+1 for the
            // conversation instead, which costs one cheap query and cannot be wrong.
          }),
        });
        return settle((await res.json()) as VoiceAnswerResponse);
      } catch (error) {
        return settle({
          ok: false,
          action: `That did not save — ${(error as Error).message}. Nothing was changed.`,
          actionKind: 'profile_updated',
          fieldKey,
          storedValue: '',
          confidence: 0,
          gapsRemaining: -1,
          error: (error as Error).message,
        });
      }
    },
    [push],
  );

  const onTypedAnswer = useCallback(
    async (fieldKey: string, value: string) => {
      setBusy(true);
      // Logged as the user's turn exactly as typed, the same way an utterance is.
      push({ id: newId(), role: 'user', text: value, at: Date.now() });
      lastUserText.current = value;
      try {
        await submitAnswer(fieldKey, value, 'form', value);
      } finally {
        setBusy(false);
      }
    },
    [push, submitAnswer],
  );

  /* ----------------------------------------------------------- the agent */

  const clientTools = useMemo(
    () => ({
      record_answer: async (parameters: Record<string, unknown>): Promise<string> => {
        const fieldKey = String(parameters.field_key ?? parameters.fieldKey ?? '').trim();
        const value = String(parameters.value ?? '').trim();
        if (!fieldKey || !value) {
          return 'I need both a field_key and a value to record an answer. Nothing was saved.';
        }

        const request = submitAnswer(fieldKey, value, 'voice', lastUserText.current || undefined);
        // Race, do not block: see the note at the top of this file.
        const settled = await Promise.race([request, wait(OPTIMISTIC_MS)]);
        return settled
          ? settled.action
          : `Saving ${fieldKey} now — it will show in the transcript in a moment. Go on to the next question.`;
      },
    }),
    [submitAnswer],
  );

  const conversation = useConversation({
    clientTools,
    onConnect: ({ conversationId: id }) => {
      conversationId.current = id;
      setNote(null);
    },
    onDisconnect: () => {
      setNote('The conversation ended. Everything already recorded is saved; you can type the rest.');
    },
    onMessage: ({ message, source }) => {
      if (source === 'ai') {
        push({ id: newId(), role: 'agent', text: message, at: Date.now() });
      } else {
        lastUserText.current = message;
        push({ id: newId(), role: 'user', text: message, at: Date.now() });
      }
    },
    onError: (message) => {
      setNote(`Voice problem: ${message}. The typed input below still works.`);
    },
  });

  const status = conversation.status as VoiceStatus;

  /**
   * The visual state, in the vocabulary VoiceOrb (PR #14) already speaks.
   *
   * Computed here rather than inside the widget because only this component knows
   * that a pending write is "thinking" rather than "listening". After the merge this
   * is the single value to hand to `<VoiceOrb state={...} />` — see the note in
   * VoiceWidget.tsx. Nothing here calls getUserMedia: the SDK owns the one microphone
   * stream this page is allowed to have.
   */
  const visualState: VoiceVisualState =
    status === 'error'
      ? 'refusing'
      : status === 'connecting' || busy
        ? 'thinking'
        : status !== 'connected'
          ? 'idle'
          : conversation.isSpeaking
            ? 'speaking'
            : 'listening';

  /**
   * End the session on unmount and when the tab is hidden.
   *
   * Through a ref rather than by putting `conversation` in the dependency array: the
   * hook's return value is a new object every render, so a dependency on it would
   * tear down and rebuild the listener constantly — and, worse, an unmount cleanup
   * that depended on it would end the live session on every re-render.
   */
  const endSessionRef = useRef<() => void>(() => {});
  useEffect(() => {
    endSessionRef.current = conversation.endSession;
  });

  useEffect(() => () => endSessionRef.current(), []);

  useEffect(() => {
    const onVisibility = () => {
      // Cost and privacy. A backgrounded tab with an open microphone is billing
      // conversation-minutes for audio nobody is listening to.
      if (document.visibilityState === 'hidden') endSessionRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    setNote('Getting a fresh session. Your browser will ask for the microphone next — nothing is recorded until you allow it.');
    try {
      // Re-fetched rather than reused: the signature on a signed URL expires in
      // minutes, and the one from page load is very likely stale by the time
      // somebody clicks.
      const fresh = await loadSession();
      if (!fresh) return;
      if (!fresh.signedUrl) {
        setNote(fresh.unavailableReason ?? 'The microphone is unavailable. Type your answers instead.');
        return;
      }
      conversation.startSession({
        signedUrl: fresh.signedUrl,
        connectionType: 'websocket',
        dynamicVariables: fresh.dynamicVariables,
        clientTools,
      });
    } finally {
      setBusy(false);
    }
  }, [clientTools, conversation, loadSession]);

  const disconnect = useCallback(() => {
    conversation.endSession();
  }, [conversation]);

  const toggleMute = useCallback(() => {
    conversation.setMuted(!conversation.isMuted);
  }, [conversation]);

  return (
    <>
      <TranscriptPanel
        entries={entries}
        options={options}
        open={open}
        onToggle={toggleTranscript}
        onTypedAnswer={onTypedAnswer}
        busy={busy}
        note={note}
      />
      <VoiceWidget
        status={status}
        isSpeaking={conversation.isSpeaking}
        isMuted={conversation.isMuted}
        gapsRemaining={gapsRemaining}
        unavailableReason={unavailable}
        busy={busy}
        onConnect={() => void connect()}
        onDisconnect={disconnect}
        onToggleMute={toggleMute}
        visualState={visualState}
        /* The seam, closed. PR #14's VoiceOrb was replaced on that branch by
           AgentFace — the same five states, so visualState still hands straight
           over with no translation layer. <VoiceConsole /> is out of
           applicant/page.tsx, so the SDK owns the only microphone on the page. */
        visual={<AgentFaceLive mood={visualState} size={120} />}
      />
    </>
  );
}
