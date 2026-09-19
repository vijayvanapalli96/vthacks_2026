import assert from "node:assert/strict";
import test from "node:test";
import { discoverAgentByHost } from "../applicant/ans-discovery.mjs";

test("discovers an exact active host through the public ANS search endpoint", async () => {
  let requestedUrl;
  const result = await discoverAgentByHost("employer.example.com", {
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              agentId: "agent-123",
              ansName: "ans://v1.0.0.employer.example.com",
              agentHost: "employer.example.com",
              agentVersion: "v1.0.0",
              indexedAt: "2026-09-19T00:00:00Z",
              lifecycle: { status: "ACTIVE" },
              scores: { trustScore: 88 },
              endpoints: [{ protocol: "A2A", agentUrl: "https://employer.example.com/a2a/apply", metaDataUrl: "https://employer.example.com/.well-known/agent-card.json" }],
            },
          ],
        }),
      };
    },
  });

  assert.equal(requestedUrl.pathname, "/v1/ans/registered-agents");
  assert.equal(requestedUrl.searchParams.get("query"), "employer.example.com");
  assert.equal(result.agent_id, "agent-123");
  assert.equal(result.endpoint, "https://employer.example.com/a2a/apply");
});

test("does not accept a fuzzy or inactive registry result", async () => {
  const result = await discoverAgentByHost("employer.example.com", {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ items: [{ agentHost: "other.example.com", lifecycle: { status: "ACTIVE" } }] }),
    }),
  });
  assert.equal(result, null);
});
