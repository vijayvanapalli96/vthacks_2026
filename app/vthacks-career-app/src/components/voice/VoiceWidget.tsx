'use client';

/**
 * The floating voice control.
 *
 * DRAGGABLE WITH A MOUSE **AND** WITH THE ARROW KEYS. See useDraggable: the handle is
 * a real <button> in the normal tab order, and both input methods drive the same
 * position state. A mouse-only drag would put a control on screen that a keyboard
 * user cannot move out of their own way, which is precisely what hard rule 6 exists
 * to stop.
 *
 * FOCUS IS NOT TRAPPED. This is four buttons in document order inside a fixed
 * container — no focus loop, no inert background, no dialog semantics. It is
 * `role="group"`, not `role="dialog"`, because it does not take over the page; you can
 * tab straight past it and carry on.
 *
 * THE MICROPHONE NEVER OPENS BY ITSELF. There is no auto-connect, no "connect on
 * mount", and no autoFocus (the lint config bans it outright). Connecting is a click
 * or an Enter press on a button labelled with what it is about to do. That is a
 * privacy property first and a billing one second: ElevenLabs charges per
 * conversation-minute, so an accidentally open mic costs money as well as trust.
 *
 * The pulse honours prefers-reduced-motion in voice.css, and the speaking state is
 * carried in TEXT as well as animation.
 */
import { Loader2, Mic, MicOff, Move, PhoneOff, RotateCcw } from 'lucide-react';

import { useDraggable } from './useDraggable';

export type VoiceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const STATUS_TEXT: Record<VoiceStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Listening',
  error: 'Connection problem',
};

/**
 * The visual state. Named to match the vocabulary PR #14's VoiceOrb spoke, so the
 * two could be joined without a translation layer — which is what happened at the
 * merge, except that branch had already replaced the orb with `AgentFace`, whose
 * moods are the same five names plus 'happy'.
 *
 * THE SEAM IS CLOSED. VoiceAgent.tsx passes
 * `visual={<AgentFace mood={visualState} size={120} />}`, and `VoiceConsole` — which
 * owned a second getUserMedia — no longer renders on /applicant, so the SDK holds
 * the only microphone stream the page is allowed.
 */
export type VoiceVisualState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'refusing';

export function VoiceWidget({
  status,
  isSpeaking,
  isMuted,
  gapsRemaining,
  unavailableReason,
  busy,
  onConnect,
  onDisconnect,
  onToggleMute,
  visualState,
  visual,
}: {
  status: VoiceStatus;
  isSpeaking: boolean;
  isMuted: boolean;
  gapsRemaining: number | null;
  unavailableReason: string | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleMute: () => void;
  visualState: VoiceVisualState;
  /** Optional visual indicator — HireWire's face. See VoiceVisualState. */
  visual?: React.ReactNode;
}) {
  // The hook lives here rather than in the parent so the DOM node it measures never
  // crosses a component boundary — see the note in useDraggable.ts about
  // react-hooks/refs.
  const { style, attach, onPointerDown, onKeyDown, announcement, isDragging, reset } = useDraggable();

  const connected = status === 'connected';
  const connecting = status === 'connecting' || busy;

  return (
    <>
      {/* Outside the widget so a re-render of the widget cannot reset the region and
          swallow the announcement. */}
      <p className="vt-sr-only" aria-live="polite">
        {announcement}
      </p>

      <div
        className={`vw ${connected ? 'is-live' : ''} ${isDragging ? 'is-dragging' : ''}`}
        style={style}
        ref={attach}
        role="group"
        aria-label="Voice control"
        // Same vocabulary as AgentFace's moods, so a CSS-only or test-only hook on
        // the state exists independently of what is passed as `visual`.
        data-voice-state={visualState}
      >
        <div className="vw-head">
          <button type="button" className="vw-grip" onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
            <Move size={14} aria-hidden="true" />
            <span className="vt-sr-only">
              Move the voice control. Use the arrow keys to move it, hold shift to move further, or
              drag it with the mouse.
            </span>
          </button>
          <span className="vw-status">
            <span
              className={`vw-dot ${connected ? 'is-live' : ''} ${visualState === 'speaking' ? 'is-speaking' : ''}`}
              aria-hidden="true"
            />
            {/* The status is text, so it survives a screen reader, a monochrome
                display, and prefers-reduced-motion killing the pulse. */}
            {STATUS_TEXT[status]}
            {connected ? (isSpeaking ? ' · agent speaking' : isMuted ? ' · muted' : ' · your turn') : ''}
          </span>
          <button type="button" className="vw-reset" onClick={reset}>
            <RotateCcw size={13} aria-hidden="true" />
            <span className="vt-sr-only">Move the voice control back to its default corner</span>
          </button>
        </div>

        {visual ? <div className="vw-visual">{visual}</div> : null}

        <p className="vw-blurb">
          {gapsRemaining === null
            ? 'Loading your question queue…'
            : gapsRemaining === 0
              ? 'Nothing outstanding. Your profile has everything it asked for.'
              : `${gapsRemaining} question${gapsRemaining === 1 ? '' : 's'} left. Speak, or type in the transcript.`}
        </p>

        <div className="vw-buttons">
          {connected ? (
            <>
              <button type="button" className="vw-btn vw-mute" onClick={onToggleMute} aria-pressed={isMuted}>
                {isMuted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button type="button" className="vw-btn vw-stop" onClick={onDisconnect}>
                <PhoneOff size={16} aria-hidden="true" />
                End
              </button>
            </>
          ) : (
            <button
              type="button"
              className="vw-btn vw-start"
              onClick={onConnect}
              disabled={connecting || Boolean(unavailableReason)}
            >
              {connecting ? <Loader2 size={16} aria-hidden="true" className="vw-spin" /> : <Mic size={16} aria-hidden="true" />}
              {connecting ? 'Connecting…' : 'Start talking'}
            </button>
          )}
        </div>

        {unavailableReason ? (
          /* Said out loud rather than hidden behind a disabled button with no
             explanation. A control that cannot work should say why. */
          <p className="vw-reason" role="status">
            {unavailableReason}
          </p>
        ) : null}
      </div>
    </>
  );
}
