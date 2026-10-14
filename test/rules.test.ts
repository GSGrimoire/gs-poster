import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMessage, checkWhen, APPROVE_MIN_LEAD_MS, DRAFT_MIN_LEAD_MS } from "../src/validate.ts";
import { localToUtc, parseWhen, toLocalInput, formatLocal } from "../src/time.ts";
import { parseGitHubUrl, checkImageUrl } from "../src/media.ts";

const TZ = "Europe/Copenhagen";

test("house rules block em dashes, prices, tool names, retired tiers", () => {
  const bad = checkMessage("The Rotting Hulk — now in the Archive for $3. Made with Midjourney. Wanderer tier. A bargain, really.", { hasImages: false });
  assert.equal(bad.errors.length, 5, bad.errors.join("\n"));
  const good = checkMessage("Something wakes under the tide.\n\nThe full encounter is in the Archive.", { hasImages: false });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.warnings, []);
});

test("prices in kroner and euros are caught; CR numbers are not", () => {
  assert.ok(checkMessage("Only 25 kr a month in the Archive", { hasImages: false }).errors.length);
  assert.ok(checkMessage("€5 in the Archive", { hasImages: false }).errors.length);
  assert.deepEqual(checkMessage("CR 5. Think your party survives? The Archive has it.", { hasImages: false }).errors, []);
  assert.deepEqual(checkMessage("Twenty years behind the screen, 4 tables, the Archive.", { hasImages: false }).errors, []);
});

test("empty post needs an image", () => {
  assert.ok(checkMessage("", { hasImages: false }).errors.length);
  assert.deepEqual(checkMessage("", { hasImages: true }).errors, []);
});

test("Copenhagen local time converts across DST", () => {
  // Summer (CEST, +2)
  assert.equal(localToUtc("2026-07-01T19:00", TZ).toISOString(), "2026-07-01T17:00:00.000Z");
  // Winter (CET, +1)
  assert.equal(localToUtc("2026-12-01T19:00", TZ).toISOString(), "2026-12-01T18:00:00.000Z");
  // DST ends 25 Oct 2026
  assert.equal(localToUtc("2026-10-26T09:00", TZ).toISOString(), "2026-10-26T08:00:00.000Z");
  assert.equal(toLocalInput(new Date("2026-07-01T17:00:00Z"), TZ), "2026-07-01T19:00");
  assert.equal(parseWhen("2026-07-01T19:00:00+02:00", TZ).toISOString(), "2026-07-01T17:00:00.000Z");
  assert.match(formatLocal(new Date("2026-07-01T17:00:00Z"), TZ), /19:00/);
});

test("schedule window", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  assert.equal(checkWhen(null, now, APPROVE_MIN_LEAD_MS), null);
  assert.ok(checkWhen(new Date("2026-10-14T12:05:00Z"), now, APPROVE_MIN_LEAD_MS));
  assert.equal(checkWhen(new Date("2026-10-14T12:20:00Z"), now, APPROVE_MIN_LEAD_MS), null);
  assert.ok(checkWhen(new Date("2026-10-14T12:20:00Z"), now, DRAFT_MIN_LEAD_MS));
  assert.ok(checkWhen(new Date("2026-11-20T12:00:00Z"), now, APPROVE_MIN_LEAD_MS));
});

test("GitHub image URLs", () => {
  assert.deepEqual(parseGitHubUrl("https://raw.githubusercontent.com/GoofySpook/GSImageLibrary/refs/heads/main/hulk.png"), {
    owner: "GoofySpook", repo: "GSImageLibrary", ref: "main", path: "hulk.png",
  });
  assert.deepEqual(parseGitHubUrl("https://raw.githubusercontent.com/GSGrimoire/gs-poster/main/media/a%20b.jpg"), {
    owner: "GSGrimoire", repo: "gs-poster", ref: "main", path: "media/a b.jpg",
  });
  assert.deepEqual(parseGitHubUrl("https://github.com/GSGrimoire/gs-poster/blob/main/media/x.jpeg"), {
    owner: "GSGrimoire", repo: "gs-poster", ref: "main", path: "media/x.jpeg",
  });
  assert.equal(parseGitHubUrl("https://evil.example.com/x.png"), null);
  assert.equal(parseGitHubUrl("http://raw.githubusercontent.com/a/b/main/x.png"), null);
  assert.ok(checkImageUrl("https://raw.githubusercontent.com/a/b/main/x.webp"));
  assert.equal(checkImageUrl("https://raw.githubusercontent.com/a/b/main/x.PNG"), null);
});
