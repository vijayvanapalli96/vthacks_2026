import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyRemoteAgent } from "../shared/remote-agent.mjs";
import { explainMutualMatch } from "../shared/mutual-match.mjs";
import { screen } from "../shared/screening.mjs";
import { createReplayGuard, peekIssuer, verifyEnvelope } from "../shared/signed-envelope.mjs";

const port = Number(process.env.PORT ?? 8787);
const replayGuard = createReplayGuard();
const card = JSON.parse(await readFile(new URL("./agent-card.json", import.meta.url), "utf8"));
if (process.env.EMPLOYER_ANS_NAME) card.name = process.env.EMPLOYER_ANS_NAME;
if (process.env.EMPLOYER_ENDPOINT_URL) card.endpoint = process.env.EMPLOYER_ENDPOINT_URL;

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
        return send(response, 403, { status: "refused", reason: "A signed application from an ANS applicant agent is required." });
      }
      const issuer = peekIssuer(jws);
      const verification = await verifyRemoteAgent({ ansName: issuer, expectedRole: "applicant" });
      if (verification.verdict !== "pass") {
        return send(response, 403, { status: "refused", reason: verification.spoken_reason, verification });
      }
      // Proves the named agent sent this, to us, exactly once. Throws otherwise.
      const packet = verifyEnvelope(jws, {
        expectedIssuer: issuer,
        audience: card.name,
        attestedFingerprints: verification.identityFingerprints,
        replayGuard,
      });
      const employerMatch = explainMutualMatch({
        candidateSkills: packet.candidate?.skills,
        requiredSkills: packet.job?.required_skills,
        preferredSkills: packet.job?.preferred_skills,
      });

      /**
       * A REAL SCREEN, NOT A HANDSHAKE.
       *
       * This used to answer "accepted" to everything that verified. It now
       * checks the application against the ROLE'S OWN prerequisites, and when
       * something is missing it says what and why instead of accepting silently.
       * The first thing it asks for is the resume, because that is the document
       * a human screener opens first and the packet carries only the fields the
       * candidate chose to release.
       */
      const screening = screen({
        candidate: packet.candidate,
        job: packet.job,
        match: employerMatch,
      });

      // 202 for anything still alive, 200 for a decline. Neither is an error:
      // an employer asking for a document is the system working.
      return send(response, screening.verdict === "declined" ? 200 : 202, {
        status: screening.verdict,
        receipt_id: randomUUID(),
        applicant_verification: verification,
        applicant_explanation: packet.match_explanation ?? null,
        employer_explanation: employerMatch,
        // What the employer still needs, each item with the reason it needs it.
        requests: screening.requests,
        prerequisites: screening.prerequisites,
        resume_attached: screening.resume_attached,
        spoken_reason: screening.spoken_reason,
      });
    } catch (error) {
      return send(response, 403, { status: "refused", reason: error instanceof Error ? error.message : "Applicant verification failed." });
    }
  }
  return send(response, 404, { status: "not_found" });
}).listen(port, () => console.log(`Employer agent listening on http://localhost:${port}`));
