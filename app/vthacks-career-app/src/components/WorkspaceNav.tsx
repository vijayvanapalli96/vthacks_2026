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
}: {
  links: readonly WorkspaceLink[];
  current: string;
  /** What this workspace is called, above the links. */
  label: string;
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
    <>
      <nav className="topbar" aria-label={label}>
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
        <div className="sidenav__foot">
          <SignOutForm />
        </div>
      </div>
    </>
  );
}
