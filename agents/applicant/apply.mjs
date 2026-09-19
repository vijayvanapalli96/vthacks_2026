import { verifyEmployer } from "../shared/trust-policy.mjs";

const ALLOWED_FIELDS = new Set(["full_name", "email", "resume_url", "cover_letter"]);

export async function applyToEmployer({
  agentCard,
  certificate,
  trust,
  candidate,
  requestedFields,
  humanApproved,
  audit,
  fetchImpl = fetch,
}) {
  const verification = verifyEmployer({ agentCard, certificate, trust });
  const releasable = requestedFields.filter((field) => ALLOWED_FIELDS.has(field));

  if (verification.verdict !== "pass" || !humanApproved) {
    const spokenReason = verification.verdict !== "pass"
      ? verification.spoken_reason
      : "Application blocked until the candidate approves the exact fields to release.";
    const event = await audit.append("application_refused", {
      employer: agentCard?.name,
      fields_released: [],
      reason: spokenReason,
    });
    return { status: "refused", fields_released: [], audit_id: event.id, spoken_reason: spokenReason };
  }

  const packet = Object.fromEntries(releasable.map((field) => [field, candidate[field]]));
  const response = await fetchImpl(agentCard.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ applicant_agent: process.env.APPLICANT_ANS_NAME, candidate: packet, verification }),
  });
  if (!response.ok) throw new Error(`Employer agent returned HTTP ${response.status}`);

  const event = await audit.append("application_submitted", {
    employer: agentCard.name,
    fields_released: releasable,
  });
  return {
    status: "submitted",
    fields_released: releasable,
    audit_id: event.id,
    spoken_reason: `Application submitted to verified employer ${agentCard.name}.`,
  };
}
