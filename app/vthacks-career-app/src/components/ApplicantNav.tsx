'use client';

/**
 * The workspace side nav: a left drawer holding every destination, with the
 * wordmark and a single toggle left in the top bar.
 *
 * It mirrors the transcript drawer on the right — same width behaviour, same
 * easing, same push rather than overlay — so opening both narrows the page from
 * each side instead of burying it. The open state rides on <html> as a data
 * attribute; the widths and the movement live in CSS beside everything else
 * that has to respond.
 *
 * Collapsed state is remembered, because a demo operator who closes it once
 * should not have to close it again on every route change.
 */
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useSyncExternalStore } from 'react';

import { SignOutForm } from '@/components/SignOutForm';

/**
 * Ordered as the work happens: find a role, track it, send it, then read back
 * what the agent decided. Pipeline sits after Jobs because that is where a saved
 * role goes, and before Activity because Activity is the agent's audit trail
 * rather than the user's own tracking — two different pages on purpose.
 */
const links = [
  { href: '/applicant', label: 'Overview', key: 'overview' },
  { href: '/applicant/jobs', label: 'Jobs', key: 'jobs' },
  { href: '/applicant/pipeline', label: 'Pipeline', key: 'pipeline' },
  { href: '/applicant/apply', label: 'Verify & apply', key: 'apply' },
  { href: '/applicant/activity', label: 'Activity', key: 'activity' },
] as const;

export type ApplicantSection = (typeof links)[number]['key'];

const STORAGE_KEY = 'hirewire:sidenav';

/* localStorage read through useSyncExternalStore rather than an effect that
   calls setState — that pattern cascades renders, and React gives us the right
   tool for reading an external store. The server snapshot is "closed" so the
   markup React hydrates against always matches. */
let listeners: (() => void)[] = [];

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

/** Closed during SSR and hydration; the stored value applies immediately after. */
function getServerSnapshot() {
  return false;
}

function setStored(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    /* private window, or storage blocked. The nav still works, it just forgets. */
  }
  listeners.forEach((l) => l());
}

export function ApplicantNav({ current }: { current: ApplicantSection }) {
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Tell the document, so the page can make room instead of being covered.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidenav = open ? 'open' : 'closed';
    return () => {
      delete root.dataset.sidenav;
    };
  }, [open]);

  return (
    <>
      <nav className="topbar" aria-label="Workspace">
        <button
          type="button"
          className="topbar__toggle"
          aria-expanded={open}
          aria-controls="sidenav"
          onClick={() => setStored(!open)}
        >
          {open ? <PanelLeftClose size={20} aria-hidden="true" /> : <PanelLeftOpen size={20} aria-hidden="true" />}
          <span className="sr-only">{open ? 'Hide navigation' : 'Show navigation'}</span>
        </button>
      </nav>

      <div className="sidenav" id="sidenav" hidden={!open}>
        <p className="sidenav__label">Workspace</p>
        <ul>
          {links.map((link) => (
            <li key={link.key}>
              <Link href={link.href} aria-current={link.key === current ? 'page' : undefined}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="sidenav__foot">
          <SignOutForm />
        </div>
      </div>
    </>
  );
}
