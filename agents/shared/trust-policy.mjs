export const TRUST_DIMENSIONS = [
  "integrity",
  "identity",
  "solvency",
  "behavior",
  "safety",
];

export const DEFAULT_POLICY = Object.freeze({
  minimumDimensionScore: 65,
  minimumAverageScore: 75,
});

function domainFromAgentName(agentName) {
  const match = /^ans:\/\/v\d+\.\d+\.\d+\.(.+)$/i.exec(agentName ?? "");
  return match?.[1]?.toLowerCase() ?? null;
}

function hostnameMatchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function verifyEmployer({ agentCard, certificate, trust, policy = DEFAULT_POLICY }) {
  const failures = [];
  const agentDomain = domainFromAgentName(agentCard?.name);
  let endpoint;

  try {
    endpoint = new URL(agentCard?.endpoint);
  } catch {
    failures.push("The employer endpoint is not a valid URL.");
  }

  if (!agentDomain) failures.push("The employer does not have a versioned ANS name.");
  if (endpoint?.protocol !== "https:") failures.push("The employer endpoint is not HTTPS.");
  if (endpoint && agentDomain && !hostnameMatchesDomain(endpoint.hostname, agentDomain)) {
    failures.push("The endpoint hostname does not match the ANS domain.");
  }

  const dnsNames = Array.isArray(certificate?.dns_names)
    ? certificate.dns_names.map((value) => String(value).toLowerCase())
    : [];
  if (!certificate?.valid || !endpoint || !dnsNames.some((name) => hostnameMatchesDomain(endpoint.hostname, name))) {
    failures.push("No valid identity certificate binds the endpoint to its domain.");
  }

  const supplied = new Map((trust?.dimensions ?? []).map((item) => [item.name, item]));
  const dimensions = TRUST_DIMENSIONS.map((name) => {
    const item = supplied.get(name);
    const score = Number(item?.score);
    const reason = typeof item?.reason === "string" ? item.reason.trim() : "";
    if (!Number.isInteger(score) || score < 0 || score > 100 || !reason) {
      failures.push(`Trust dimension ${name} is missing a valid score and reason.`);
    } else if (score < policy.minimumDimensionScore) {
      failures.push(`Trust dimension ${name} is below policy.`);
    }
    return { name, score: Number.isFinite(score) ? score : 0, reason: reason || "No evidence supplied." };
  });

  const average = dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length;
  if (average < policy.minimumAverageScore) failures.push("The aggregate trust score is below policy.");

  const verdict = failures.length === 0 ? "pass" : "refuse";
  return {
    verdict,
    dimensions,
    spoken_reason:
      verdict === "pass"
        ? `Verified ${agentCard.name}. All five trust checks passed with an average score of ${Math.round(average)} percent.`
        : `Application blocked. ${failures.join(" ")}`,
    checked_at: new Date().toISOString(),
  };
}

export { domainFromAgentName };
