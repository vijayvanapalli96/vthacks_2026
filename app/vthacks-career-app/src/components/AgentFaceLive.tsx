'use client';

import dynamic from 'next/dynamic';

import { AgentFace, type FaceMood } from './AgentFace';

/**
 * HireWire's face, everywhere it appears.
 *
 * three.js is ~880 KB and needs a DOM, so the 3D head is client-only and split
 * into its own chunk. Until it arrives the flat face stands in — same character,
 * same mood, so the swap reads as the drawing gaining depth rather than as one
 * thing being replaced by another. It is also what a browser with no WebGL is
 * left with, which is the point of keeping the SVG around.
 *
 * WHY THERE IS NO DARK VARIANT. The 2D face is transparent line art, so on a dark
 * panel it has to borrow the page's contrast — that is what the `currentColor`
 * override in voice.css is for. The 3D head carries its own lit surface, so paper
 * with ink features reads on the navy rail and the green voice widget alike, and
 * the signal colours stay legible because they sit on the ball rather than on the
 * page.
 */
const AgentFace3D = dynamic(() => import('./AgentFace3D'), {
  ssr: false,
  loading: () => <AgentFace mood="idle" size={160} />,
});

export function AgentFaceLive({
  mood = 'idle',
  size = 260,
  muted = false,
  nose = false,
  onNose,
}: {
  mood?: FaceMood;
  size?: number;
  muted?: boolean;
  /** Draw the speaker-cone nose, live session or not. */
  nose?: boolean;
  /** Passing this gives the face a nose that mutes the speaker when clicked.
   *  Only the voice widget does; the greeter and the rail stay noseless. */
  onNose?: () => void;
}) {
  return <AgentFace3D mood={mood} size={size} muted={muted} nose={nose} onNose={onNose} />;
}
