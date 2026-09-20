/**
 * The applicant workspace's destinations. The drawer itself is WorkspaceNav,
 * which the employer side uses too; this file is the link list and nothing else.
 *
 * The full drawer used to live here, and the collapse behaviour it documented — no
 * top bar, a 56px rail rather than a hidden nav, `role="navigation"` on a div to
 * dodge the `nav button` selector leak — now lives in WorkspaceNav, which was
 * rewritten to match. Nothing about the behaviour changed; only where it is.
 *
 * Ordered as the work happens: find a role, track it, send it, then read back
 * what the agent decided. Pipeline sits after Jobs because that is where a saved
 * role goes, and before Activity because Activity is the agent's audit trail
 * rather than the user's own tracking — two different pages on purpose.
 */
import { WorkspaceNav } from '@/components/WorkspaceNav';

const links = [
  { href: '/applicant', label: 'Overview', key: 'overview' },
  { href: '/applicant/jobs', label: 'Jobs', key: 'jobs' },
  { href: '/applicant/pipeline', label: 'Pipeline', key: 'pipeline' },
  /* NO "Verify & apply" LINK, and the page is still there.
     
     /applicant/apply is reached from a specific role — the job page, the match
     card, or the voice agent walking you there — because approving a release of
     your details only means something with a posting attached. As a standing
     menu item it invited you to open it with no job in hand, which is a page
     that can only tell you to go and pick one. The route, the approval flow and
     every link INTO it are untouched. */
  { href: '/applicant/activity', label: 'Activity', key: 'activity' },
  /* Last, and outside the sequence above on purpose: Profile is not a step in the
     work, it is the thing the work is done FROM. It sits next to the account link in
     the foot, which is the other "about you" destination. */
  { href: '/applicant/profile', label: 'Profile', key: 'profile' },
] as const;

/**
 * `apply` is deliberately still a section even though it is not a link: the
 * approval page passes current="apply", and WorkspaceNav simply highlights
 * nothing when the current section has no entry. Dropping it from the union
 * would be a build error on a page that is very much still in use.
 */
export type ApplicantSection = (typeof links)[number]['key'] | 'apply';

/**
 * `account` is a SLOT, and it is required on purpose.
 *
 * The foot used to render <SignOutForm /> directly. It now takes whatever the page
 * passes, which is <AccountButton /> — a SERVER component that reads the session
 * itself. WorkspaceNav is `'use client'` and so cannot call `auth()`; a client
 * component can still RENDER server-rendered children handed to it as a prop, which
 * is how the session reaches the nav without being threaded through six pages.
 *
 * Not optional with a sign-out fallback: a missed page would silently keep the old
 * foot and the nav would differ between routes. Required means the compiler names
 * every caller that still needs updating.
 */
export function ApplicantNav({
  current,
  account,
}: {
  current: ApplicantSection;
  account: React.ReactNode;
}) {
  return <WorkspaceNav links={links} current={current} label="Workspace" foot={account} />;
}
