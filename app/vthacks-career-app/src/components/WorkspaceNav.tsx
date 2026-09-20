'use client';

/**
 * WorkspaceNav — the left drawer both workspaces use.
 *
 * Lifted out of ApplicantNav unchanged when the employer side got real
 * destinations of its own. The drawer behaviour — push rather than overlay, the
 * open state on <html> as a data attribute, the remembered collapsed state — is
 * not per-role, and two copies of a localStorage subscription would drift.
 * ApplicantNav and EmployerNav are now just their link lists.
 *
 * Collapsed state is remembered, because a demo operator who closes it once
 * should not have to close it again on every route change.
 */
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useSyncExternalStore } from 'react';

import { SignOutForm } from '@/components/SignOutForm';

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

export type WorkspaceLink = { href: string; label: string; key: string };

export function WorkspaceNav({
  links,
  current,
  label,
  foot,
}: {
  links: readonly WorkspaceLink[];
  current: string;
  /** What this workspace is called, above the links. */
  label: string;
  /**
   * What sits at the bottom of the drawer. Optional, defaulting to <SignOutForm />.
   *
   * Optional here and REQUIRED on ApplicantNav, which is not an inconsistency: the
   * applicant side has an account screen and every one of its pages must show the
   * same foot, so a missed page there should be a compile error. The employer side
   * has no account screen yet and signing out is the whole foot, so a default is
   * the honest answer rather than threading an identical prop through every
   * employer page.
   *
   * A client component cannot call `auth()`, but it CAN render server-rendered
   * children handed to it as a prop — which is how the session reaches the nav
   * without being passed through six pages as data.
   */
  foot?: React.ReactNode;
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
       — `nav button`, `nav a`, `nav span`, `nav strong` — and several page headers
       share them. Making this drawer a <nav> silently inherited all of them: the
       toggle picked up `nav button`'s border and padding and drifted 96px sideways
       between the open and collapsed states. The landmark and its accessible name
       are identical either way; only the selector leak differs. */
    <div
      className={`sidenav ${open ? 'is-open' : 'is-closed'}`}
      role="navigation"
      aria-label={label}
    >
      {/* THERE IS NO TOP BAR any more — see globals.css, which deleted `.topbar`
          outright. The header existed for one reason, somewhere to put this toggle,
          so removing the header moved the toggle inside the nav. That in turn means
          the nav can never be `hidden`: a control inside a display:none parent
          cannot be used to bring its parent back. Collapsed is a 56px RAIL holding
          just the toggle, not an absence — the labels disappear, the affordance
          does not. `hidden` therefore sits on the BODY, never on the drawer. */}
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
        <p className="sidenav__label">{label}</p>
        <ul>
          {links.map((link) => (
            <li key={link.key}>
              <Link href={link.href} aria-current={link.key === current ? 'page' : undefined}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="sidenav__foot">{foot ?? <SignOutForm />}</div>
      </div>
    </div>
  );
}
