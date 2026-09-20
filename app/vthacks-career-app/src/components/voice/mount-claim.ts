/**
 * mount-claim.ts — exactly one live VoiceAgent per page, whoever renders it.
 *
 * WHY THIS IS NEEDED. Making the agent an actor means it has to SURVIVE NAVIGATION:
 * "take me to the Stripe one" pushes a new route, and if the component unmounts the
 * conversation ends mid-sentence (and ElevenLabs bills for the reconnection). So the
 * dock is mounted in `app/applicant/layout.tsx`, which App Router keeps mounted across
 * every /applicant/* route change.
 *
 * But `app/applicant/page.tsx` already renders `<VoiceAgent />` too, and that file is
 * owned by another lane this hour. Two instances would mean two docks, two
 * ConversationProviders, and — the moment somebody clicks connect on the wrong one —
 * two microphones and two bills. So instead of editing their file, the component
 * claims a module-level slot and the loser renders nothing.
 *
 * RANK, NOT ORDER. The obvious implementation is first-effect-wins, and it is wrong
 * here: React runs child effects before parent effects, so the PAGE's instance would
 * win and the conversation would still die the moment you navigated off the dashboard
 * — the exact bug this exists to prevent. Ranking makes it order-independent: the
 * layout claims at rank 1, a bare `<VoiceAgent />` at rank 0, and rank 1 takes over
 * whenever both are present.
 *
 * WHY useSyncExternalStore AND NOT A useEffect + setState. `react-hooks/set-state-in-effect`
 * is an ERROR in this repo's eslint config, and correctly so — a setState in an effect
 * to mirror external state is a cascading re-render waiting to happen.
 * useSyncExternalStore is the API built for reading a mutable module-level value
 * during render without tearing, and `serverSnapshot` keeps SSR deterministic.
 *
 * WHEN app/applicant/page.tsx NEXT GETS TOUCHED, delete its `<VoiceAgent />` and this
 * file becomes dead weight worth removing. It is a seam, not an architecture.
 */

type Claim = { token: string; rank: number };

let holder: Claim | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeClaim(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The token currently holding the slot, or null while nobody has claimed it. */
export function claimSnapshot(): string | null {
  return holder?.token ?? null;
}

/**
 * On the server nobody has claimed anything, so every instance renders. That is
 * correct: the claim is about live microphones and there is no microphone during SSR,
 * and a server snapshot that guessed a winner would hydrate into a mismatch.
 */
export function serverClaimSnapshot(): null {
  return null;
}

/**
 * Take the slot if it is free or held at a lower rank. Returns the release function,
 * so an effect can `return claimMount(...)` directly.
 */
export function claimMount(token: string, rank: number): () => void {
  if (holder === null || holder.rank < rank) {
    holder = { token, rank };
    notify();
  }
  return () => {
    if (holder?.token === token) {
      holder = null;
      notify();
    }
  };
}
