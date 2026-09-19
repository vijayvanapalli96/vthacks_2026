import assert from "node:assert/strict";
import test from "node:test";
import { discoverRemoteAgent, verifyRemoteAgent } from "../shared/remote-agent.mjs";

const registeredAgent = {
  agentId: "applicant-123",
  ansName: "ans://v1.0.0.applicant.example.com",
  agentHost: "applicant.example.com",
  agentVersion: "v1.0.0",
  lifecycle: { status: "ACTIVE" },
  endpoints: [{
    protocol: "A2A",
    agentUrl: "https://applicant.example.com/a2a/apply",
    metaDataUrl: "https://applicant.example.com/.well-known/agent-card.json",
  }],
};

function mockFetch(url) {
  const value = String(url);
  if (value.includes("registered-agents")) return Promise.resolve({ ok: true, json: async () => ({ items: [registeredAgent] }) });
  if (value.includes("transparency.ans.godaddy.com")) return Promise.resolve({
    ok: true,
    json: async () => ({ payload: { producer: { event: { attestations: {
      domainValidation: "ACME-DNS-01",
      validIdentityCerts: [{ notAfter: "2030-01-01T00:00:00Z" }],
      validServerCerts: [{ notAfter: "2030-01-01T00:00:00Z" }],
    } } } } }),
  });
  return Promise.resolve({
    ok: true,
    json: async () => ({ name: registeredAgent.ansName, endpoint: registeredAgent.endpoints[0].agentUrl }),
  });
}

test("discovers and independently verifies an applicant agent", async () => {
  const result = await verifyRemoteAgent({ ansName: registeredAgent.ansName, expectedRole: "applicant", fetchImpl: mockFetch });
  assert.equal(result.verdict, "pass");
  assert.equal(result.dimensions.length, 5);
  assert.equal(result.agent.agentId, "applicant-123");
});

test("does not accept a fuzzy registration as the claimed identity", async () => {
  const result = await discoverRemoteAgent({
    ansName: "ans://v1.0.0.applicant.other.com",
    fetchImpl: mockFetch,
  });
  assert.equal(result, null);
});
