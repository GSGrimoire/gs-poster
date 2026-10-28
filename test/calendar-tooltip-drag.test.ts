import { test } from "node:test";
import assert from "node:assert/strict";
import { CALENDAR_JS, renderCalendar } from "../src/calendar.ts";
import type { Env } from "../src/env.ts";

test("hover tooltips cannot intercept pointer events", () => {
  const markup = renderCalendar({TIMEZONE:"Europe/Copenhagen"} as Env, [], "token", "2026-10-25");
  assert.match(markup, /\.cal-tooltip\{[^}]*pointer-events:none/);
  assert.match(markup, /\.calendar-window\.is-dragging \.cal-tooltip\{display:none!important\}/);
  assert.match(markup, /\.calendar-window\.is-dragging \.calendar-post\{pointer-events:none\}/);
});

test("drag mode hides obstructing cards and clears itself on drop or cancel", () => {
  assert.match(CALENDAR_JS, /dragstart[\s\S]*viewport\.classList\.add\("is-dragging"\)/);
  assert.match(CALENDAR_JS, /dragend[\s\S]*viewport\.classList\.remove\("is-dragging"\)/);
  assert.match(CALENDAR_JS, /drop[\s\S]*viewport\.classList\.remove\("is-dragging"\)/);
});
