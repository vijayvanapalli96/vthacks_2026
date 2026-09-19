import { ArrowRight, BriefcaseBusiness, ShieldCheck, UserRoundSearch } from 'lucide-react';
import Link from 'next/link';

import { Reveal } from '@/components/Reveal';

export default function Home() {
  return (
    <main id="main">
      <nav>
        <strong>HireWire</strong>
        <Link href="/signin">Sign in</Link>
        <Link href="/signup">Create account</Link>
      </nav>

      <Reveal as="section" className="hero">
        <p className="eyebrow">VERIFIED AGENT-TO-AGENT HIRING</p>
        <h1>
          Both sides
          <br />
          prove who they are.
        </h1>
        <p>
          An applicant&rsquo;s agent finds roles, tailors the materials, and checks that an employer
          is real before releasing anything. An employer&rsquo;s agent checks that the applicant is a
          real, domain-anchored person. Nobody&rsquo;s documents move until both sides verify.
        </p>
      </Reveal>

      <section className="pathways">
        <Reveal as="article" className="pathway" index={1}>
          <UserRoundSearch aria-hidden="true" />
          <h2>I&rsquo;m looking for a role</h2>
          <p>
            Upload a resume or skip it and talk instead. Your agent matches you against real
            postings, drafts your materials, and refuses out loud if an employer can&rsquo;t prove
            who it is.
          </p>
          <Link className="primary" href="/signup?role=applicant">
            Get started as an applicant <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </Reveal>

        <Reveal as="article" className="pathway" index={2}>
          <BriefcaseBusiness aria-hidden="true" />
          <h2>I&rsquo;m hiring</h2>
          <p>
            Publish roles your agent can answer for. Every inbound application arrives from an agent
            with a verifiable identity, so the fake-applicant flood stops at the door.
          </p>
          <Link className="primary" href="/signup?role=employer">
            Get started as an employer <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </Reveal>
      </section>

      <Reveal as="footer" onScroll>
        <ShieldCheck aria-hidden="true" />
        <strong>Human approval is always required.</strong>
        <span>The system recommends; you control every external action.</span>
      </Reveal>
    </main>
  );
}
