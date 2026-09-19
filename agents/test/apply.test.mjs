import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MemoryAuditLog } from "../shared/audit.mjs";
import { applyToEmployer } from "../applicant/apply.mjs";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

const candidate = {
  full_name: "Demo Candidate",
  email: "candidate@example.com",
  resume_url: "https://candidate.example.com/resume.pdf",
  private_notes: "must never leave the applicant agent",
};

test("refusal releases zero PII and never calls the employer", async () => {
  let networkCalls = 0;
  const result = await applyToEmployer({
    ...(await fixture("unverified-employer.json")),
    candidate,
    requestedFields: Object.keys(candidate),
    humanApproved: true,
    audit: new MemoryAuditLog(),
    fetchImpl: async () => { networkCalls += 1; return { ok: true }; },
  });
  assert.equal(result.status, "refused");
  assert.deepEqual(result.fields_released, []);
  assert.equal(networkCalls, 0);
});

test("success requires approval and releases only allowlisted fields", async () => {
  let sentBody;
  const result = await applyToEmployer({
    ...(await fixture("verified-employer.json")),
    candidate,
    requestedFields: Object.keys(candidate),
    humanApproved: true,
    audit: new MemoryAuditLog(),
    fetchImpl: async (_url, options) => { sentBody = JSON.parse(options.body); return { ok: true, status: 202 }; },
  });
  assert.equal(result.status, "submitted");
  assert.deepEqual(result.fields_released, ["full_name", "email", "resume_url"]);
  assert.equal(sentBody.candidate.private_notes, undefined);
});

test("a verified employer still receives no PII without human approval", async () => {
  let networkCalls = 0;
  const result = await applyToEmployer({
    ...(await fixture("verified-employer.json")),
    candidate,
    requestedFields: Object.keys(candidate),
    humanApproved: false,
    audit: new MemoryAuditLog(),
    fetchImpl: async () => { networkCalls += 1; return { ok: true }; },
  });
  assert.equal(result.status, "refused");
  assert.deepEqual(result.fields_released, []);
  assert.equal(networkCalls, 0);
});
