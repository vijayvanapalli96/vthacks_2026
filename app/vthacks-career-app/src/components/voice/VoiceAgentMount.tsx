'use client';

/**
 * Where the dock is allowed to exist.
 *
 * The dock is mounted in `app/applicant/layout.tsx` so a conversation SURVIVES
 * navigation (see the comment there). That is right everywhere except the two intake
 * screens, which are the first thing a new student sees and are deliberately bare: one
 * question, one file, nothing else on screen. A floating face and a transcript drawer
 * that pushes the page 420px narrower is the opposite of that.
 *
 * THE COST, STATED: navigating INTO intake unmounts the dock and therefore ends a live
 * conversation. That is the trade — these two routes are the start of the flow, before
 * there is anything to talk about, so in practice there is no conversation to lose.
 *
 * A pathname test in a client component rather than a route group, because the guard in
 * the layout (`requireRole('applicant')`) has to keep running on these pages. Moving
 * them out of the segment to escape the dock would move them out of the auth check too.
 *
 * TranscriptPanel deletes `data-transcript` from <html> on unmount, so `--drawer-w`
 * returns to 0 and the page reclaims its full width on its own.
 */
import { usePathname } from 'next/navigation';

import { VoiceAgent } from './VoiceAgent';

const BARE_ROUTES = ['/applicant/intake/resume', '/applicant/intake/linkedin'];

export function VoiceAgentMount({ rank = 0 }: { rank?: number }) {
  const pathname = usePathname();
  const bare = BARE_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  if (bare) return null;
  return <VoiceAgent rank={rank} />;
}
