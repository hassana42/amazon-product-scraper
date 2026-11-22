import assert from "node:assert/strict";
import { test } from "vitest";
import { AccessRestricted, collectBatch, prepareCollection } from "../dist/batch.js";
import { fixtureRank } from "../dist/demo.js";
import fixtures from "../static/demo-products.json";

test("collection separates malformed and duplicate lines while preserving cross-market identity", () => {
  const items = prepareCollection([
    "invalid",
    "https://amazon.com/dp/B000000001",
    "https://www.amazon.com/gp/product/B000000001?ref=duplicate",
    "https://amazon.de/dp/B000000001",
  ].join("\n"));
  assert.deepEqual(items.map(({ state }) => state), ["failed", "queued", "skipped", "queued"]);
});

test("a restricted marketplace is stopped without aborting other marketplaces", async () => {
  const items = prepareCollection([
    "https://amazon.com/dp/B000000001",
    "https://amazon.com/dp/B000000002",
    "https://amazon.de/dp/B000000001",
  ].join("\n"));
  const calls: string[] = [];
  const observed: string[][] = [];
  await collectBatch(items, async (target) => {
    calls.push(target.url);
    if (target.marketplace === "US") throw new AccessRestricted("Verification");
    return fixtures.find(({ asin }) => asin === "DEMO000004");
  }, () => observed.push(items.map(({ state }) => state)), async () => {});
  assert.equal(calls.length, 2);
  assert.deepEqual(items.map(({ state }) => state), ["failed", "skipped", "succeeded"]);
  assert.ok(observed.some((statuses) => statuses.includes("processing")));
});

test("fixture search ranks real listing terms and filters marketplace", () => {
  const results = fixtureRank(fixtures, "wireless headphones", "US");
  assert.deepEqual(results.map(({ product }) => product.asin), ["DEMO000001", "DEMO000002"]);
  assert.ok(results[0].matched_features.includes("wireless"));
  assert.equal(results[0].ranking, "lexical");
  assert.deepEqual(fixtureRank(fixtures, "gaming pc", "US").map(({ product }) => product.asin), ["DEMO000005"]);
  assert.deepEqual(fixtureRank(fixtures, "mechanical keyboard", "US").map(({ product }) => product.asin), ["DEMO000006"]);
  assert.deepEqual(fixtureRank(fixtures, "astrophotography"), []);
});
