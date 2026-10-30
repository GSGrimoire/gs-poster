// Issue #48 (no-media guard): labels that say media is still coming must not
// be approved empty by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaLooksPending } from "../src/validate.ts";

test("the two October posts that went out empty are caught", () => {
  assert.equal(mediaLooksPending("The Black Kiln launch teaser (images pending)", "The Black Kiln"), true);
  assert.equal(mediaLooksPending("10 player habits carousel: 7 slides to attach", "Ten Things I Wish Every Player Did"), true);
});

test("hold markers in the label or the release are caught, in any case", () => {
  assert.equal(mediaLooksPending("HOLD - winter cave battlemap, 4 images pending", null), true);
  assert.equal(mediaLooksPending("Day 1 reveal", "Map pack (art TBD)"), true);
});

test("ordinary names are not flagged", () => {
  for (const label of ["Day 1 creature reveal", "Week 2 Wed, GS: death save rules", "Holdfast Keep reveal", "Attachment issues: a DM tip"]) {
    assert.equal(mediaLooksPending(label, "Top 5 creature lists"), false, label);
  }
  assert.equal(mediaLooksPending(null, undefined), false);
});
