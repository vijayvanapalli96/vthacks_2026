// Batch driver over the single-job apply path.
//
// The only thing this adds to apply.mjs is FAN-OUT and a HOLDING PEN. It
// deliberately does not add an "approve everything" shortcut: hard rule 3 says
// no PII moves before a human confirm, and a batch of one hundred is still a
// batch of one hundred separate confirms as far as that rule is concerned. What
// a human gets to do here is approve a *reviewed list* in one gesture, not skip
// the review.
//
// Shape:
//   plan()   — verify every candidate employer, release nothing, no network POST
//   submit() — take the plan plus an explicit approval set, apply to those only
//
// plan() is safe to run unattended (cron, queue worker). submit() is not.

import { verifyRemoteAgent } from "../shared/remote-agent.mjs";
import { applyToEmployer } from "./apply.mjs";

/** Fields the applicant agent is ever willing to release, mirroring apply.mjs. */
const DEFAULT_REQUESTED_FIELDS = ["full_name", "email", "resume_url", "cover_letter"];

/**
 * Verify a batch of employers and return a reviewable plan.
 *
 * Nothing in here contacts an employer's apply endpoint and nothing reads the
 * candidate's PII — a plan is built purely from ANS/transparency evidence, so a
 * leaked plan file discloses nothing about the applicant.
 */
export async function plan({
  jobs,
  requestedFields = DEFAULT_REQUESTED_FIELDS,
  audit,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
}) {
  const entries = [];

  for (const job of jobs) {
    const base = {
      job_id: job.job_id,
      job_url: job.job_url ?? null,
      employer_ans_name: job.employer_ans_name ?? null,
      requested_fields: requestedFields,
      planned_at: now(),
    };

    if (!job.employer_ans_name) {
      // No ANS name means the A2A path does not apply to this posting at all.
      // It is not a refusal by the employer — it is a routing miss, and the ATS
      // worker is the only lane that could carry it.
      entries.push({
        ...base,
        decision: "no_a2a_route",
        fields_released: [],
        spoken_reason:
          "This posting has no registered agent, so there is no verified channel to apply through.",
      });
      continue;
    }

    let verification;
    try {
      verification = await verifyRemoteAgent({
        ansName: job.employer_ans_name,
        expectedRole: "employer",
        fetchImpl,
      });
    } catch (error) {
      entries.push({
        ...base,
        decision: "refused",
        fields_released: [],
        spoken_reason: `Application blocked. ${error.message}`,
      });
      continue;
    }

    entries.push({
      ...base,
      decision: verification.verdict === "pass" ? "pending_confirm" : "refused",
      fields_released: [],
      dimensions: verification.dimensions,
      spoken_reason: verification.spoken_reason,
      // Carried forward so submit() does not have to re-resolve and risk
      // applying against evidence the human never saw.
      evidence: verification.evidence,
    });
  }

  if (audit) {
    await audit.append("auto_apply_planned", {
      total: entries.length,
      pending_confirm: entries.filter((entry) => entry.decision === "pending_confirm").length,
      refused: entries.filter((entry) => entry.decision === "refused").length,
      no_a2a_route: entries.filter((entry) => entry.decision === "no_a2a_route").length,
      fields_released: [],
    });
  }

  return { entries, planned_at: now() };
}

/**
 * Apply to the approved subset of a plan.
 *
 * `approvedJobIds` is required and must be an explicit collection. Passing every
 * id is the caller's right; defaulting to it is not something this function will
 * do on their behalf, so there is no "approve all" flag here.
 */
export async function submit({
  plan: reviewedPlan,
  approvedJobIds,
  candidate,
  audit,
  fetchImpl = fetch,
}) {
  if (!approvedJobIds) {
    throw new Error("An explicit set of approved job IDs is required; there is no approve-all default.");
  }
  const approved = new Set(approvedJobIds);
  const results = [];

  for (const entry of reviewedPlan.entries) {
    if (entry.decision !== "pending_confirm") {
      // A refusal in the plan stays a refusal. Approval cannot upgrade it:
      // the human is confirming a verified employer, not overriding the gate.
      results.push({
        job_id: entry.job_id,
        status: "refused",
        fields_released: [],
        spoken_reason: entry.spoken_reason,
      });
      continue;
    }

    if (!approved.has(entry.job_id)) {
      results.push({
        job_id: entry.job_id,
        status: "skipped",
        fields_released: [],
        spoken_reason: "The candidate did not approve this employer in the reviewed batch.",
      });
      continue;
    }

    const outcome = await applyToEmployer({
      ...entry.evidence,
      candidate,
      requestedFields: entry.requested_fields,
      humanApproved: true,
      audit,
      fetchImpl,
    });
    results.push({ job_id: entry.job_id, ...outcome });
  }

  return { results };
}

export { DEFAULT_REQUESTED_FIELDS };
