'use client';

/**
 * VoiceAgent — the orchestration. It used to own a transcript of things SAID. It now
 * owns a log of things DONE.
 *
 * WHAT CHANGED AND WHY IT MATTERS. The agent had one tool, `record_answer`, and no
 * idea where you were. It now knows what page you are on, reads your last match run,
 * explains a score using the reason stored at match time, walks you to a page, and
 * moves a role's stage. Each of those is an HTTP endpoint that a BUTTON in
 * TranscriptPanel also calls — hard rule 5, "everything you can say, you can type",
 * satisfied at the API layer rather than approximated by two similar code paths.
 *
 * THERE IS NO APPLY TOOL, AND THAT IS A FEATURE. Hard rule 3 puts ANS resolution, a
 * certificate check, a Trust Index, a policy gate and a HUMAN CONFIRMATION between the
 * agent and any field leaving. So the agent may navigate you to
 * /applicant/apply?job=… and it stops there. Enforced twice: the tool does not exist
 * in `clientTools` below, and the prompt says plainly that it cannot apply. "It walked
 * me to the page and then refused to take the last step without me" is the pitch; an
 * agent that says "applying now" while PII leaves on a spoken word is the one bug that
 * makes the whole pitch a lie.
 *
 * THE MICROPHONE NEVER OPENS BY ITSELF. Proactivity means: if a conversation is
 * ALREADY open, the agent volunteers; if it is not, TranscriptPanel shows the same
 * words as text with a button. There is no auto-connect anywhere in this file.
 * ElevenLabs bills per conversation-minute on a free-tier account, and grabbing a
 * microphone unasked is a consent problem before it is a billing one.
 *
 * WHY `useConversation` AND NOT THE `<elevenlabs-convai>` WIDGET. The drop-in widget
 * renders its own bubble, keeps its own transcript, and gives us no hook to show what
 * a turn DID to the user's data. The transcript, the action lines and the typed
 * fallback ARE the feature; the widget would have hidden all three behind an iframe.
 *
 * WHY CLIENT TOOLS AND NOT SERVER WEBHOOKS. An ElevenLabs server tool calls an HTTPS
 * URL directly, so it needs a public one — `localhost:3004` has none, and tunnelling is
 * a demo dependency waiting to break on stage. A client tool runs in this browser, so
 * every `fetch` carries the session cookie and every action is attributed by the same
 * `requireRole()` guard as the rest of the app, rather than by a user id the model was
 * told to pass along and could be talked into changing.
 *
 * WHY WRITES ARE RACED AGAINST A TIMER. Each action is one or more Databricks
 * statements against a warehouse that cold-starts in 20-30 seconds, and a match
 * refresh is up to a minute of real work. Blocking the agent's next sentence on that
 * makes the conversation feel broken, so a tool returns an honest "doing it now" once
 * OPTIMISTIC_MS has passed and the transcript line settles to done or failed when the
 * work actually lands. The user sees the truth either way; they just do not sit in
 * silence waiting for it.
 *
 * ALL MUTABLE READS GO THROUGH ONE REF. `useConversation()` returns a fresh object
 * every render, so a client tool that closed over it would either be rebuilt
 * constantly or capture a stale sender. `live` is updated in an effect and read only
 * inside callbacks — never during render, which is what `react-hooks/refs` (an ERROR
 * in this repo) exists to enforce.
 */
import { ConversationProvider, useConversation } from '@elevenlabs/react';
import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { AgentFaceLive } from '@/components/AgentFaceLive';
import { explainMatch, resolveJobRef } from '@/lib/voice-brief';
import {
  isVoiceJobStatus,
  VOICE_JOB_STATUSES,
  type MatchBrief,
  type PageBrief,
  type TranscriptEntry,
  type VoiceActionKind,
  type VoiceAnswerResponse,
  type VoiceJobStatus,
  type VoiceNavTarget,
  type VoicePageContextResponse,
  type VoiceResolveResponse,
  type VoiceSessionPayload,
  type VoiceStatusResponse,
} from '@/lib/voice-contract';

