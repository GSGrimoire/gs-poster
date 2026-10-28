import { test } from "node:test";
import assert from "node:assert/strict";
import { html } from "../src/html.ts";
import { DRAFT_MEDIA_JS } from "../src/draft-media.ts";

test("browser uploads may connect to private same-origin endpoints without allowing outside hosts", () => {
  const response = html("<p>Draft</p>");
  const policy = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(policy, /(?:^|;)\s*connect-src 'self'(?:;|$)/);
  assert.match(policy, /(?:^|;)\s*img-src 'self' blob:(?:;|$)/);
  assert.doesNotMatch(policy, /img-src[^;]*https?:/);
  assert.match(DRAFT_MEDIA_JS, /URL\.createObjectURL\(file\)/);
  assert.match(policy, /(?:^|;)\s*default-src 'none'(?:;|$)/);
  assert.doesNotMatch(policy, /connect-src\s+\*/);
  assert.match(DRAFT_MEDIA_JS, /fetch\("\/post\//);
  assert.match(DRAFT_MEDIA_JS, /fetch\(grant\.upload_url/);
});
