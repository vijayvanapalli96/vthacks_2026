import { verifyEmployer, type EmployerEvidence, type TrustDimension } from './policy';
import type { Turn } from '../a2a/transcript';

/**
 * Optional observer for the individual messages this lookup sends. It exists so
 * the apply screen can show the chain as it happens; nothing here depends on it,
 * and every call site that does not pass one behaves exactly as before.
 */
export type StepSink = (turn: Omit<Turn, 'seq' | 'at'>) => void;

export const EMPLOYER_AGENT_ID =
  process.env.EMPLOYER_AGENT_ID ?? 'b39aed69-06b0-457b-b1db-f26e75a5e7bc';
export const EMPLOYER_ANS_NAME =
  process.env.EMPLOYER_ANS_NAME ?? 'ans://v1.0.0.employer.hirewire.biz';
export const APPLICANT_ANS_NAME =
  process.env.APPLICANT_ANS_NAME ?? 'ans://v1.0.0.applicant.hirewire.biz';

export type AgentLookup = {
  agentId?: string;
  ansName?: string;
  host?: string;
  expectedRole?: 'employer' | 'applicant';
  /** See StepSink. Observation only — it cannot change what is looked up. */
  onStep?: StepSink;
};

const registryUrl = 'https://api.godaddy.com/v1/ans/registered-agents';
const transparencyUrl = 'https://transparency.ans.godaddy.com/v1/agents';

type RegistryAgent = {
  agentId: string;
  ansName: string;
  agentHost: string;
  lifecycle?: { status?: string };
  endpoints?: Array<{ agentUrl?: string; metaDataUrl?: string; protocol?: string }>;
};

type TransparencyEvent = {
  agent?: { host?: string; name?: string; version?: string };
  attestations?: {
    domainValidation?: string;
    dnsRecordsProvisioned?: unknown;
    validIdentityCerts?: Array<{ fingerprint?: string; notAfter?: string }>;
    validServerCerts?: Array<{ fingerprint?: string; notAfter?: string }>;
  };
};

function certificateIsCurrent(certificates: Array<{ notAfter?: string }> | undefined) {
  return Boolean(certificates?.some((certificate) => {
    const expiry = Date.parse(certificate.notAfter ?? '');
    return Number.isFinite(expiry) && expiry > Date.now();
  }));
}

async function fetchJson(url: string, timeoutMs = 7000) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Evidence endpoint returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function loadPublishedCard(metadataUrl: string | undefined) {
  if (!metadataUrl) return null;
  try {
    const value = await fetchJson(metadataUrl, 4000);
    if (!value || typeof value !== 'object') return null;
    return value as { name?: string; endpoint?: string };
  } catch {
    return null;
  }
}

