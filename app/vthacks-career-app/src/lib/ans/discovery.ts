import { verifyProductionAgent } from './production';

/**
 * Applicant tracking systems that host the posting but are not the employer.
 * The employer's identity is in the URL either as the first path segment
 * (`boards.greenhouse.io/acme/jobs/123`) or as the leading subdomain
 * (`acme.recruitee.com`, `acme.wd5.myworkdayjobs.com`).
 */
const BOARD_PATH_HOSTS = new Set([
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'jobs.lever.co',
  'jobs.eu.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
  'careers.smartrecruiters.com',
  'www.workatastartup.com',
  'wellfound.com',
]);

const BOARD_SUFFIX_HOSTS = [
  'myworkdayjobs.com',
  'recruitee.com',
  'applytojob.com',
  'bamboohr.com',
  'workable.com',
  'teamtailor.com',
  'breezy.hr',
  'jobvite.com',
  'zohorecruit.com',
  'icims.com',
];

/** Subdomains a company puts its careers site on; never its ANS agent host. */
const CAREERS_PREFIXES = ['www', 'jobs', 'job', 'careers', 'career', 'apply', 'hiring', 'talent', 'recruiting'];

/** Subdomains an employer plausibly registers its agent under, best first. */
const AGENT_PREFIXES = ['employer', 'agent', 'hiring', 'recruiting', 'careers'];

function bareHostname(value: string) {
  const input = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!input) return '';
  try {
    const hostname = input.includes('://')
      ? new URL(input).hostname
      : input.split('/')[0].split('?')[0];
    return hostname.replace(/\.+$/, '');
  } catch {
    return '';
  }
}

/** Strips careers-site prefixes, however many are stacked (`www.jobs.acme.com`). */
export function normalizeEmployerDomain(value: string) {
  let hostname = bareHostname(value);
  let stripped = true;
  while (stripped && hostname.split('.').length > 2) {
    stripped = false;
    for (const prefix of CAREERS_PREFIXES) {
      if (hostname.startsWith(`${prefix}.`)) {
        hostname = hostname.slice(prefix.length + 1);
        stripped = true;
        break;
      }
    }
  }
  return hostname;
}

function isBoardHost(hostname: string) {
  return BOARD_PATH_HOSTS.has(hostname) || BOARD_SUFFIX_HOSTS.some((suffix) => hostname.endsWith(`.${suffix}`));
}

function slugToDomain(slug: string | undefined) {
  const cleaned = (slug ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return cleaned.length > 1 ? `${cleaned}.com` : null;
}

/**
 * The employer domain a posting URL points at, or null when the URL names no
 * employer at all. A board URL resolves to the employer slug the board uses,
 * which is a guess — it still has to survive exact ANS verification.
 */
export function employerDomainFromJobUrl(jobUrl: string) {
  let url: URL;
  try {
    url = new URL(jobUrl);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');

  if (BOARD_PATH_HOSTS.has(hostname)) {
    return slugToDomain(url.pathname.split('/').filter(Boolean)[0]);
  }
  const suffix = BOARD_SUFFIX_HOSTS.find((value) => hostname.endsWith(`.${value}`));
  if (suffix) {
    return slugToDomain(hostname.slice(0, -(suffix.length + 1)).split('.')[0]);
  }
  return normalizeEmployerDomain(hostname) || null;
}

/**
 * Exact hosts worth an ANS lookup for one employer, best first. A company's
 * agent is rarely on the apex: `employer.acme.com` is the convention we publish,
 * but we also try the apex and the other subdomains employers actually use,
 * plus the posting's own host when it belongs to the employer (`jobs.acme.com`).
 */
export function employerCandidateHosts(input: { domain: string; jobUrl?: string }) {
  const candidates = AGENT_PREFIXES.map((prefix) => `${prefix}.${input.domain}`);
  candidates.push(input.domain);
  if (input.jobUrl) {
    const postingHost = bareHostname(input.jobUrl);
    if (postingHost && !isBoardHost(postingHost) && postingHost.endsWith(`.${input.domain}`)) {
      candidates.push(postingHost);
    }
  }
  return [...new Set(candidates.filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)))];
}

export async function discoverEmployerAgent(input: { jobUrl?: string; employerDomain?: string }) {
  const domain = input.employerDomain
    ? normalizeEmployerDomain(input.employerDomain)
    : input.jobUrl
      ? employerDomainFromJobUrl(input.jobUrl)
      : null;
  if (!domain) {
    throw new Error('This posting does not name an employer domain. Supply employer_domain explicitly.');
  }

  const hosts = employerCandidateHosts({ domain, jobUrl: input.jobUrl });
  // Every candidate is an independent exact lookup, so run them together: one
  // employer costs one round trip, not one per guessed subdomain.
  const settled = await Promise.all(hosts.map(async (host) => {
    try {
      return await verifyProductionAgent({ host, expectedRole: 'employer' });
    } catch {
      // A host with no exact active registration is a miss, not a failure.
      return null;
    }
  }));

  // Priority order, not response order: `employer.acme.com` beats `acme.com`.
  const passed = settled.findIndex((result) => result?.verdict === 'pass');
  if (passed >= 0) return { employer_domain: domain, ...settled[passed]! };

  // A registered agent that fails policy is the interesting refusal: say why.
  const registered = settled.findIndex((result) => result !== null);
  if (registered >= 0) {
    throw new Error(
      `${hosts[registered]} is registered in ANS but did not pass verification. ${settled[registered]!.spoken_reason}`,
    );
  }
  throw new Error(`No verified employer agent was found for ${domain}. Checked ${hosts.join(', ')}.`);
}
