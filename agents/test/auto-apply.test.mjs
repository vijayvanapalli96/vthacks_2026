import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAuditLog } from "../shared/audit.mjs";
import { plan, submit } from "../applicant/auto-apply.mjs";

const candidate = {
  full_name: "Demo Candidate",
  email: "candidate@example.com",
  resume_url: "https://candidate.example.com/resume.pdf",
  private_notes: "must never leave the applicant agent",
};

function passingEvidence(name) {
  return {
    agentCard: { name, endpoint: `https://${name.replace(/^ans:\/\/v[\d.]+\./, "")}/a2a/apply` },
    certificate: { valid: true, dns_names: [name.replace(/^ans:\/\/v[\d.]+\.employer\./, "employer.")] },
    trust: {
      dimensions: [
        { name: "integrity", score: 90, reason: "Active ANS registration." },
        { name: "identity", score: 95, reason: "Domain, cert and card match." },
        { name: "solvency", score: 76, reason: "Current server certificate." },
        { name: "behavior", score: 84, reason: "Card advertises the registered endpoint." },
        { name: "safety", score: 92, reason: "HTTPS endpoint with a current certificate." },
      ],
    },
  };
}

test("a plan contacts no employer and releases no PII", async () => {
  let posts = 0;
  const audit = new MemoryAuditLog();
  const result = await plan({
    jobs: [
      { job_id: "j1", employer_ans_name: "ans://v1.0.0.employer.hirewire.biz" },
      { job_id: "j2", employer_ans_name: null, job_url: "https://jobs.lever.co/acme/1" },
    ],
    audit,
    fetchImpl: async () => {
      posts += 1;
      throw new Error("registry unavailable");
    },
  });

  assert.equal(result.entries.length, 2);
  for (const entry of result.entries) assert.deepEqual(entry.fields_released, []);
  assert.equal(result.entries[1].decision, "no_a2a_route");
  // The only network the planner does is discovery; it never POSTs an application.
  assert.ok(posts > 0);
  assert.equal(audit.entries.at(-1).payload.fields_released.length, 0);
});

test("submit refuses to run without an explicit approval set", async () => {
  await assert.rejects(
    () => submit({ plan: { entries: [] }, candidate, audit: new MemoryAuditLog() }),
    /no approve-all default/,
  );
});

test("approval cannot upgrade a refusal", async () => {
  let posts = 0;
  const reviewed = {
    entries: [
      {
        job_id: "j1",
        decision: "refused",
        fields_released: [],
        spoken_reason: "Application blocked. The endpoint hostname does not match the ANS domain.",
        requested_fields: ["full_name", "email"],
      },
    ],
  };
  const { results } = await submit({
    plan: reviewed,
    approvedJobIds: ["j1"], // the human approved it anyway
    candidate,
    audit: new MemoryAuditLog(),
    fetchImpl: async () => {
      posts += 1;
      return { ok: true };
    },
  });

  assert.equal(results[0].status, "refused");
  assert.deepEqual(results[0].fields_released, []);
  assert.equal(posts, 0);
});

test("only approved entries are applied to, and only allowlisted fields leave", async () => {
  const sent = [];
  const reviewed = {
    entries: [
      {
        job_id: "j1",
        decision: "pending_confirm",
        requested_fields: ["full_name", "email", "resume_url", "private_notes"],
        evidence: passingEvidence("ans://v1.0.0.employer.hirewire.biz"),
      },
      {
        job_id: "j2",
        decision: "pending_confirm",
        requested_fields: ["full_name", "email"],
        evidence: passingEvidence("ans://v1.0.0.employer.hirewire.biz"),
      },
    ],
  };

  const { results } = await submit({
    plan: reviewed,
    approvedJobIds: ["j1"],
    candidate,
    audit: new MemoryAuditLog(),
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return { ok: true, status: 202 };
    },
  });

  assert.equal(results.find((r) => r.job_id === "j1").status, "submitted");
  assert.equal(results.find((r) => r.job_id === "j2").status, "skipped");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].candidate.private_notes, undefined);
});
