import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrivateYouTubeMusicVideoMetadata,
  validFreePatreonPostUrl,
  validateYouTubeMusicVideoDraft,
  youtubeStudioVideoUrl,
  youtubeTagCharacters,
  type YouTubeMusicVideoDraft,
} from "../src/youtube-metadata.ts";

const good: YouTubeMusicVideoDraft = {
  title: "Forest Ruins Ambience | Free Song Sunday",
  description: "Atmospheric music for exploring ancient ruins.\nhttps://www.patreon.com/posts/forest-ruins-123456\n\nFree Song Sunday from GS Grimoire.",
  patreonPostUrl: "https://www.patreon.com/posts/forest-ruins-123456",
  playlistId: "PLabcdef123456",
  tags: ["tabletop roleplaying", "fantasy ambience", "background music"],
  madeForKids: false,
  rightsConfirmed: true,
};

test("valid Free Song Sunday metadata produces a private-only video insert body", () => {
  const check = validateYouTubeMusicVideoDraft(good);
  assert.deepEqual(check.errors, []);
  const body = buildPrivateYouTubeMusicVideoMetadata(good);
  assert.equal(body.snippet.categoryId, "10");
  assert.equal(body.status.privacyStatus, "private");
  assert.equal(body.status.selfDeclaredMadeForKids, false);
  assert.ok(!("publishAt" in body.status));
  assert.ok(!("playlistId" in body.snippet), "playlist membership is a separate approved side effect");
  assert.equal(body.snippet.description, good.description);
  assert.equal(body.status.containsSyntheticMedia, undefined);
});

test("explicit disclosure can be carried without inferring it", () => {
  const body = buildPrivateYouTubeMusicVideoMetadata({ ...good, containsSyntheticMedia: true });
  assert.equal(body.status.containsSyntheticMedia, true);
  assert.equal(body.status.privacyStatus, "private");
});

test("title, description and tags obey YouTube limits", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "X".repeat(101) }).errors.join(" "), /100/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "bad <title>" }).errors.join(" "), /unsupported/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, description: "é".repeat(2501) + "\n" + good.patreonPostUrl }).errors.join(" "), /5000 UTF-8 bytes/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, tags: ["a".repeat(501)] }).errors.join(" "), /500/);
  assert.equal(youtubeTagCharacters(["one two", "three"]), 15);
});

test("description must contain the exact reviewed Patreon post URL", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, description: "No link here" }).errors.join(" "), /must include/);
  const changed = { ...good, description: "Explore this realm.\nhttps://example.com/\n" + good.patreonPostUrl };
  assert.match(validateYouTubeMusicVideoDraft(changed).warnings.join(" "), /first description link/);
});

test("HTTPS Patreon post URL rejects lookalikes, userinfo, and wrong content", () => {
  assert.ok(validFreePatreonPostUrl("https://patreon.com/posts/forest-ruins-123456"));
  for (const url of [
    "http://www.patreon.com/posts/forest-ruins-123456",
    "https://www.patreon.com.evil.example/posts/forest-ruins-123456",
    "https://user@patreon.com/posts/forest-ruins-123456",
    "https://www.patreon.com/gsgrimoire",
    "https://www.patreon.com/posts/",
  ]) assert.equal(validFreePatreonPostUrl(url), false, url);
});

test("audience and rights are explicit owner decisions", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, madeForKids: null }).errors.join(" "), /audience selection/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, rightsConfirmed: false }).errors.join(" "), /Confirm rights/);
  assert.throws(() => buildPrivateYouTubeMusicVideoMetadata({ ...good, rightsConfirmed: false }), /Confirm rights/);
});

test("playlist IDs cannot add URL or query characters", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, playlistId: "https://youtube.com/?list=x" }).errors.join(" "), /playlist identifier/);
  assert.deepEqual(validateYouTubeMusicVideoDraft({ ...good, playlistId: null }).errors, []);
});

test("studio URL only accepts a canonical video identifier", () => {
  assert.equal(youtubeStudioVideoUrl("AbC_123-yZ9"), "https://studio.youtube.com/video/AbC_123-yZ9/edit");
  assert.throws(() => youtubeStudioVideoUrl("AbC_123-yZ9/../../x"), /Invalid/);
});
