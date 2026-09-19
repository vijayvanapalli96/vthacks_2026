import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyRemoteAgent } from "../shared/remote-agent.mjs";
import { createReplayGuard, peekIssuer, verifyEnvelope } from "../shared/signed-envelope.mjs";

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
  return send(response, 404, { status: "not_found" });
}).listen(port, () => console.log(`Applicant agent listening on http://localhost:${port}`));
