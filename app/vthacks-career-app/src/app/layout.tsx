import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Application Workspace',
  description: 'Accessible, human-approved job application intelligence.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
