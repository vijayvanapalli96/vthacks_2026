/**
 * AccountButton — who you are signed in as, at the foot of the nav. A LINK, not a menu.
 *
 * It replaced a bare "Sign out" button, which put the one destructive action in the most
 * reachable spot in the app and said nothing about which account you were in — worth
 * knowing on a machine carrying several test logins.
 *
 * IT WAS BRIEFLY A <details> DISCLOSURE AND THAT WAS WRONG. Clicking it expanded a panel
 * in place instead of going anywhere, so the obvious action on an obvious target did not
 * do the obvious thing. Everything it used to reveal now lives on /applicant/account,
 * including sign out. One target, one destination.
 *
 * STILL A SERVER COMPONENT. It reads the session directly, which is why ApplicantNav —
 * a `'use client'` component that cannot call `auth()` — takes it as a slot rather than
 * having the session threaded through six pages as props.
 */
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { requireUser } from '@/lib/session';

import './account.css';

/** First letter of whatever we can actually show, for the square. */
function initial(from: string): string {
  return from.trim().charAt(0).toUpperCase() || '?';
}

export async function AccountButton() {
  const user = await requireUser();

  const email = user.email ?? null;
  // Credentials signups have no name, so the local part of the address is the most human
  // thing actually on file. Never an invented placeholder — hard rule 7.
  const display = user.name?.trim() || email?.split('@')[0] || 'Your account';
  const role = typeof user.role === 'string' ? user.role : null;

  return (
    <Link className="account" href="/applicant/account">
      <span className="account__avatar" aria-hidden="true">
        {initial(display)}
      </span>
      <span className="account__who">
        <strong>{display}</strong>
        {role ? <span className="account__role">{role}</span> : null}
      </span>
      <ChevronRight className="account__caret" size={16} aria-hidden="true" />
    </Link>
  );
}
