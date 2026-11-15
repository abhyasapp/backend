import test from "node:test";
import assert from "node:assert/strict";
import { computeAccess, chunk, kathmanduDay, toMs, stripAnswers, hasTraversalSegment } from "./pure.ts";

const NOW = Date.parse("2026-11-14T10:00:00Z");
const hour = 3600_000;

test("trial with future expiry is trial", () => {
  const r = computeAccess({ status: "trial", trial_expires_at: new Date(NOW + hour).toISOString() }, NOW);
  assert.equal(r.level, "trial");
});
test("trial with EMPTY or invalid expiry fails closed", () => {
  assert.equal(computeAccess({ status: "trial", trial_expires_at: "" }, NOW).level, "expired");
  assert.equal(computeAccess({ status: "trial", trial_expires_at: "garbage" }, NOW).level, "expired");
  assert.equal(computeAccess({ status: "trial" }, NOW).level, "expired");
});
test("empty status is not a free trial", () => {
  assert.equal(computeAccess({ status: "", trial_expires_at: "" }, NOW).level, "expired");
});
test("expired trial", () => {
  assert.equal(computeAccess({ status: "trial", trial_expires_at: new Date(NOW - hour).toISOString() }, NOW).level, "expired");
});
test("permanent and active", () => {
  assert.equal(computeAccess({ status: "active", permanent_access: "true" }, NOW).level, "permanent");
  assert.equal(computeAccess({ status: "active" }, NOW).level, "permanent");
});
test("yearly access expires", () => {
  const u = { status: "active", access_type: "yearly", access_expires_at: new Date(NOW - hour).toISOString() };
  assert.equal(computeAccess(u, NOW).level, "expired");
  assert.equal(computeAccess({ ...u, access_expires_at: new Date(NOW + hour).toISOString() }, NOW).level, "permanent");
});
test("payment_pending and unknown statuses", () => {
  assert.equal(computeAccess({ status: "payment_pending" }, NOW).level, "pending_review");
  assert.equal(computeAccess({ status: "rejected" }, NOW).level, "expired");
});

test("chunk", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test("kathmanduDay uses UTC+5:45", () => {
  // 2026-11-13T19:00Z is 2026-11-14 00:45 in Kathmandu
  assert.equal(kathmanduDay(Date.parse("2026-11-13T19:00:00Z")), "2026-11-14");
  assert.equal(kathmanduDay(Date.parse("2026-11-13T18:00:00Z")), "2026-11-13");
});

test("toMs handles ISO, epoch strings, numbers, junk", () => {
  assert.equal(toMs("1731500000000"), 1731500000000);
  assert.equal(toMs(1731500000000), 1731500000000);
  assert.equal(toMs("2026-11-14T00:00:00Z"), Date.parse("2026-11-14T00:00:00Z"));
  assert.equal(toMs(""), 0);
  assert.equal(toMs("nope"), 0);
});

test("stripAnswers removes keys in every supported shape", () => {
  const q = { q: "Q?", options: ["a", "b"], correct: 1, explanation: "because" };
  for (const shape of [[q], { questions: [q] }, { data: [q] }, { sections: [{ section: "s", questions: [q] }] }]) {
    const json = JSON.stringify(stripAnswers(shape));
    assert.ok(!json.includes("correct"), json);
    assert.ok(!json.includes("because"), json);
    assert.ok(json.includes("Q?"), json);
  }
  // Published content stores the explanation as `explain` — it must be stripped too.
  const withExplain = JSON.stringify(stripAnswers([{ q: "y", options: ["a", "b"], correct: 0, explain: "secret why" }]));
  assert.ok(!withExplain.includes("secret why"), withExplain);
  const withFlags = JSON.stringify(stripAnswers([{ q: "x", options: [{ text: "a", isCorrect: true }] }]));
  assert.ok(!withFlags.includes("isCorrect"));
  // original untouched
  assert.equal(q.correct, 1);
});

test("hasTraversalSegment only flags real traversal", () => {
  assert.equal(hasTraversalSegment("a..b/x.png"), false);
  assert.equal(hasTraversalSegment("../x"), true);
  assert.equal(hasTraversalSegment("a/./x"), true);
  assert.equal(hasTraversalSegment("a/b/x.png"), false);
});