import { claimMount, claimSnapshot, serverClaimSnapshot, subscribeClaim } from './mount-claim';
import { TranscriptPanel, type ProactivePrompt, type TypedOption } from './TranscriptPanel';
import { VoiceWidget, type VoiceStatus, type VoiceVisualState } from './VoiceWidget';
import './voice.css';

/** How long a client tool waits for the write before answering optimistically. */
const OPTIMISTIC_MS = 3_500;

/** A match refresh is real work. The agent should not sit silent for a minute. */
const REFRESH_OPTIMISTIC_MS = 6_000;

const TRANSCRIPT_KEY = 'hirewire.voice.transcript-open';
/** The last match run we have already told the user about. See announceRun(). */
const ANNOUNCED_RUN_KEY = 'hirewire.voice.announced-run';

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/* ------------------------------------------------- the persisted open/closed bit */

/**
 * Whether the transcript is expanded, as an external store rather than component
 * state.
 *
 * localStorage cannot be read during render — the server and the client would produce
 * different HTML and React 19 discards the tree — and it cannot be read in an effect
 * that calls setState without triggering the cascading re-render
 * `react-hooks/set-state-in-effect` exists to prevent. useSyncExternalStore is the
 * mechanism built for exactly this: `serverSnapshot` is what SSR renders, `snapshot`
 * is what the browser reads, and React reconciles the two after hydration without
 * calling it a mismatch.
 *
 * The 'storage' subscription is a small bonus: two tabs stay in agreement about
 * whether the panel is showing.
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
    // Default OPEN. A transcript nobody can find does not satisfy "you can always read
    // exactly what was said and done".
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

function readAnnouncedRun(): string | null {
  try {
    return window.localStorage.getItem(ANNOUNCED_RUN_KEY);
  } catch {
    return null;
  }
}

function writeAnnouncedRun(runId: string): void {
  try {
    window.localStorage.setItem(ANNOUNCED_RUN_KEY, runId);
  } catch {
    // Worst case the user is told about the same run twice in one session.
  }
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

/* ------------------------------------------------------------------ the entry point */

/**
 * `rank` decides which instance wins when the component is rendered twice.
 *
 * The dock is mounted in `app/applicant/layout.tsx` at rank 1 so that it SURVIVES
 * NAVIGATION — "take me to the Stripe one" pushes a route, and an unmounted component
 * ends the conversation mid-sentence and bills for the reconnect.
 * `app/applicant/page.tsx` still renders a bare `<VoiceAgent />` (rank 0) and belongs
 * to another lane this hour, so rather than edit their file the layout's instance takes
 * the slot and theirs renders nothing. See mount-claim.ts for why rank beats mount
 * order.
 */
export function VoiceAgent({ rank = 0 }: { rank?: number }) {
  const [token] = useState(newId);
  const holder = useSyncExternalStore(subscribeClaim, claimSnapshot, serverClaimSnapshot);

  useEffect(() => claimMount(token, rank), [token, rank]);

  /**
   * RANK DECIDES WHO RENDERS OPTIMISTICALLY, AND THAT IS ABOUT SERVER RENDERING.
   *
   * Nobody holds the slot during SSR — there is no microphone to arbitrate over — so if
   * both instances rendered whenever the slot was free, `/applicant` would ship HTML
   * containing TWO docks and collapse to one a tick after hydration. A visible
   * double-panel flash on the main dashboard, measured: two `vt-dock` elements in the
   * server response.
   *
   * So a ranked instance (the layout's, rank 1) renders while the slot is free, and an
   * unranked one (a bare `<VoiceAgent />`, rank 0) renders only once it actually HOLDS
   * the slot. On a page where the layout also mounts one, rank 0 therefore never paints.
   * On a page where it is the only mount, it paints one tick late and nothing flashes.
   *
   * Every hook above runs unconditionally, so this early return is safe.
   */
  const active = rank > 0 ? holder === null || holder === token : holder === token;
  if (!active) return null;

  // The provider owns the conversation singleton; the shell owns our state. Split
  // because useConversation must be called inside the provider.
  return (
    <ConversationProvider>
      <VoiceAgentShell />
    </ConversationProvider>
  );
}

/* ---------------------------------------------------------------------- the shell */

