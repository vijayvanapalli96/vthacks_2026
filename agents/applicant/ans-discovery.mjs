const DEFAULT_REGISTRY = "https://api.godaddy.com";

export async function discoverAgentByHost(host, {
  fetchImpl = fetch,
  registryBaseUrl = DEFAULT_REGISTRY,
} = {}) {
  const normalizedHost = String(host).trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedHost)) {
    throw new Error("A valid agent hostname is required.");
  }

  const url = new URL("/v1/ans/registered-agents", registryBaseUrl);
  url.searchParams.set("query", normalizedHost);
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`ANS discovery returned HTTP ${response.status}`);

  const payload = await response.json();
  const matches = (payload.items ?? []).filter(
    (item) => item.agentHost?.toLowerCase() === normalizedHost && item.lifecycle?.status === "ACTIVE",
  );
  if (!matches.length) return null;

  matches.sort((left, right) => String(right.indexedAt).localeCompare(String(left.indexedAt)));
  const agent = matches[0];
  const a2aEndpoint = agent.endpoints?.find((endpoint) => endpoint.protocol === "A2A") ?? agent.endpoints?.[0];
  return {
    agent_id: agent.agentId,
    ans_name: agent.ansName,
    host: agent.agentHost,
    version: agent.agentVersion,
    lifecycle_status: agent.lifecycle.status,
    endpoint: a2aEndpoint?.agentUrl ?? null,
    metadata_url: a2aEndpoint?.metaDataUrl ?? null,
    registry_trust_score: agent.scores?.trustScore ?? null,
    indexed_at: agent.indexedAt,
  };
}

export { DEFAULT_REGISTRY };
