import type { Metadata } from 'next';
import { Forum, Inter } from 'next/font/google';

import { LenisProvider } from '@/components/LenisProvider';

import './globals.css';

/**
 * Forum is display-only and ships a single weight (400) — there is no bold.
 * Hierarchy comes from size, letter-spacing and opacity. Inter carries every
 * piece of body copy, UI label and number, where Forum would be unreadable.
 */
const forum = Forum({ weight: '400', subsets: ['latin'], variable: '--font-display', display: 'swap' });
const inter = Inter({ subsets: ['latin'], variable: '--font-body', display: 'swap' });

export const metadata: Metadata = {
  title: 'Application Workspace',
  description: 'Accessible, human-approved job application intelligence.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${forum.variable} ${inter.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <LenisProvider />
        {children}
      </body>
    </html>
  );
}
