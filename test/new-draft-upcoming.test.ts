import { test } from "node:test";
import assert from "node:assert/strict";
import { blankNewDraft, renderNewDraft, UPCOMING_DESTINATIONS } from "../src/new-draft.ts";

const html = renderNewDraft(blankNewDraft(), "csrf-test", "Europe/Copenhagen");

test("new draft shows the upcoming platforms as disabled tiles with a note", () => {
  for (const d of UPCOMING_DESTINATIONS) {
    const tile = html.match(new RegExp(`<label[^>]*data-upcoming="${d.id}"[\\s\\S]*?</label>`));
    assert.ok(tile, `${d.label} tile is shown`);
    assert.match(tile[0], /aria-disabled="true"/);
    assert.match(tile[0], /<input type="checkbox" disabled/);
    assert.ok(tile[0].includes(d.note), `${d.label} carries its note`);
  }
  assert.deepEqual(UPCOMING_DESTINATIONS.map(d => d.label), ["Instagram", "Threads", "YouTube", "X"]);
});

test("upcoming tiles are never submitted with the form", () => {
  const tiles = html.match(/<label[^>]*data-upcoming=[\s\S]*?<\/label>/g) ?? [];
  assert.equal(tiles.length, UPCOMING_DESTINATIONS.length);
  for (const t of tiles) assert.doesNotMatch(t, /\sname=/);
});

test("the three selectable destinations are unchanged", () => {
  for (const n of ["facebook", "bluesky", "tiktok"])
    assert.match(html, new RegExp(`<input type="checkbox" name="${n}" value="1"`));
});
