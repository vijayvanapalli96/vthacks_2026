import { verifyProductionAgent } from './production';

const boardHosts = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co']);

export function normalizeEmployerDomain(value: string) {
  const input = value.trim().toLowerCase();
  const hostname = input.includes('://') ? new URL(input).hostname : input.split('/')[0];
  return hostname.replace(/^(?:www|jobs|careers)\./, '');
}

export function employerDomainFromJobUrl(jobUrl: string) {
  const hostname = new URL(jobUrl).hostname.toLowerCase();
  if (boardHosts.has(hostname)) return null;
  return normalizeEmployerDomain(hostname);
}

export async function discoverEmployerAgent(input: { jobUrl?: string; employerDomain?: string }) {
  const domain = input.employerDomain
    ? normalizeEmployerDomain(input.employerDomain)
    : input.jobUrl
      ? employerDomainFromJobUrl(input.jobUrl)
      : null;
  if (!domain) {
    throw new Error('This job board does not expose the employer domain. Supply employer_domain explicitly.');
  }

  const candidates = [`employer.${domain}`, domain];
  for (const host of candidates) {
    try {
      const result = await verifyProductionAgent({ host, expectedRole: 'employer' });
      if (result.verdict === 'pass') return { employer_domain: domain, ...result };
    } catch {
      // Continue to the next exact host candidate; fuzzy registry results never pass.
    }
  }
  throw new Error(`No verified employer agent was found for ${domain}.`);
}
