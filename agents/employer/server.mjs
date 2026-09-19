import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { verifyRemoteAgent } from "../shared/remote-agent.mjs";
import { explainMutualMatch } from "../shared/mutual-match.mjs";
import { createReplayGuard, peekIssuer, verifyEnvelope } from "../shared/signed-envelope.mjs";

const port = Number(process.env.PORT ?? 8787);
const replayGuard = createReplayGuard();
const card = JSON.parse(await readFile(new URL("./agent-card.json", import.meta.url), "utf8"));
if (process.env.EMPLOYER_ANS_NAME) card.name = process.env.EMPLOYER_ANS_NAME;
if (process.env.EMPLOYER_ENDPOINT_URL) card.endpoint = process.env.EMPLOYER_ENDPOINT_URL;

// Public metadata (index, card, health) may be read from any origin. The A2A
// endpoint is server-to-server, so it grants no CORS access at all.
function send(response, status, value, { publicRead = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (publicRead) headers["access-control-allow-origin"] = "*";
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

const index = {
  status: "ok",
  agent: card.name,
  display_name: card.display_name,
  agent_card: "/.well-known/agent-card.json",
  a2a_endpoint: card.endpoint,
  health: "/health",
};

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") return send(response, 200, index, { publicRead: true });
  if (request.method === "GET" && request.url === "/.well-known/agent-card.json") return send(response, 200, card, { publicRead: true });
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok" }, { publicRead: true });
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
      return send(response, 202, {
        status: "accepted",
        receipt_id: randomUUID(),
        applicant_verification: verification,
        applicant_explanation: packet.match_explanation ?? null,
        employer_explanation: employerMatch,
      });
    } catch (error) {
      return send(response, 403, { status: "refused", reason: error instanceof Error ? error.message : "Applicant verification failed." });
    }
  }
  return send(response, 404, { status: "not_found" });
}).listen(port, () => console.log(`Employer agent listening on http://localhost:${port}`));
