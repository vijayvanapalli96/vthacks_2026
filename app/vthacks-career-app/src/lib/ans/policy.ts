export const TRUST_DIMENSIONS = [
  'integrity',
  'identity',
  'solvency',
  'behavior',
  'safety',
] as const;

export type TrustDimensionName = (typeof TRUST_DIMENSIONS)[number];

export type TrustDimension = {
  name: TrustDimensionName;
  score: number;
  reason: string;
};

export type EmployerEvidence = {
  agentCard: { name: string; endpoint: string };
  certificate: { valid: boolean; dns_names: string[] };
  trust: { dimensions: TrustDimension[] };
};

export function failedTrustDimensions(reason: string): TrustDimension[] {
  return TRUST_DIMENSIONS.map((name) => ({ name, score: 0, reason }));
}

const minimumDimensionScore = 65;
const minimumAverageScore = 75;

function domainFromAgentName(agentName: string) {
  return /^ans:\/\/v\d+\.\d+\.\d+\.(.+)$/i.exec(agentName)?.[1]?.toLowerCase() ?? null;
}

function hostnameMatchesDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function verifyEmployer({ agentCard, certificate, trust }: EmployerEvidence) {
  const failures: string[] = [];
  const agentDomain = domainFromAgentName(agentCard?.name);
  let endpoint: URL | undefined;

  try {
    endpoint = new URL(agentCard?.endpoint);
  } catch {
    failures.push('The employer endpoint is not a valid URL.');
  }

  if (!agentDomain) failures.push('The employer does not have a versioned ANS name.');
  if (endpoint?.protocol !== 'https:') failures.push('The employer endpoint is not HTTPS.');
  if (endpoint && agentDomain && !hostnameMatchesDomain(endpoint.hostname, agentDomain)) {
    failures.push('The endpoint hostname does not match the ANS domain.');
  }

  const dnsNames = certificate?.dns_names?.map((value) => value.toLowerCase()) ?? [];
  if (!certificate?.valid || !endpoint || !dnsNames.some((name) => hostnameMatchesDomain(endpoint.hostname, name))) {
    failures.push('No valid identity certificate binds the endpoint to its domain.');
  }

  const supplied = new Map(trust?.dimensions?.map((item) => [item.name, item]) ?? []);
  const dimensions = TRUST_DIMENSIONS.map((name) => {
    const item = supplied.get(name);
    const score = Number(item?.score);
    const reason = typeof item?.reason === 'string' ? item.reason.trim() : '';
    if (!Number.isInteger(score) || score < 0 || score > 100 || !reason) {
      failures.push(`Trust dimension ${name} is missing a valid score and reason.`);
    } else if (score < minimumDimensionScore) {
      failures.push(`Trust dimension ${name} is below policy.`);
    }
    return { name, score: Number.isFinite(score) ? score : 0, reason: reason || 'No evidence supplied.' };
  });

  const average = dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length;
  if (average < minimumAverageScore) failures.push('The aggregate trust score is below policy.');

  const verdict = failures.length === 0 ? 'pass' : 'refuse';
  return {
    verdict,
    dimensions,
    spoken_reason:
      verdict === 'pass'
        ? `Verified ${agentCard.name}. All five trust checks passed with an average score of ${Math.round(average)} percent.`
        : `Application blocked. ${failures.join(' ')}`,
    checked_at: new Date().toISOString(),
  } as const;
}
