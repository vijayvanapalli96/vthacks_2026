import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryAuditLog } from "../shared/audit.mjs";
import { fill } from "../ats/form-filler.mjs";
import { providerForUrl, splitName } from "../ats/providers.mjs";

/** Minimal Playwright stand-in: records what was typed and whether submit was clicked. */
function fakeBrowser({ present = () => 1 } = {}) {
  const state = { filled: {}, clicked: 0, userAgent: null, screenshots: 0 };
  const locator = (selector) => ({
    first: () => ({
      count: async () => present(selector),
      fill: async (value) => {
        state.filled[selector] = value;
      },
      setInputFiles: async (value) => {
        state.filled[selector] = value;
      },
      click: async () => {
        state.clicked += 1;
      },
    }),
  });
  const factory = async () => ({
    newContext: async ({ userAgent }) => {
      state.userAgent = userAgent;
      return {
        newPage: async () => ({
          goto: async () => {},
          locator,
          screenshot: async () => {
            state.screenshots += 1;
          },
          waitForLoadState: async () => {},
        }),
        close: async () => {},
      };
    },
    close: async () => {},
  });
  return { state, factory };
}

const candidate = {
  full_name: "Demo Candidate",
  email: "candidate@example.com",
  phone: "+1 540 555 0142",
};

test("an unknown ATS is never typed into", async () => {
  const audit = new MemoryAuditLog();
  const record = await fill({
    jobUrl: "https://careers.example.com/apply/9",
    candidate,
    audit,
    browserFactory: () => {
      throw new Error("the browser must not be launched for an unknown ATS");
    },
  });
  assert.equal(record.status, "unsupported_ats");
  assert.equal(record.submitted, false);
  assert.deepEqual(record.fields_filled, []);
});

test("fill prepares the form and does not submit by default", async () => {
  const { state, factory } = fakeBrowser();
  const artifactDir = await mkdtemp(join(tmpdir(), "ats-"));
  const record = await fill({
    jobUrl: "https://jobs.lever.co/acme/1234",
    candidate,
    artifactDir,
    identity: "ans://v1.0.0.applicant.hirewire.biz",
    browserFactory: factory,
  });

  assert.equal(record.status, "prepared");
  assert.equal(record.submitted, false);
  assert.equal(state.clicked, 0, "submit must not be clicked without an explicit flag");
  assert.ok(record.fields_filled.includes("email"));
  assert.match(state.userAgent, /ans:\/\/v1\.0\.0\.applicant\.hirewire\.biz/);
});

test("submit: true is what actually clicks, and it is recorded", async () => {
  const { state, factory } = fakeBrowser();
  const audit = new MemoryAuditLog();
  const artifactDir = await mkdtemp(join(tmpdir(), "ats-"));
  const record = await fill({
    jobUrl: "https://jobs.lever.co/acme/1234",
    candidate,
    submit: true,
    artifactDir,
    audit,
    browserFactory: factory,
  });

  assert.equal(record.status, "submitted");
  assert.equal(state.clicked, 1);
  assert.equal(audit.entries.at(-1).type, "ats_apply_submitted");
});

test("Greenhouse splits the display name into its two inputs", () => {
  assert.equal(providerForUrl("https://boards.greenhouse.io/acme/jobs/1").id, "greenhouse");
  assert.deepEqual(splitName("Demo Candidate"), {
    first_name: "Demo",
    last_name: "Candidate",
    name_split_confidence: "high",
  });
  assert.equal(splitName("Ana Maria de Souza").name_split_confidence, "medium");
});
