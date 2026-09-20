import { redirect } from 'next/navigation';

import { requireRole } from '@/lib/session';

export const metadata = { title: 'Jobs · HireWire' };
export const dynamic = 'force-dynamic';

export default async function JobPage() {
  await requireRole('applicant');
  redirect('/applicant/jobs');
}
