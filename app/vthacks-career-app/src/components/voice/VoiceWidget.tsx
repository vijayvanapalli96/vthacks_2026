'use client';

/**
 * The floating voice control: HireWire's face, and nothing else.
 *
 * ONE TARGET, TWO GESTURES. The face is the drag handle AND the start/stop
 * button. A press that travels more than DRAG_SLOP is a move and must not also
 * toggle the microphone — hence the distance check in `onClick`, rather than a
 * timer, which would misfire on a slow deliberate drag.
 *
 * DRAGGABLE WITH A MOUSE **AND** WITH THE ARROW KEYS. See useDraggable: the face
 * is a real <button> in the normal tab order, and both input methods drive the
 * same position state. A mouse-only drag would put a control on screen that a
 * keyboard user cannot move out of their own way, which is precisely what hard
 * rule 6 exists to stop. Home returns it to its corner, and that is in the
 * button's own instructions, because a shortcut nobody is told about is not a
 * feature.
 *
 * THERE IS NO MUTE. Not on the nose, not on a key, not on a hidden button. The
 * control has two states — talking or not — and the whole face is the switch
 * between them. The speaker-cone nose that used to mute output was also
 * swallowing start/stop clicks from the middle of the face; see the note where
 * VoiceAgent renders this.
 *
 * FOCUS IS NOT TRAPPED. It is one button. You tab to it, or straight past it.
 *
 * THE MICROPHONE NEVER OPENS BY ITSELF. No auto-connect, no connect-on-mount, no
 * autoFocus. Connecting is a click or an Enter press on a control whose caption
 * says what it is about to do. That is a privacy property first and a billing one
 * second: ElevenLabs charges per conversation-minute, so an accidentally open mic
 * costs money as well as trust.
 *
 * THE STATE IS ALWAYS IN TEXT under the face, so it survives a screen reader, a
 * monochrome display, and prefers-reduced-motion killing the animation.
 */
import { useRef } from 'react';

import { useDraggable } from './useDraggable';

export type VoiceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * The visual state. Named to match the vocabulary PR #14's VoiceOrb spoke, so the
 * two could be joined without a translation layer — which is what happened at the
 * merge, except that branch had already replaced the orb with `AgentFace`, whose
 * moods are the same five names plus 'happy'. VoiceAgent passes the 3D face.
 */
export type VoiceVisualState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'refusing';

/** A press that travels further than this was a drag, not a click. */
const DRAG_SLOP = 5;

export function VoiceWidget({
  status,
  isSpeaking,
  gapsRemaining,
  unavailableReason,
  busy,
  onConnect,
  onDisconnect,
  visualState,
  visual,
}: {
  status: VoiceStatus;
  isSpeaking: boolean;
  gapsRemaining: number | null;
  unavailableReason: string | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  visualState: VoiceVisualState;
  /** The face. */
  visual?: React.ReactNode;
}) {
  // The hook lives here rather than in the parent so the DOM node it measures never
  // crosses a component boundary — see the note in useDraggable.ts about
  // react-hooks/refs.
  const { style, attach, onPointerDown, onKeyDown, announcement, isDragging, reset } = useDraggable();
  const pressedAt = useRef<{ x: number; y: number } | null>(null);

  const connected = status === 'connected';
  const connecting = status === 'connecting' || busy;
  const blocked = Boolean(unavailableReason);

  const caption = unavailableReason
    ? // Short, and never the server's own words. The full reason goes to the
      // transcript panel, which is where the typed fallback actually is — a
      // paragraph of configuration detail under a face is not a caption.
      'Voice is off — type in the transcript'
    : connecting
      ? 'Connecting…'
      : status === 'error'
        ? 'Connection problem — tap to try again'
        : connected
          ? isSpeaking
            ? 'Speaking… tap to stop'
            : 'Listening… tap to stop'
          : gapsRemaining
            ? `Start talking · ${gapsRemaining} question${gapsRemaining === 1 ? '' : 's'} left`
            : 'Start talking';

  const toggle = () => {
    if (blocked) return;
    if (connected) onDisconnect();
    else if (!connecting) onConnect();
  };

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
        <button
          type="button"
          className="vw-face"
          aria-pressed={connected}
          disabled={blocked}
          title={connected ? 'Stop talking' : 'Start talking'}
          onPointerDown={(event) => {
            pressedAt.current = { x: event.clientX, y: event.clientY };
            onPointerDown(event);
          }}
          onClick={(event) => {
            const from = pressedAt.current;
            pressedAt.current = null;
            // Dragged, not clicked. Keyboard Enter reports 0,0 and no press point,
            // so it falls through to the toggle as it should.
            if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > DRAG_SLOP) return;
            toggle();
          }}
          onKeyDown={(event) => {
            onKeyDown(event);
            if (event.key === 'Home') {
              event.preventDefault();
              reset();
            }
          }}
        >
          {visual}
          <span className="vt-sr-only">
            {connected ? 'Stop talking to HireWire.' : 'Start talking to HireWire.'} Use the arrow
            keys to move this control, hold shift to move further, Home to send it back to its
            corner. Or drag it with the mouse.
          </span>
        </button>

        {/* Never only a colour or an animation. */}
        <p className={`vw-caption${blocked || status === 'error' ? ' is-failure' : ''}`} role="status">
          {caption}
        </p>
      </div>
    </>
  );
}
