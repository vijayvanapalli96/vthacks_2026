/**
 * legitimacy.ts — is the company posting this job a real, operating employer?
 *
 * This is deliberately NOT the ANS check and never substitutes for it. As of
 * today essentially no employer has registered an ANS agent: a sweep of the
 * GoDaddy registry for every company in our feed (Anthropic, OpenAI, Discord,
 * Anduril, Roblox, Databricks, Waymo, Lyft and a dozen more) returned zero
 * agents, and the registry is mostly one vendor's auto-provisioned support
 * agents. So "no ANS agent" describes the state of the world, not the employer.
 *
 * A baseline check answers the question a student actually has — "is this a
 * real company or a scam posting?" — from evidence we can check ourselves:
 *
 *   ats     the posting came from the company's own applicant tracking system
 *           via that ATS's API, not from a scraped page. A Greenhouse or Ashby
 *           board is a provisioned, paid account tied to a real company. This
 *           is the signal that decides the tier, because it is evidence about
 *           THIS POSTING rather than about a domain we inferred.
 *   domain  corroboration, and only when the posting itself links to the
 *           company's own site. Then we check that it completes a TLS handshake
 *           with a certificate a public CA issued for it; Node rejects an
 *           invalid or mismatched certificate, so reaching a response IS the
 *           check. When the posting only links to an ATS board we say the
 *           domain is undetermined rather than guessing: "Anduril Industries"
 *           slugs to andurilindustries.com, which does not exist, and calling
 *           that a failed check would defame a real company over our own guess.
 *
 * Neither signal proves intent, and we never say it does. The strongest claim
 * here is "this is a real company that runs a real hiring pipeline" — a much
 * weaker claim than ANS verification, and shown as such. Releasing PII still
 * requires a passing ANS check; nothing in this file unlocks that.
 */

/** ATS APIs we read postings from, as recorded in `job.source`. */
const ATS_API_SOURCES = new Map<string, string>([
  ['greenhouse-api', 'Greenhouse'],
  ['ashby-api', 'Ashby'],
  ['lever-api', 'Lever'],
]);

export type LegitimacySignal = {
  name: 'ats' | 'domain';
  passed: boolean;
  /** Always present, passed or not. A signal without a reason is a bug. */
  reason: string;
};

export type CompanyAssessment = {
  domain: string;
  /**
   * agent_verified is set by the caller after ANS passes; this module only
   * ever returns known_employer or unverified.
   */
  tier: 'known_employer' | 'unverified';
  signals: LegitimacySignal[];
  summary: string;
};

async function checkDomain(domain: string | null): Promise<LegitimacySignal> {
  if (!domain) {
    return {
      name: 'domain',
      passed: false,
      reason: 'The posting links to an applicant tracking system rather than the company’s own site, so we did not infer a domain to check.',
    };
  }
  try {
    // Node rejects an expired, self-signed or mismatched certificate, so any
    // response at all means a public CA vouched for this hostname. HEAD first;
    // some marketing sites answer 405, which still proves the handshake.
    const response = await fetch(`https://${domain}`, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    return {
      name: 'domain',
      passed: true,
      reason: `${domain} serves HTTPS with a certificate a public authority issued for it (HTTP ${response.status}).`,
    };
  } catch {
    return {
      name: 'domain',
      passed: false,
      reason: `${domain} did not complete an HTTPS handshake, so we could not confirm the company operates it.`,
    };
  }
}

function checkAts(source: string | null): LegitimacySignal {
  const ats = source ? ATS_API_SOURCES.get(source) : undefined;
  if (ats) {
    return {
      name: 'ats',
      passed: true,
      reason: `The posting came from the company's own ${ats} account through the ${ats} API, not from a scraped page.`,
    };
  }
  return {
    name: 'ats',
    passed: false,
    reason: source
      ? `The posting came from ${source}, which does not by itself tie it to a company-operated hiring system.`
      : 'The posting has no recorded source, so it is not tied to a company-operated hiring system.',
  };
}

export async function assessCompany(input: {
  /** Only when the posting itself names it; null when we would be guessing. */
  postedDomain: string | null;
  source: string | null;
  companyName: string;
}): Promise<CompanyAssessment> {
  const [ats, domain] = await Promise.all([
    Promise.resolve(checkAts(input.source)),
    checkDomain(input.postedDomain),
  ]);
  const signals = [ats, domain];

  // The ATS signal alone decides the tier. Requiring the domain too would sink
  // every company whose postings live on a board rather than their own careers
  // page - which is most of them - on the strength of a guess we made.
  const tier = ats.passed ? 'known_employer' : 'unverified';

  const ats_name = ATS_API_SOURCES.get(input.source ?? '') ?? 'an applicant tracking system';
  const summary = tier === 'known_employer'
    ? `${input.companyName} is a real employer: this posting came from its own ${ats_name} account${domain.passed ? ` and it operates ${input.postedDomain}` : ''}. It has not registered an agent with ANS, so we cannot verify who would receive your data — nothing is sent.`
    : `${input.companyName} could not be confirmed as an operating employer, and it has not registered an agent with ANS.`;

  return { domain: input.postedDomain ?? '', tier, signals, summary };
}
