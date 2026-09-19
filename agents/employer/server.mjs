import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const port = Number(process.env.PORT ?? 8787);
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
      const packet = JSON.parse(body);
      if (packet?.verification?.verdict !== "pass") {
        return send(response, 403, { status: "refused", reason: "A passing verification result is required." });
      }
      return send(response, 202, { status: "accepted", receipt_id: randomUUID() });
    } catch {
      return send(response, 400, { status: "invalid_request" });
    }
  }
  return send(response, 404, { status: "not_found" });
}).listen(port, () => console.log(`Employer agent listening on http://localhost:${port}`));
