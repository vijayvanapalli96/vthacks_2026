// ATS worker service.
//
// Runs on the Vultr box next to the employer and applicant agents so the browser
// work happens on a host with a stable, ANS-registered identity rather than on
// whichever laptop is open.
//
// DELIBERATELY NOT PUBLIC. The employer and applicant agents are exposed through
// Caddy because ANS has to reach them. This one is not: a public endpoint that
// drives a headless browser at a URL you hand it is an open proxy, and would let
// a stranger use hirewire.biz's registered identity to fill forms. It listens on
// the compose network only and additionally requires a shared secret, so that a
// second mistake is needed before it is reachable rather than one.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { HashChainAuditLog } from "../shared/audit.mjs";
import { discover, fill } from "./form-filler.mjs";

const PORT = Number(process.env.ATS_WORKER_PORT ?? 8789);
const TOKEN = process.env.ATS_WORKER_TOKEN ?? "";
const audit = new HashChainAuditLog(process.env.AUDIT_LOG_PATH ?? "./audit/events.jsonl");

function authorized(request) {
  if (!TOKEN) return false;
  const supplied = String(request.headers["x-ats-token"] ?? "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    // A posting payload is small; anything larger is not a legitimate request.
    if (chunks.reduce((n, c) => n + c.length, 0) > 512_000) throw new Error("payload too large");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return json(response, 200, { status: "ok", service: "ats-worker" });
  }

  const isDiscover = request.method === "POST" && request.url === "/ats/discover";
  const isPrepare = request.method === "POST" && request.url === "/ats/prepare";
  if (!isDiscover && !isPrepare) {
    return json(response, 404, { error: "not found" });
  }

  if (!authorized(request)) {
    // No detail about why — an unauthenticated caller learns only that it failed.
    return json(response, 401, { error: "unauthorized" });
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return json(response, 400, { error: error.message });
  }

  // DISCOVERY IS READ-ONLY: open the page, read the form, close it. The app needs
  // it because an Ashby application form exists only in the browser — the served
  // HTML has no inputs at all — so this is the only place the real field list can
  // be obtained before asking a model what belongs in each box.
  if (isDiscover) {
    if (!body.job_url) return json(response, 400, { error: "job_url is required" });
    try {
      const found = await discover({ jobUrl: body.job_url });
      await audit?.append("ats_fields_discovered", {
        job_url: body.job_url,
        field_count: found.fields.length,
      });
      return json(response, 200, found);
    } catch (error) {
      return json(response, 502, { error: `could not read the form: ${error.message}` });
    }
  }

  if (!body.job_url || !body.candidate) {
    return json(response, 400, { error: "job_url and candidate are required" });
  }

  try {
    const record = await fill({
      jobUrl: body.job_url,
      candidate: body.candidate,
      // The per-field plan from the app's Gemini pass. Absent is fine: the
      // provider's own selector table still fills the standard boxes.
      planned: Array.isArray(body.planned) ? body.planned : [],
      // The service will submit, but only when the CALLER says so explicitly and
      // the deployment has not been pinned to review-only. ATS_ALLOW_SUBMIT is
      // the kill switch: unset, this box can never send an application, whatever
      // any caller asks for.
      submit: body.submit === true && process.env.ATS_ALLOW_SUBMIT === "true",
      identity: process.env.APPLICANT_ANS_NAME ?? null,
      artifactDir: process.env.ATS_ARTIFACT_DIR ?? "/app/work/ats",
      audit,
    });

    if (body.submit === true && !record.submitted && process.env.ATS_ALLOW_SUBMIT !== "true") {
      record.spoken_reason =
        "The form was prepared but not submitted: this worker is deployed in review-only mode.";
    }
    return json(response, 200, record);
  } catch (error) {
    await audit.append("ats_apply_failed", { job_url: body.job_url, error: error.message });
    return json(response, 502, { error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const mode = process.env.ATS_ALLOW_SUBMIT === "true" ? "SUBMIT ENABLED" : "review-only";
  console.log(`ats-worker listening on ${PORT} (${mode})`);
  if (!TOKEN) console.warn("ATS_WORKER_TOKEN is unset — every request will be rejected.");
});
