/**
 * The hiring manager's destinations — the menu that did not exist.
 *
 * The employer dashboard's nav was three dead <span>s ("Roles", "Applicants",
 * "Agent") over a single page, while the endpoints behind two of those words
 * were already written and had no caller. These are the routes.
 *
 * Ordered as the hiring work happens: see what came in, read one exchange,
 * go looking for people who have not applied yet, then the audit trail of
 * everything the agent did on your behalf.
 */
import { WorkspaceNav } from '@/components/WorkspaceNav';

const links = [
  { href: '/employer', label: 'Overview', key: 'overview' },
  { href: '/employer/applicants', label: 'Applicants', key: 'applicants' },
  { href: '/employer/candidates', label: 'Find candidates', key: 'candidates' },
  { href: '/employer/activity', label: 'Activity', key: 'activity' },
] as const;

export type EmployerSection = (typeof links)[number]['key'];

export function EmployerNav({ current }: { current: EmployerSection }) {
  return <WorkspaceNav links={links} current={current} label="Hiring workspace" />;
}
