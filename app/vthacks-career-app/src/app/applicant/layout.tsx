import { VoiceAgent } from '@/components/voice/VoiceAgent';
import { requireRole } from '@/lib/session';

/**
 * The voice dock is mounted HERE, not on a page, and that is load-bearing.
 *
 * Making the agent an actor means it navigates: "take me to the Stripe one" pushes a
 * route. App Router keeps a layout mounted across every route change inside its
 * segment, so the conversation, the transcript and the action log survive that
 * navigation. Mounted on a page instead, `open_page` would end the conversation it just
 * used — mid-sentence, and with a reconnection charge on a per-minute account.
 *
 * It is LAST in the DOM so tab order reaches the page content before the floating
 * control, rather than making every keyboard user pass through it first. It connects
 * nothing until asked: there is no auto-connect anywhere in the component.
 *
 * `rank={1}` is the seam with the other lane. `app/applicant/page.tsx` still renders a
 * bare `<VoiceAgent />` (rank 0) and belongs to someone else this hour, so instead of
 * editing their file the two instances arbitrate: rank 1 takes the slot and rank 0
 * renders nothing. See components/voice/mount-claim.ts. When that page is next touched,
 * delete its `<VoiceAgent />` and the ranking can go with it.
 */
export default async function ApplicantLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireRole('applicant');
  return (
    <>
      {children}
      <VoiceAgent rank={1} />
    </>
  );
}
