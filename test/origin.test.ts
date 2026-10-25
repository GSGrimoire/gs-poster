import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOrigin } from "../src/origin.ts";

const SELF = "https://gs-poster.example.workers.dev";

test("real browser form posts from our own page pass", () => {
  assert.equal(isSameOrigin(SELF, SELF, "same-origin"), true);
  // Referrer-Policy no-referrer makes browsers send Origin: null on form POSTs
  assert.equal(isSameOrigin(SELF, "null", "same-origin"), true);
  assert.equal(isSameOrigin(SELF, null, null), true);
});

test("cross-site posts are refused", () => {
  assert.equal(isSameOrigin(SELF, "https://evil.example", "cross-site"), false);
  assert.equal(isSameOrigin(SELF, "https://evil.example", null), false);
  assert.equal(isSameOrigin(SELF, "null", "cross-site"), false);
  assert.equal(isSameOrigin(SELF, "null", null), false);
  assert.equal(isSameOrigin(SELF, SELF, "same-site"), false);
});
