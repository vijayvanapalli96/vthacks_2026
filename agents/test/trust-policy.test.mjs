import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyEmployer } from "../shared/trust-policy.mjs";

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

test("passes a domain-bound employer with exactly five explained trust dimensions", async () => {
  const input = await fixture("verified-employer.json");
  const result = verifyEmployer(input);
  assert.equal(result.verdict, "pass");
  assert.equal(result.dimensions.length, 5);
  assert.ok(result.dimensions.every((dimension) => dimension.reason.length > 0));
});

test("refuses an endpoint whose certificate and hostname do not match the ANS domain", async () => {
  const input = await fixture("unverified-employer.json");
  const result = verifyEmployer(input);
  assert.equal(result.verdict, "refuse");
  assert.match(result.spoken_reason, /hostname|certificate/i);
});
