import { requireRole } from '@/lib/session';

export default async function ApplicantLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireRole('applicant');
  return children;
}
