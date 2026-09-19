/**
 * attack-battery.mjs — the evidence behind the threat-model slide.
 *
 * Webmesh's fraud agent cannot be pointed at us: its battery only attacks its
 * own payment supplier, and its one targetable probe refuses any host outside
 * FRAUD_TARGET_ALLOWLIST. So this reproduces the same threat classes against
 * OUR employer agent — forged signatures, replays, swapped audiences, stale and
 * rewritten messages — and asserts every one is refused while a genuine signed
 * application is still accepted.
 *
 *   node attack-battery.mjs            # against employer.hirewire.biz
 *   TARGET=https://host/a2a/apply node attack-battery.mjs
 *
 * Needs the gitignored certs/ directory (applicant + employer identity keys).
 */
import { readFileSync } from "node:fs";
import { signEnvelope } from "./shared/signed-envelope.mjs";

const TARGET = process.env.TARGET ?? "https://employer.hirewire.biz/a2a/apply";
const EMPLOYER = "ans://v1.0.0.employer.hirewire.biz";
const APPLICANT = "ans://v1.0.0.applicant.hirewire.biz";
const identity = (who) => ({
  privateKeyPem: readFileSync(new URL(`../certs/${who}/identity.key`, import.meta.url), "utf8"),
  certificatePem: readFileSync(new URL(`../certs/${who}/identity.crt.pem`, import.meta.url), "utf8"),
});
const applicant = identity("applicant");
const employer = identity("employer");
const payload = { candidate: { full_name: "Security probe" }, job: { job_id: "security-probe" } };
const envelope = (keys, over = {}) =>
  signEnvelope({ issuer: APPLICANT, audience: EMPLOYER, payload, ...keys, ...over });

async function post(body) {
  const response = await fetch(TARGET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, why: json.reason ?? json.status ?? "" };
}

const probes = [
  ["control: genuine signed application", "accept", () => post({ jws: envelope(applicant) })],
  ["unsigned application", "block", () => post(payload)],
  ["claims our name, no signature", "block", () => post({ applicant_agent: APPLICANT, ...payload })],
  ["impersonation with another ANS key", "block", () => post({ jws: envelope(employer) })],
  ["employer agent applying as a candidate", "block", () => post({ jws: envelope(employer, { issuer: EMPLOYER }) })],
  ["sender not registered in ANS", "block", () => post({ jws: envelope(applicant, { issuer: "ans://v1.0.0.applicant.fraud.webmesh.ai" }) })],
  ["lookalike registry name", "block", () => post({ jws: envelope(applicant, { issuer: "ans://v1.0.13.agent.webmesh.ai" }) })],
  ["replay of a genuine application", "block", async () => { const jws = envelope(applicant); await post({ jws }); return post({ jws }); }],
  ["addressed to a different employer", "block", () => post({ jws: envelope(applicant, { audience: "ans://v1.0.0.employer.example.com" }) })],
  ["contents rewritten after signing", "block", () => {
    const [header, , signature] = envelope(applicant).split(".");
    const now = Math.floor(Date.now() / 1000);
    const forged = Buffer.from(JSON.stringify({ iss: APPLICANT, aud: EMPLOYER, jti: "tamper", iat: now, exp: now + 60, candidate: { full_name: "Someone else" } })).toString("base64url");
    return post({ jws: `${header}.${forged}.${signature}` });
  }],
  ["signed ten minutes ago", "block", () => post({ jws: envelope(applicant, { now: Date.now() - 600_000 }) })],
  ["dated ten minutes ahead", "block", () => post({ jws: envelope(applicant, { now: Date.now() + 600_000 }) })],
  ["malformed body", "block", () => post("{not json")],
  ["plain HTTP downgrade", "block", async () => {
    const response = await fetch(TARGET.replace("https://", "http://"), { method: "POST", redirect: "manual", body: "{}" });
    return { status: response.status, why: `redirects to ${response.headers.get("location")}` };
  }],
];

let blocked = 0;
let attacks = 0;
let controlOk = false;
for (const [label, expect, run] of probes) {
  const { status, why } = await run();
  const accepted = status === 202;
  if (expect === "accept") {
    controlOk = accepted;
    console.log(`${accepted ? "ACCEPTED  " : "BROKEN    "} [${status}] ${label}`);
  } else {
    attacks += 1;
    if (!accepted) blocked += 1;
    console.log(`${accepted ? "VULNERABLE" : "BLOCKED   "} [${status}] ${label}${why ? ` — ${why}` : ""}`);
  }
}
console.log(`\n${blocked}/${attacks} attacks blocked; genuine application ${controlOk ? "accepted" : "WRONGLY REFUSED"}`);
process.exit(blocked === attacks && controlOk ? 0 : 1);
