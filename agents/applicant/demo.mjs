import { readFile } from "node:fs/promises";
import { MemoryAuditLog } from "../shared/audit.mjs";
import { applyToEmployer } from "./apply.mjs";

const fixtureName = process.argv.includes("--refuse") ? "unverified-employer.json" : "verified-employer.json";
const fixture = JSON.parse(await readFile(new URL(`../fixtures/${fixtureName}`, import.meta.url), "utf8"));
const result = await applyToEmployer({
  ...fixture,
  candidate: {
    full_name: "Demo Candidate",
    email: "candidate@example.com",
    resume_url: "https://candidate.example.com/resume.pdf",
    private_notes: "never release this",
  },
  requestedFields: ["full_name", "email", "resume_url", "private_notes"],
  humanApproved: true,
  audit: new MemoryAuditLog(),
  fetchImpl: async () => ({ ok: true, status: 202 }),
});

console.log(JSON.stringify(result, null, 2));
