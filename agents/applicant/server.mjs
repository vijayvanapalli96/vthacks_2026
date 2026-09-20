import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyRemoteAgent } from "../shared/remote-agent.mjs";
import { createReplayGuard, peekIssuer, verifyEnvelope } from "../shared/signed-envelope.mjs";
import { REQUESTABLE } from "../shared/screening.mjs";

const port = Number(process.env.PORT ?? 8788);
const replayGuard = createReplayGuard();
const card = JSON.parse(await readFile(new URL("./agent-card.json", import.meta.url), "utf8"));

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(value));
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/.well-known/agent-card.json") return send(response, 200, card);
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok" });
  if (request.method === "POST" && request.url === "/a2a/apply") {
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const jws = JSON.parse(body)?.jws;
      if (!jws) {
        return send(response, 403, { status: "refused", reason: "A signed invitation from an ANS employer agent is required." });
      }
      const issuer = peekIssuer(jws);
      const verification = await verifyRemoteAgent({ ansName: issuer, expectedRole: "employer" });
      if (verification.verdict !== "pass") {
        return send(response, 403, { status: "refused", reason: verification.spoken_reason, verification });
      }
      // Proves the named employer sent this, to us, exactly once. Throws otherwise.
      const invitation = verifyEnvelope(jws, {
        expectedIssuer: issuer,
        audience: card.name,
        attestedFingerprints: verification.identityFingerprints,
        replayGuard,
      });
      if (!invitation.job_id || !invitation.message) {
        return send(response, 400, { status: "invalid_request" });
      }
      return send(response, 202, {
        status: "pending_candidate_approval",
        receipt_id: randomUUID(),
        employer_verification: verification,
        employer_explanation: invitation.match_explanation ?? null,
      });
    } catch (error) {
      return send(response, 403, { status: "refused", reason: error instanceof Error ? error.message : "Employer verification failed." });
    }
  }
  /**
   * POST /a2a/request — the employer agent asks for something. This answers.
   *
   * The employer's screen (agents/shared/screening.mjs) asks for the resume
   * first, and for evidence of any required skill the application did not
   * carry. This is the applicant's side of that conversation.
   *
   * IT ANSWERS FROM THE HOLDINGS THE EMPLOYER WAS ALREADY GIVEN, AND FROM
   * NOTHING ELSE. The envelope the employer signs carries back the packet it
   * received, so this agent can confirm what was released and say plainly when
   * something was not. It holds no private store to reach into, which is the
   * point: the candidate decided what left, on the approval page, and an agent
   * that could top that up on request would make that decision meaningless.
   *
   * "NO" IS A COMPLETE ANSWER. If no resume was released, this says so, once,
   * without offering a substitute and without inventing a URL. Hard rule 3 is
   * about PII never moving before verification; this is the same instinct one
   * step later — nothing moves that the human did not tick.
   */
  if (request.method === "POST" && request.url === "/a2a/request") {
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const jws = JSON.parse(body)?.jws;
      if (!jws) {
        return send(response, 403, { status: "refused", reason: "A signed request from an ANS employer agent is required." });
      }
      const issuer = peekIssuer(jws);
      const verification = await verifyRemoteAgent({ ansName: issuer, expectedRole: "employer" });
      if (verification.verdict !== "pass") {
        return send(response, 403, { status: "refused", reason: verification.spoken_reason, verification });
      }
      const ask = verifyEnvelope(jws, {
        expectedIssuer: issuer,
        audience: card.name,
        attestedFingerprints: verification.identityFingerprints,
        replayGuard,
      });

      const held = ask.holdings ?? {};
      const answers = [];
      for (const item of Array.isArray(ask.requests) ? ask.requests : []) {
        const field = typeof item?.field === "string" ? item.field : "";
        if (!REQUESTABLE.has(field)) {
          answers.push({ field, provided: false, reason: "This agent does not answer that." });
          continue;
        }
        const value = held[field];
        const present = typeof value === "string" ? value.trim() !== "" : Array.isArray(value) ? value.length > 0 : false;
        answers.push(
          present
            ? { field, provided: true, value, reason: "Released by the candidate with the original application." }
            : {
                field,
                provided: false,
                reason:
                  field === "resume_url"
                    ? "No. The candidate did not release a resume with this application, and this agent cannot add one on their behalf."
                    : "No. That was not part of what the candidate approved for release.",
              },
        );
      }

      const resume = answers.find((answer) => answer.field === "resume_url");
      return send(response, 200, {
        status: "answered",
        receipt_id: randomUUID(),
        employer_verification: verification,
        answers,
        // One line the app can read out, so a spoken demo does not have to
        // narrate an array.
        spoken_reason: resume
          ? resume.provided
            ? "Yes, a resume was released with the application and this agent confirmed it."
            : "No. The candidate did not release a resume, and this agent will not add one on their behalf."
          : `Answered ${answers.length} request${answers.length === 1 ? "" : "s"} from what the candidate released.`,
      });
    } catch (error) {
      return send(response, 403, { status: "refused", reason: error instanceof Error ? error.message : "Employer verification failed." });
    }
  }

  return send(response, 404, { status: "not_found" });
}).listen(port, () => console.log(`Applicant agent listening on http://localhost:${port}`));
