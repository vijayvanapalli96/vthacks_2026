import Link from 'next/link';

import { AccountButton } from '@/components/AccountButton';
import { ApplicantNav } from '@/components/ApplicantNav';
import { SignOutForm } from '@/components/SignOutForm';
import { requireRole } from '@/lib/session';

import '@/components/account.css';

export const metadata = { title: 'Your account · HireWire' };

/**
 * ACCOUNT, NOT PROFILE, and the split is deliberate rather than cosmetic.
 *
 * /applicant/profile is owned by another lane and reads the profile tables: skills,
 * roles, coursework, the things the resume produced. This page reads the SESSION and
 * nothing else — which login you are in, what it is called, what kind of account it is.
 * Two different questions with two different sources, so two pages; folding them
 * together would have meant editing a file someone else is working in, and would have
 * put account controls behind a page that issues half a dozen profile queries.
 *
 * NO DATABASE READ HERE AT ALL. Everything on this page comes off the session that the
 * guard already resolved, so it costs nothing and cannot fail separately from auth.
 *
 * Sign out appears here as well as in the nav menu, on purpose. The nav copy is the
 * quick one you reach from anywhere; this is the page you land on when you went looking
 * for it, and a settings page that cannot sign you out sends you hunting.
 */
export default async function AccountPage() {
  const user = await requireRole('applicant');

  const email = user.email ?? null;
  // Credentials signups carry no name. The local part of the address is the most human
  // thing actually on file — never an invented placeholder, per hard rule 7.
  const display = user.name?.trim() || email?.split('@')[0] || 'Your account';

  return (
    <main>
      <ApplicantNav current="overview" account={<AccountButton />} />

      <section className="hero trust-hero">
        <p className="eyebrow">YOUR ACCOUNT</p>
        <h1>{display}</h1>
        <p>
          The login you are signed in with. Your skills, roles and coursework live on your{' '}
          <Link href="/applicant/profile">profile</Link>, which is built from the documents you
          gave us rather than from anything typed here.
        </p>
      </section>

      <section className="panel account-page">
        <dl className="account-page__facts">
          <div>
            <dt>Name</dt>
            <dd>{user.name?.trim() || 'Not set. Sign-ins with an email and password do not collect one.'}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{email ?? 'Not set'}</dd>
          </div>
          <div>
            <dt>Account type</dt>
            <dd>
              {typeof user.role === 'string' ? user.role : 'Not set'}
              {user.role === 'applicant' ? '. You apply for roles, rather than posting them.' : ''}
            </dd>
          </div>
          {/* Shown because it is the id every audit row and profile fact is filed
              under, so it is the thing to quote when something looks wrong. */}
          <div>
            <dt>Account ID</dt>
            <dd>
              <code>{user.id}</code>
            </dd>
          </div>
        </dl>

        <div className="account-page__out">
          <SignOutForm />
        </div>
      </section>
    </main>
  );
}
