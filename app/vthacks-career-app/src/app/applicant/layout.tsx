import { VoiceAgentMount } from '@/components/voice/VoiceAgentMount';
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
 * `rank={1}` WAS the seam with the other lane: `app/applicant/page.tsx` rendered a
 * second, bare `<VoiceAgent />` and the two arbitrated so only one painted. That page
 * no longer renders one, so this is the only instance and nothing is being arbitrated
 * against. The rank is kept because it also decides who paints during SSR — a ranked
 * instance renders while the slot is free, which is what stops the dock appearing a
 * tick late — but the second half of mount-claim.ts is now dead weight and can go with
 * the next person who touches it. See components/voice/mount-claim.ts.
 *
 * It goes through VoiceAgentMount rather than rendering VoiceAgent directly, because the
 * two intake screens are deliberately bare and render no dock at all. That file says
 * which routes and why.
 */
export default async function ApplicantLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireRole('applicant');
  return (
    <>
      {children}
      <VoiceAgentMount rank={1} />
    </>
  );
}
