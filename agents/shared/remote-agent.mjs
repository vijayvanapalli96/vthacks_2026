import { verifyEmployer } from "./trust-policy.mjs";

const REGISTRY_BASE = "https://api.godaddy.com";
const TRANSPARENCY_BASE = "https://transparency.ans.godaddy.com";

function current(certificates) {
  return Boolean(certificates?.some(({ notAfter }) => Date.parse(notAfter ?? "") > Date.now()));
}

export function hostFromAnsName(ansName) {
  return /^ans:\/\/v\d+\.\d+\.\d+\.(.+)$/i.exec(ansName ?? "")?.[1]?.toLowerCase() ?? null;
}

export async function discoverRemoteAgent({ ansName, host, agentId, expectedRole, fetchImpl = fetch }) {
  const query = ansName ?? host ?? agentId;
  if (!query) throw new Error("An ANS name, host, or agent ID is required.");
  const url = new URL("/v1/ans/registered-agents", REGISTRY_BASE);
  url.searchParams.set("query", query);
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`ANS discovery returned HTTP ${response.status}`);
  const payload = await response.json();
  const match = (payload.items ?? []).find((item) =>
    item.lifecycle?.status === "ACTIVE" &&
    (!agentId || item.agentId === agentId) &&
    (!ansName || item.ansName === ansName) &&
    (!host || item.agentHost?.toLowerCase() === host.toLowerCase()));
  if (!match) return null;
  if (expectedRole && !new RegExp(`^ans://v\\d+\\.\\d+\\.\\d+\\.${expectedRole}\\.`, "i").test(match.ansName)) {
    return null;
  }
  const endpoint = match.endpoints?.find((item) => item.protocol === "A2A") ?? match.endpoints?.[0];
  return { ...match, endpoint };
}

export async function verifyRemoteAgent(input) {
  const { fetchImpl = fetch } = input;
  const agent = await discoverRemoteAgent(input);
  if (!agent) throw new Error("No exact active ANS registration matched the claimed agent.");

  const transparencyResponse = await fetchImpl(
    `${TRANSPARENCY_BASE}/v1/agents/${encodeURIComponent(agent.agentId)}`,
    { headers: { accept: "application/json" } },
  );
  if (!transparencyResponse.ok) throw new Error(`ANS transparency returned HTTP ${transparencyResponse.status}`);
  const transparency = await transparencyResponse.json();
  const event = transparency?.payload?.producer?.event;
  if (!event) throw new Error("The agent has no ANS transparency event.");

  let card = null;
  try {
    const cardResponse = await fetchImpl(agent.endpoint?.metaDataUrl, { headers: { accept: "application/json" } });
    if (cardResponse.ok) card = await cardResponse.json();
  } catch {
    card = null;
  }

  const cardMatches = card?.name === agent.ansName && card?.endpoint === agent.endpoint?.agentUrl;
  const domainValidation = event.attestations?.domainValidation ?? "";
  const domainValidated = domainValidation === "VALID" || domainValidation.startsWith("ACME-");
  const identityCurrent = current(event.attestations?.validIdentityCerts);
  const serverCurrent = current(event.attestations?.validServerCerts);
  const dimensions = [
    { name: "integrity", score: 90, reason: "The ANS registry reports an active, transparency-indexed identity." },
    { name: "identity", score: identityCurrent && domainValidated && cardMatches ? 95 : 35, reason: identityCurrent && domainValidated && cardMatches ? "The domain, identity certificate, and published card match ANS." : "The domain, identity certificate, and published card could not all be matched." },
    { name: "solvency", score: serverCurrent ? 76 : 40, reason: serverCurrent ? "The registration has a current server certificate; no financial claim is inferred." : "The operational certificate evidence is incomplete." },
    { name: "behavior", score: cardMatches ? 84 : 40, reason: cardMatches ? "The live card advertises the endpoint registered in ANS." : "The live card is unavailable or does not match ANS." },
    { name: "safety", score: serverCurrent && agent.endpoint?.agentUrl?.startsWith("https://") ? 92 : 35, reason: serverCurrent && agent.endpoint?.agentUrl?.startsWith("https://") ? "ANS records a current server certificate and HTTPS endpoint." : "A current server certificate and HTTPS endpoint were not both verified." },
  ];
  const evidence = {
    agentCard: { name: agent.ansName, endpoint: agent.endpoint?.agentUrl ?? "" },
    certificate: { valid: Boolean(identityCurrent && serverCurrent && domainValidated && cardMatches), dns_names: [agent.agentHost] },
    trust: { dimensions },
  };
  // The fingerprints a signed envelope's certificate must match (signed-envelope.mjs).
  const identityFingerprints = (event.attestations?.validIdentityCerts ?? [])
    .filter(({ notAfter }) => Date.parse(notAfter ?? "") > Date.now())
    .map(({ fingerprint }) => fingerprint)
    .filter(Boolean);
  return { ...verifyEmployer(evidence), evidence, agent, identityFingerprints };
}