export async function loadAgentEvidence(lookup: AgentLookup): Promise<{
  evidence: EmployerEvidence;
  registry: { agent_id: string; ans_name: string; status: string; metadata_reachable: boolean };
}> {
  const queryValue = lookup.ansName ?? lookup.host ?? lookup.agentId;
  if (!queryValue) throw new Error('An ANS name, host, or agent ID is required.');
  const query = encodeURIComponent(queryValue);
  const step = lookup.onStep;
  step?.({
    from: 'applicant_agent',
    to: 'ans_registry',
    label: 'Who is this employer?',
    detail: `Asked GoDaddy's Agent Name Service for an active agent matching ${queryValue}, before anything was said to the employer itself.`,
    data: { query: queryValue, expected_role: lookup.expectedRole ?? 'any', registry: registryUrl },
    outcome: 'ok',
  });
  const [registryPayload, transparencyPayload] = await Promise.all([
    fetchJson(`${registryUrl}?query=${query}`),
    lookup.agentId ? fetchJson(`${transparencyUrl}/${encodeURIComponent(lookup.agentId)}`) : Promise.resolve(null),
  ]);

  const items = (registryPayload as { items?: RegistryAgent[] }).items ?? [];
  const agent = items.find((item) =>
    item.lifecycle?.status === 'ACTIVE' &&
    (!lookup.agentId || item.agentId === lookup.agentId) &&
    (!lookup.ansName || item.ansName === lookup.ansName) &&
    (!lookup.host || item.agentHost?.toLowerCase() === lookup.host.toLowerCase()));
  if (!agent) {
    step?.({
      from: 'ans_registry',
      to: 'applicant_agent',
      label: 'No active agent under that name',
      detail: `The registry returned ${items.length} record${items.length === 1 ? '' : 's'} and none was an exact active match, so there is nobody to hand an application to.`,
      data: { records_returned: items.length },
      outcome: 'refused',
    });
    throw new Error('No exact active agent matched the ANS lookup.');
  }
  if (lookup.expectedRole && !new RegExp(`^ans://v\\d+\\.\\d+\\.\\d+\\.${lookup.expectedRole}\\.`, 'i').test(agent.ansName)) {
    step?.({
      from: 'ans_registry',
      to: 'applicant_agent',
      label: 'Registered, but not as an employer',
      detail: `${agent.ansName} is active in ANS but is not registered in the ${lookup.expectedRole} role this application requires.`,
      data: { ans_name: agent.ansName, expected_role: lookup.expectedRole },
      outcome: 'refused',
    });
    throw new Error(`The discovered agent is not registered as an ${lookup.expectedRole} agent.`);
  }
  step?.({
    from: 'ans_registry',
    to: 'applicant_agent',
    label: 'One active registered agent',
    detail: `${agent.ansName} is registered at ${agent.agentHost} with lifecycle ${agent.lifecycle?.status ?? 'UNKNOWN'}.`,
    data: {
      agent_id: agent.agentId,
      ans_name: agent.ansName,
      host: agent.agentHost,
      status: agent.lifecycle?.status ?? 'UNKNOWN',
    },
    outcome: 'ok',
  });

  const resolvedTransparency = transparencyPayload ?? await fetchJson(
    `${transparencyUrl}/${encodeURIComponent(agent.agentId)}`,
  );

  const event = (resolvedTransparency as {
    payload?: { producer?: { event?: TransparencyEvent } };
    status?: string;
  }).payload?.producer?.event;
  if (!event) throw new Error('The employer has no public ANS transparency event.');

  const endpoint = agent.endpoints?.find((item) => item.protocol === 'A2A') ?? agent.endpoints?.[0];
  step?.({
    from: 'applicant_agent',
    to: 'employer_agent',
    label: 'Show me your published card',
    detail: `Fetched the agent card the employer publishes at ${endpoint?.metaDataUrl ?? 'no registered metadata URL'}, to hold it against what ANS says.`,
    data: { metadata_url: endpoint?.metaDataUrl ?? null, protocol: endpoint?.protocol ?? null },
    outcome: 'ok',
  });
  const publishedCard = await loadPublishedCard(endpoint?.metaDataUrl);
  const cardMatches =
    publishedCard?.name === agent.ansName &&
    publishedCard?.endpoint === endpoint?.agentUrl;
  step?.({
    from: 'employer_agent',
    to: 'applicant_agent',
    label: cardMatches ? 'Card matches its ANS record' : 'Card missing or mismatched',
    detail: cardMatches
      ? `The published card names ${publishedCard?.name} and points at ${publishedCard?.endpoint}, which is what ANS registers for it.`
      : 'The published card was unreachable, or it did not name the same agent and endpoint that ANS registers.',
    data: {
      published_name: publishedCard?.name ?? null,
      published_endpoint: publishedCard?.endpoint ?? null,
      registered_endpoint: endpoint?.agentUrl ?? null,
    },
    outcome: cardMatches ? 'ok' : 'refused',
  });
  const active = agent.lifecycle?.status === 'ACTIVE';
  const validIdentity = certificateIsCurrent(event.attestations?.validIdentityCerts);
  const validServer = certificateIsCurrent(event.attestations?.validServerCerts);
  const domainValidation = event.attestations?.domainValidation ?? '';
  const domainValidated = domainValidation === 'VALID' || domainValidation.startsWith('ACME-');

  const dimensions: TrustDimension[] = [
    {
      name: 'integrity',
      score: active ? 90 : 30,
      reason: active
        ? 'The ANS registry reports an active, transparency-indexed identity.'
        : 'The ANS registry does not report an active identity.',
    },
    {
      name: 'identity',
      score: validIdentity && domainValidated && cardMatches ? 95 : 35,
      reason: validIdentity && domainValidated && cardMatches
        ? 'The domain is validated, the identity certificate is current, and the published agent card matches ANS.'
        : 'The live domain, current identity certificate, and published agent card could not all be matched.',
    },
    {
      name: 'solvency',
      score: active && validServer ? 76 : 40,
      reason: active && validServer
        ? 'The agent maintains an active registration and a current server certificate; no financial claim is inferred.'
        : 'The operational registration evidence is incomplete.',
    },
    {
      name: 'behavior',
      score: cardMatches ? 84 : 40,
      reason: cardMatches
        ? 'The live agent card advertises the same endpoint registered in ANS.'
        : 'The registered metadata endpoint is unavailable or does not match its ANS record.',
    },
    {
      name: 'safety',
      score: validServer && endpoint?.agentUrl?.startsWith('https://') ? 92 : 35,
      reason: validServer && endpoint?.agentUrl?.startsWith('https://')
        ? 'ANS records a current server certificate and an HTTPS-only application endpoint.'
        : 'A current server certificate and HTTPS endpoint were not both verified.',
    },
  ];

  return {
    evidence: {
      agentCard: {
        name: agent.ansName,
        endpoint: endpoint?.agentUrl ?? '',
      },
      certificate: {
        valid: Boolean(active && validIdentity && validServer && domainValidated && cardMatches),
        dns_names: [agent.agentHost],
      },
      trust: { dimensions },
    },
    registry: {
      agent_id: agent.agentId,
      ans_name: agent.ansName,
      status: agent.lifecycle?.status ?? 'UNKNOWN',
      metadata_reachable: Boolean(cardMatches),
    },
  };
}

export async function verifyProductionEmployer(agentId = EMPLOYER_AGENT_ID) {
  const { evidence, registry } = await loadAgentEvidence({
    agentId,
    ansName: EMPLOYER_ANS_NAME,
    expectedRole: 'employer',
  });
  return { ...verifyEmployer(evidence), registry, evidence };
}

export async function verifyProductionAgent(lookup: AgentLookup) {
  const { evidence, registry } = await loadAgentEvidence(lookup);
  return { ...verifyEmployer(evidence), registry, evidence };
}
