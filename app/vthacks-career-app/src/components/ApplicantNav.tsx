/**
 * The applicant workspace's destinations. The drawer itself is WorkspaceNav,
 * which the employer side uses too; this file is the link list and nothing else.
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
  { href: '/applicant/apply', label: 'Verify & apply', key: 'apply' },
  { href: '/applicant/activity', label: 'Activity', key: 'activity' },
] as const;

export type ApplicantSection = (typeof links)[number]['key'];

export function ApplicantNav({ current }: { current: ApplicantSection }) {
  return <WorkspaceNav links={links} current={current} label="Workspace" />;
}
