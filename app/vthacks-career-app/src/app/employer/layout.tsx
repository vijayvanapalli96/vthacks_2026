import { requireRole } from '@/lib/session';

export default async function EmployerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireRole('employer');
  return children;
}
