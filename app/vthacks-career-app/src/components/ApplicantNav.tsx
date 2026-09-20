import Link from 'next/link';

import { SignOutForm } from '@/components/SignOutForm';

const links = [
  { href: '/applicant', label: 'Overview', key: 'overview' },
  { href: '/applicant/jobs', label: 'Jobs', key: 'jobs' },
  { href: '/applicant/apply', label: 'Verify & apply', key: 'apply' },
  { href: '/applicant/activity', label: 'Activity', key: 'activity' },
] as const;

export type ApplicantSection = (typeof links)[number]['key'];

export function ApplicantNav({ current }: { current: ApplicantSection }) {
  return (
    <nav aria-label="Applicant workspace">
      <strong>Application Workspace</strong>
      {links.map((link) => (
        <Link key={link.key} href={link.href} aria-current={link.key === current ? 'page' : undefined}>
          {link.label}
        </Link>
      ))}
      <SignOutForm />
    </nav>
  );
}
