'use client';

/**
 * The workspace side nav: a left drawer holding every destination, with its own
 * collapse control.
 *
 * THERE IS NO TOP BAR. The header used to exist for one reason — somewhere to
 * put this toggle — so removing the header meant the toggle had to move inside
 * the nav, and that in turn means the nav can never be `hidden`: a control inside
 * a display:none parent cannot be used to bring its parent back. So collapsed is
 * a 56px RAIL holding just the toggle, not an absence. The labels are what
 * disappear, not the affordance.
 *
 * That is exactly how the transcript drawer on the right already behaves — its
 * `.vt-tab` sits on the dock rather than inside the panel, so it survives the
 * panel closing. Same width behaviour, same easing, same push rather than
 * overlay, and now the same always-reachable toggle on both sides.
 *
 * The open state rides on <html> as a data attribute; the widths and the movement
 * live in CSS beside everything else that has to respond to them.
 *
 * Collapsed state is remembered, because a demo operator who closes it once
 * should not have to close it again on every route change.
 */
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useSyncExternalStore } from 'react';

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
  /* Last, and outside the sequence above on purpose: Profile is not a step in the
     work, it is the thing the work is done FROM. It sits next to the account link in
     the foot, which is the other "about you" destination. */
  { href: '/applicant/profile', label: 'Profile', key: 'profile' },
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

/**
 * `account` is a SLOT, and it is required on purpose.
 *
 * The foot used to render <SignOutForm /> directly. It now takes whatever the page
 * passes, which is <AccountButton /> — a SERVER component that reads the session itself.
 * This component is `'use client'` and so cannot call `auth()`; a client component can
 * still RENDER server-rendered children handed to it as a prop, which is how the session
 * reaches the nav without being threaded through six pages as data.
 *
 * Not optional with a sign-out fallback: a missed page would then silently keep the old
 * foot and the nav would differ between routes. Required means the compiler names every
 * caller that still needs updating.
 */
export function ApplicantNav({
  current,
  account,
}: {
  current: ApplicantSection;
  account: React.ReactNode;
}) {
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
    /* `role="navigation"` on a div, NOT a <nav> element, and that is deliberate.
       globals.css styles the marketing page headers with bare element selectors
       — `nav button`, `nav a`, `nav span`, `nav strong` — and several page
       headers share them. Making this drawer a <nav> silently inherited all of
       them: the toggle picked up `nav button`'s border and padding and drifted
       96px sideways between the open and collapsed states. The landmark and its
       accessible name are identical either way; only the selector leak differs. */
    <div
      className={`sidenav ${open ? 'is-open' : 'is-closed'}`}
      role="navigation"
      aria-label="Workspace"
    >
      {/* Outside the collapsible body on purpose: this is the only way back from
          collapsed, so it must not be inside the thing it hides. */}
      <button
        type="button"
        className="sidenav__toggle"
        aria-expanded={open}
        aria-controls="sidenav-body"
        onClick={() => setStored(!open)}
      >
        {open ? <PanelLeftClose size={20} aria-hidden="true" /> : <PanelLeftOpen size={20} aria-hidden="true" />}
        <span className="sr-only">{open ? 'Hide navigation' : 'Show navigation'}</span>
      </button>

      <div className="sidenav__body" id="sidenav-body" hidden={!open}>
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
        <div className="sidenav__foot">{account}</div>
      </div>
    </div>
  );
}