type Live = {
  status: VoiceStatus;
  sendContextualUpdate: (text: string) => void;
  endSession: () => void;
  conversationId: string;
  /** The last utterance, so a persisted turn is the user's own words. */
  lastUserText: string;
  context: PageBrief | null;
  path: string;
  announcedRunId: string | null;
  refreshing: boolean;
};

function VoiceAgentShell() {
  const pathname = usePathname();
  const router = useRouter();

  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [options, setOptions] = useState<TypedOption[]>([]);
  const [gapsRemaining, setGapsRemaining] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The SPEAKER, not the microphone — the nose is drawn as a speaker cone and
   * that is what it should do. It is plain local state because output volume is
   * a playback preference, not an operation on a live session: you can silence
   * the agent before it has said anything, and useConversation applies `volume`
   * whenever a session does start. conversation.setMuted, by contrast, is
   * setMicMuted underneath and only means something while connected — that one
   * stays on the hidden keyboard control.
   */
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pageContext, setPageContext] = useState<PageBrief | null>(null);
  const [proactiveText, setProactiveText] = useState<string | null>(null);

  const open = useSyncExternalStore(subscribeTranscript, transcriptSnapshot, transcriptServerSnapshot);

  /**
   * Every mutable thing a callback needs, in one ref, written only from effects and
   * async handlers. Nothing here is read during render.
   */
  const live = useRef<Live>({
    status: 'disconnected',
    sendContextualUpdate: () => {},
    endSession: () => {},
    conversationId: '',
    lastUserText: '',
    context: null,
    path: '/',
    announcedRunId: null,
    refreshing: false,
  });

  const loadedOnce = useRef(false);

  const push = useCallback((entry: TranscriptEntry) => {
    setEntries((previous) => [...previous, entry]);
  }, []);

  /** A settled action line. Hard rule 4: `text` IS the reason; there is no other slot. */
  const pushAction = useCallback(
    (kind: VoiceActionKind, state: 'pending' | 'done' | 'failed', text: string, jobId?: string) => {
      const id = newId();
      push({ id, role: 'action', kind, state, text, jobId, at: Date.now() });
      return id;
    },
    [push],
  );

  const settleAction = useCallback(
    (id: string, state: 'done' | 'failed', text: string) => {
      setEntries((previous) =>
        previous.map((entry) =>
          entry.id === id && entry.role === 'action' ? { ...entry, state, text } : entry,
        ),
      );
    },
    [],
  );

  /**
   * The audit row. `voice_events` has been empty since the schema was written; this is
   * its producer for the actions whose work happens in a route that cannot log them
   * itself (a match refresh, a read-out, an explanation). Never awaited by anything
   * the user is waiting on, and never fatal — losing a log line must not turn a
   * completed action into a reported failure.
   */
  const logEvent = useCallback(
    (kind: VoiceActionKind, text: string, extra: Record<string, unknown> = {}) => {
      void fetch('/api/voice/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          text,
          conversationId: live.current.conversationId || undefined,
          ...extra,
        }),
      }).catch(() => {});
    },
    [],
  );

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
      // The face only says "voice is off"; the why belongs next to the typed
      // input that replaces it.
      if (payload.unavailableReason) setNote(payload.unavailableReason);
      return payload;
    } catch (error) {
      setUnavailable(`The voice session could not be prepared — ${(error as Error).message}. You can still type your answers.`);
      return null;
    }
  }, []);

  /* ------------------------------------------------------- page awareness */

  /**
   * "Those are in. The strongest three are… want me to open one?"
   *
   * TWO PATHS, AND THE SECOND ONE IS THE IMPORTANT ONE:
   *
   *  - A conversation is already open → a contextual update, and the prompt tells the
   *    agent to volunteer it.
   *  - No conversation is open → THE SAME WORDS AS TEXT, in the panel, with a button.
   *    The app does not open a microphone to tell you something. That is a consent
   *    property, and it is also a bill: ElevenLabs charges per conversation-minute.
   *
   * Speak three, show ten: `spoken_summary` names three, the panel lists all ten with
   * their scores and their reasons.
   *
   * Declared BEFORE loadContext because loadContext calls it — a `const` arrow
   * function referenced before its initialiser is a TDZ crash at the moment the fetch
   * resolves, which is the worst possible place to find it.
   */
  const announceRun = useCallback((context: PageBrief) => {
    const summary = context.spoken_summary;
    if (!summary) return;
    const words = `${summary} Want me to open one of them, or tell you why one scored the way it did?`;

    if (live.current.status === 'connected') {
      live.current.sendContextualUpdate(
        `A NEW MATCH RUN JUST LANDED. Volunteer this to the student now, in your own words, and then stop and wait: ${words}`,
      );
      return;
    }
    setProactiveText(words);
  }, []);

  /**
   * Ask the SERVER what this page is, then tell the agent.
   *
   * The browser knows the pathname. It does not know what the pathname MEANS, and a
   * client that decided ("the word jobs is in it, so…") would be a second model of the
   * app that drifts the first time a route is renamed. So the path goes out and prose
   * comes back — see PAGES in voice-brief.ts — and that prose is what
   * `sendContextualUpdate` forwards, so a long conversation stays oriented across
   * every navigation instead of only knowing where you were when it started.
   *
   * Returns the brief so callers can act on the fresh matches it carries.
   */
  const loadContext = useCallback(async (path: string): Promise<PageBrief | null> => {
    try {
      const res = await fetch(`/api/voice/context?path=${encodeURIComponent(path)}`, {
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as VoicePageContextResponse;
      const context = payload.context;

      setPageContext(context);
      live.current.context = context;
      live.current.path = path;

      if (live.current.status === 'connected') {
        live.current.sendContextualUpdate(context.brief);
      }

      // Proactivity. A run the user has already been told about stays quiet; a new one
      // is volunteered. Without this the agent would re-announce the same matches on
      // every page load until you closed the tab.
      const runId = payload.run?.run_id ?? null;
      if (runId && runId !== live.current.announcedRunId && context.matches.length > 0) {
        live.current.announcedRunId = runId;
        writeAnnouncedRun(runId);
        announceRun(context);
      }

      return context;
    } catch {
      // No brief is a recoverable state: the agent simply does not describe the page.
      return null;
    }
  }, [announceRun]);

  // Once, on mount. This mints a signed URL but does NOT start a conversation, so it
  // costs no ElevenLabs minutes — and it warms the Databricks write path so the first
  // answer is not the one that pays the cold start. React 19 runs effects twice in
  // development; the ref is what stops two sessions being prepared.
  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    live.current.announcedRunId = readAnnouncedRun();
    void loadSession();
  }, [loadSession]);

  // On mount AND on every navigation. This is the whole of page awareness: after
  // `open_page` pushes a route, the agent is told what it just opened.
  useEffect(() => {
    void loadContext(pathname);
  }, [pathname, loadContext]);

  const toggleTranscript = useCallback(() => {
    persistTranscriptOpen(!transcriptSnapshot());
  }, []);

  const dismissProactive = useCallback(() => setProactiveText(null), []);

  /* -------------------------------------------------- record an answer (unchanged) */

  /**
   * The one function both the spoken tool and the typed form call for an ANSWER. It
   * never rejects: a failure is a `failed` transcript line and an ok:false payload,
   * because the agent has to be able to say out loud that the answer did not save.
   */
  const submitAnswer = useCallback(
    async (
      fieldKey: string,
      value: string,
      source: 'voice' | 'form',
      spokenText?: string,
    ): Promise<VoiceAnswerResponse> => {
      const localId = pushAction('profile_updated', 'pending', `Recording ${fieldKey}: ${value}`, undefined);

      const settle = (payload: VoiceAnswerResponse) => {
        settleAction(localId, payload.ok ? 'done' : 'failed', payload.action);
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
            // Omitted for the typed path with the mic never touched; the server mints a
            // typed:<uuid> so the turns still group.
            conversationId: live.current.conversationId || undefined,
            spokenText,
            // turn_index is deliberately NOT sent. The browser's transcript includes
            // agent speech that is not persisted, so its indices would leave holes and
            // could collide; the server takes max(turn_index)+1 instead.
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
    [pushAction, settleAction],
  );

  const onTypedAnswer = useCallback(
    async (fieldKey: string, value: string) => {
      setBusy(true);
      // Logged as the user's turn exactly as typed, the same way an utterance is.
      push({ id: newId(), role: 'user', text: value, at: Date.now() });
      live.current.lastUserText = value;
      try {
        await submitAnswer(fieldKey, value, 'form', value);
      } finally {
        setBusy(false);
      }
    },
    [push, submitAnswer],
  );

  /* ----------------------------------------------------------- the new actions */

  /**
   * Reload the matches. DEBOUNCED TO ONE IN FLIGHT, because this is the expensive one:
   * `POST /api/match { refresh: true }` is a profile embedding, a full cosine scan and
   * up to twenty model calls. An agent that fires it twice because the user said
   * "reload" and then "yes" has doubled the bill for an identical answer.
   *
   * Same endpoint as the "Reload matches" button in the panel — one handler, one
   * debounce, no voice-only path.
   */
  const refreshMatches = useCallback(async (): Promise<string> => {
    if (live.current.refreshing) {
      return 'A match run is already going. I will read the results out as soon as it finishes — nothing is lost by waiting.';
    }
    live.current.refreshing = true;
    setRefreshing(true);
    setProactiveText(null);

    const id = pushAction(
      'job_matched',
      'pending',
      'Reloading your matches — scoring fresh postings against your skills and coursework.',
    );

    try {
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh: true }),
      });
      const payload = (await res.json()) as { matches?: unknown[]; error?: string };

      if (!res.ok) {
        const text = `The match run failed — ${payload.error ?? res.status}. Your previous matches are untouched.`;
        settleAction(id, 'failed', text);
        logEvent('job_matched', text, { outcome: 'failed' });
        return text;
      }

      const count = Array.isArray(payload.matches) ? payload.matches.length : 0;
      // Re-read the brief so the panel, the agent and the audit row all describe the
      // same run. loadContext announces it if it is new.
      const context = await loadContext(live.current.path);
      const text =
        count === 0
          ? 'The match run finished and found nothing this time. That is a real answer about the roles currently in the index, not an error.'
          : `Reloaded your matches — ${count} roles scored. ${context?.spoken_summary ?? ''}`.trim();

      settleAction(id, 'done', text);
      logEvent('job_matched', text, { outcome: 'ok', detail: { count } });
      return text;
    } catch (error) {
      const text = `I could not reach the match service — ${(error as Error).message}. Your previous matches are untouched.`;
      settleAction(id, 'failed', text);
      return text;
    } finally {
      live.current.refreshing = false;
      setRefreshing(false);
    }
  }, [loadContext, logEvent, pushAction, settleAction]);

  /**
   * Read the cached list back. ZERO model calls and zero warehouse writes — the run
   * has already been paid for, and the reason sentence on each row was written then.
   */
  const listMatches = useCallback(async (): Promise<string> => {
    const context = (await loadContext(live.current.path)) ?? live.current.context;
    if (!context || context.matches.length === 0) {
      const text =
        'You have no current match run, so I have nothing to read out. I will not make roles up. Say "reload my matches" and I will run it — it takes about a minute.';
      logEvent('refused', text, { outcome: 'refused' });
      return text;
    }
    const spoken = context.spoken_summary ?? '';
    const text = `Read out your top matches — ${context.matches.length} on screen, strongest first.`;
    pushAction('job_matched', 'done', `${text} ${spoken}`.trim());
    logEvent('job_matched', text, { outcome: 'ok' });
    // Speak three, show ten: the agent gets the three-role sentence, the panel has all
    // ten with their scores and reasons.
    return `${spoken} All ${context.matches.length} are listed on screen with their scores. Do not read the rest out unless asked.`;
  }, [loadContext, logEvent, pushAction]);

  /**
   * Why this role. NO MODEL CALL: `explainMatch()` arranges the explanation the match
   * agent already wrote and stored on the row, so the spoken answer and the match list
   * cannot contradict each other — they are the same string.
   *
   * Resolution is client-side here, and only here, because this action READS data the
   * browser already has. There is no trust boundary to cross: the client cannot invent
   * a reason sentence it was not given. Anything that NAVIGATES or WRITES resolves
   * server-side instead — see openJob and setJobStatus.
   */
  const explainJob = useCallback(
    async (jobRef: string): Promise<string> => {
      const context = live.current.context ?? (await loadContext(live.current.path));
      const resolution = resolveJobRef(context?.matches ?? [], jobRef);
      if (!resolution.ok) {
        pushAction('refused', 'done', resolution.reason);
        logEvent('refused', resolution.reason, { outcome: 'refused' });
        return resolution.reason;
      }
      const text = explainMatch(resolution.match);
      pushAction('job_matched', 'done', text, resolution.match.job_id);
      logEvent('job_matched', text, { outcome: 'ok', jobId: resolution.match.job_id });
      return text;
    },
    [loadContext, logEvent, pushAction],
  );

  /**
   * Take me to it — with the guess taken out.
   *
   * The id is NOT trusted. It goes to `POST /api/voice/resolve`, which matches it
   * against this user's own cached run and refuses when it does not resolve. A refusal
   * renders as a `refused` action line with the spoken reason and navigates nowhere; a
   * plausible-but-wrong job is the failure that is invisible until somebody approves an
   * application on the wrong page.
   */
  const openJob = useCallback(
    async (jobRef: string, target: VoiceNavTarget): Promise<string> => {
      try {
        const res = await fetch('/api/voice/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobRef,
            target,
            conversationId: live.current.conversationId || undefined,
          }),
        });
        const payload = (await res.json()) as VoiceResolveResponse;

        if (!payload.ok) {
          pushAction('refused', 'done', payload.reason);
          return payload.reason;
        }

        pushAction('navigated', 'done', payload.reason, payload.match?.job_id);
        setProactiveText(null);
        // The pathname effect fires next and sends the new page's brief, so the agent
        // finds out what it just opened without being told twice.
        router.push(payload.href);
        return payload.reason;
      } catch (error) {
        const text = `I could not work out which job you meant — ${(error as Error).message}. Nothing was opened.`;
        pushAction('refused', 'done', text);
        return text;
      }
    },
    [pushAction, router],
  );

  /**
   * Save it, or move its stage.
   *
   * Posts to `/api/voice/status`, which resolves the reference, forwards to the
   * pipeline lane's `POST /api/pipeline/status`, and logs. This lane owns no status
   * table: "saved" is the first stage of that pipeline, not a separate concept, and a
   * second store for the same fact would disagree with the first one eventually.
   *
   * `applied` records WHAT THE USER SAYS HAPPENED. The agent never applies.
   */
  const setJobStatus = useCallback(
    async (jobRef: string, status: VoiceJobStatus, noteText?: string): Promise<string> => {
      try {
        const res = await fetch('/api/voice/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jobRef,
            status,
            note: noteText,
            conversationId: live.current.conversationId || undefined,
          }),
        });
        const payload = (await res.json()) as VoiceStatusResponse;
        pushAction(
          payload.ok ? 'job_status_set' : 'refused',
          payload.ok ? 'done' : 'failed',
          payload.reason,
          payload.ok ? payload.jobId : undefined,
        );
        return payload.reason;
      } catch (error) {
        const text = `That stage change did not go through — ${(error as Error).message}. Nothing was recorded.`;
        pushAction('refused', 'failed', text);
        return text;
      }
    },
    [pushAction],
  );

  /* ----------------------------------------------------------- the agent's tools */

  /**
   * THE TOOL TABLE. Every entry has a button in TranscriptPanel that calls the same
   * handler, and therefore the same endpoint.
   *
   * WHAT IS NOT IN HERE: `apply`. Not an oversight, not a TODO — hard rule 3. The
   * agent can walk you to `/applicant/apply?job=…` via `open_page` and it stops. The
   * prompt in scripts/provision-voice-agent.mjs says so in as many words, so the model
   * is not left to discover the limit by having a tool call fail.
   */
  const clientTools = useMemo(
    () => ({
      record_answer: async (parameters: Record<string, unknown>): Promise<string> => {
        const fieldKey = String(parameters.field_key ?? parameters.fieldKey ?? '').trim();
        const value = String(parameters.value ?? '').trim();
        if (!fieldKey || !value) {
          return 'I need both a field_key and a value to record an answer. Nothing was saved.';
        }
        const request = submitAnswer(fieldKey, value, 'voice', live.current.lastUserText || undefined);
        // Race, do not block: see the note at the top of this file.
        const settled = await Promise.race([request, wait(OPTIMISTIC_MS)]);
        return settled
          ? settled.action
          : `Saving ${fieldKey} now — it will show in the transcript in a moment. Go on to the next question.`;
      },

      /** Where am I. Pull, for when the agent has lost the thread; push is the default. */
      get_page_context: async (): Promise<string> => {
        const context = (await loadContext(live.current.path)) ?? live.current.context;
        return context?.brief ?? 'I cannot tell what page the student is on right now. Ask them.';
      },

      list_matches: async (): Promise<string> => listMatches(),

      explain_match: async (parameters: Record<string, unknown>): Promise<string> =>
        explainJob(String(parameters.job_ref ?? parameters.job_id ?? '').trim()),

      refresh_matches: async (): Promise<string> => {
        const request = refreshMatches();
        const settled = await Promise.race([request, wait(REFRESH_OPTIMISTIC_MS)]);
        return (
          settled ??
          'The match run is going now. It takes up to a minute because it scores each role against their coursework. Tell them it is running, then wait — I will hand you the results.'
        );
      },

      open_page: async (parameters: Record<string, unknown>): Promise<string> => {
        const rawTarget = String(parameters.target ?? 'job').trim();
        const jobRef = String(parameters.job_ref ?? parameters.job_id ?? '').trim();
        // Not validated here: the server validates the target against a closed set and
        // the job against the user's own run. A client-side check would only decide
        // WHICH refusal sentence gets said, and the server's is the honest one.
        return openJob(jobRef, rawTarget as VoiceNavTarget);
      },

      set_job_status: async (parameters: Record<string, unknown>): Promise<string> => {
        const jobRef = String(parameters.job_ref ?? parameters.job_id ?? '').trim();
        const rawStatus = String(parameters.status ?? 'saved').trim().toLowerCase();
        if (!isVoiceJobStatus(rawStatus)) {
          return `I can only set one of: ${VOICE_JOB_STATUSES.join(', ')}. Nothing was changed.`;
        }
        const noteText = typeof parameters.note === 'string' ? parameters.note : undefined;
        const request = setJobStatus(jobRef, rawStatus, noteText);
        const settled = await Promise.race([request, wait(OPTIMISTIC_MS)]);
        return settled ?? 'Recording that now — it will show in the transcript in a moment.';
      },
    }),
    [explainJob, listMatches, loadContext, openJob, refreshMatches, setJobStatus, submitAnswer],
  );

  const conversation = useConversation({
    volume: speakerMuted ? 0 : 1,
    clientTools,
    onConnect: ({ conversationId: id }) => {
      live.current.conversationId = id;
      setNote(null);
    },
    onDisconnect: () => {
      setNote('The conversation ended. Everything already recorded is saved; you can type or click the rest.');
    },
    onMessage: ({ message, source }) => {
      if (source === 'ai') {
        push({ id: newId(), role: 'agent', text: message, at: Date.now() });
      } else {
        live.current.lastUserText = message;
        push({ id: newId(), role: 'user', text: message, at: Date.now() });
      }
    },
    onError: (message) => {
      setNote(`Voice problem: ${message}. Everything below still works by typing and clicking.`);
    },
  });

  const status = conversation.status as VoiceStatus;

  /**
   * The visual state, in the vocabulary AgentFace already speaks.
   *
   * Computed here rather than inside the widget because only this component knows that
   * a pending write is "thinking" rather than "listening". Nothing here calls
   * getUserMedia: the SDK owns the one microphone stream this page is allowed to have.
   */
  const visualState: VoiceVisualState =
    status === 'error'
      ? 'refusing'
      : status === 'connecting' || busy || refreshing
        ? 'thinking'
        : status !== 'connected'
          ? 'idle'
          : conversation.isSpeaking
            ? 'speaking'
            : 'listening';

  /**
   * Keep the ref current.
   *
   * Through a ref rather than by putting `conversation` in a dependency array: the
   * hook's return value is a new object every render, so a dependency on it would tear
   * down and rebuild listeners constantly — and, worse, an unmount cleanup that
   * depended on it would end the live session on every re-render.
   */
  useEffect(() => {
    live.current.status = status;
    live.current.sendContextualUpdate = conversation.sendContextualUpdate;
    live.current.endSession = conversation.endSession;
  });

  useEffect(() => () => live.current.endSession(), []);

  useEffect(() => {
    const onVisibility = () => {
      // Cost and privacy. A backgrounded tab with an open microphone is billing
      // conversation-minutes for audio nobody is listening to.
      if (document.visibilityState === 'hidden') live.current.endSession();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    setNote('Getting a fresh session. Your browser will ask for the microphone next — nothing is recorded until you allow it.');
    try {
      // Re-fetched rather than reused: the signature on a signed URL expires in
      // minutes, and the one from page load is very likely stale by the time somebody
      // clicks.
      const fresh = await loadSession();
      if (!fresh) return;
      if (!fresh.signedUrl) {
        setNote(fresh.unavailableReason ?? 'The microphone is unavailable. Type or click instead.');
        return;
      }
      const context = live.current.context;
      conversation.startSession({
        signedUrl: fresh.signedUrl,
        connectionType: 'websocket',
        dynamicVariables: {
          ...fresh.dynamicVariables,
          // Page awareness from the FIRST word, not from the first navigation. Both of
          // these came from the server's allow-listed brief; neither can contain a
          // contact field. See voice-brief.ts.
          page_name: context?.page_name ?? 'a page I have not been told about yet',
          page_context: context?.brief ?? 'No page description is available yet.',
        },
        clientTools,
      });
    } finally {
      setBusy(false);
    }
  }, [clientTools, conversation, loadSession]);

  const disconnect = useCallback(() => {
    conversation.endSession();
  }, [conversation]);

  /**
   * Flips a flag and nothing else, deliberately.
   *
   * Calling conversation.setVolume() here threw "No active conversation. Call
   * startSession() first." on every click, because the react wrapper's
   * getConversation() throws rather than no-oping when there is no session —
   * and with voice unconfigured there never is one. It was also a side effect
   * inside a setState updater, which StrictMode double-invokes.
   *
   * None of it was needed: useConversation already watches the `volume` option
   * above in an effect guarded on the conversation existing, so the value is
   * applied when it changes AND when a session later starts.
   */
  const toggleSpeaker = useCallback(() => {
    setSpeakerMuted((wasMuted) => !wasMuted);
  }, []);

  const toggleMute = useCallback(() => {
    conversation.setMuted(!conversation.isMuted);
  }, [conversation]);

  /* --------------------------------------------------------------- the proactive card */

  const topMatch: MatchBrief | null = pageContext?.matches[0] ?? null;

  const proactive: ProactivePrompt | null = useMemo(() => {
    if (!proactiveText) return null;
    return {
      text: proactiveText,
      actionLabel: topMatch ? `Open ${topMatch.title} at ${topMatch.company}` : null,
      onAction: topMatch ? () => void openJob(topMatch.job_id, 'job') : null,
    };
  }, [proactiveText, topMatch, openJob]);

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
        pageName={pageContext?.page_name ?? null}
        matches={pageContext?.matches ?? []}
        matchesStale={pageContext?.stale ?? true}
        refreshing={refreshing}
        proactive={proactive}
        onDismissProactive={dismissProactive}
        onRefreshMatches={() => void refreshMatches()}
        onOpenJob={(jobId, target) => void openJob(jobId, target)}
        onExplainJob={(jobId) => void explainJob(jobId)}
        onSetJobStatus={(jobId, jobStatus) => void setJobStatus(jobId, jobStatus)}
      />
      <VoiceWidget
        status={status}
        isSpeaking={conversation.isSpeaking}
        isMuted={conversation.isMuted}
        speakerMuted={speakerMuted}
        gapsRemaining={gapsRemaining}
        unavailableReason={unavailable}
        busy={busy}
        onConnect={() => void connect()}
        onDisconnect={disconnect}
        onToggleMute={toggleMute}
        visualState={visualState}
        /* The seam PR #14 and #16 both described, closed — and the flat face
           swapped for the lit one, which speaks the same five states. */
        visual={
          <AgentFaceLive
            mood={visualState}
            size={120}
            muted={speakerMuted}
            nose
            onNose={toggleSpeaker}
          />
        }
      />
    </>
  );
}
