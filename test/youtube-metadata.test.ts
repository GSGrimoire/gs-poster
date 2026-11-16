import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrivateYouTubeMusicVideoMetadata,
  YOUTUBE_INSERT_PARTS,
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
  containsSyntheticMedia: true,
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
  assert.equal(body.status.containsSyntheticMedia, true);
  // Omitting status.privacyStatus now defaults to public on YouTube, so the
  // body must always carry it and the adapter must always send the status part.
  assert.deepEqual(Object.keys(body.status).sort(), ["containsSyntheticMedia", "privacyStatus", "selfDeclaredMadeForKids"]);
  assert.equal(YOUTUBE_INSERT_PARTS, "snippet,status");
});

test("the synthetic-content answer is explicit, never inferred or left out", () => {
  const body = buildPrivateYouTubeMusicVideoMetadata({ ...good, containsSyntheticMedia: false });
  assert.equal(body.status.containsSyntheticMedia, false);
  assert.equal(body.status.privacyStatus, "private");
  for (const value of [null, undefined, "yes"]) {
    const draft = { ...good, containsSyntheticMedia: value } as unknown as YouTubeMusicVideoDraft;
    assert.match(validateYouTubeMusicVideoDraft(draft).errors.join(" "), /synthetic content question/);
    assert.throws(() => buildPrivateYouTubeMusicVideoMetadata(draft), /synthetic content question/);
  }
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

test("existing GS Grimoire house rules apply to YouTube copy", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "A Song \u2014 A Release" }).errors.join(" "), /em dash/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, description: good.description + "\nMade with Suno" }).errors.join(" "), /generative tool/);
});

test("the reviewed Patreon URL must appear as a whole link, not a prefix", () => {
  const otherPost = good.description.replace(good.patreonPostUrl, good.patreonPostUrl + "999");
  assert.match(validateYouTubeMusicVideoDraft({ ...good, description: otherPost }).errors.join(" "), /must include/);
  const withFullStop = { ...good, description: "Listen here: " + good.patreonPostUrl + "." };
  const check = validateYouTubeMusicVideoDraft(withFullStop);
  assert.deepEqual(check.errors, []);
  assert.ok(!check.warnings.join(" ").includes("first description link"));
});

test("Patreon URL must be canonical: no port, query, fragment or parser-stripped whitespace", () => {
  for (const url of [
    "https://patreon.com:8443/posts/forest-ruins-123456",
    "https://www.patreon.com/posts/forest-ruins-123456?ref=x",
    "https://www.patreon.com/posts/forest-ruins-123456#x",
    " https://www.patreon.com/posts/forest-ruins-123456",
    "https://www.patreon.com/po\tsts/forest-ruins-123456",
    "https://WWW.PATREON.COM/posts/forest-ruins-123456",
  ]) assert.equal(validFreePatreonPostUrl(url), false, JSON.stringify(url));
});

test("tags follow house rules and cannot smuggle separators", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, tags: ["suno"] }).errors.join(" "), /Tags:.*generative tool/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, tags: ["a,b"] }).errors.join(" "), /commas/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, tags: ['say "hi"'] }).errors.join(" "), /quotes/);
});

test("bidi controls, lone surrogates and tabs are rejected; invisible characters warn", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "Free \u202eyadnuS" }).errors.join(" "), /unsupported/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "Song\ud800" }).errors.join(" "), /unsupported/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "a\tb" }).errors.join(" "), /unsupported/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, description: good.description + "\u2066x\u2069" }).errors.join(" "), /unsupported/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, description: good.description + "\u200b" }).warnings.join(" "), /invisible/);
});

test("JSON-shaped input with wrong types returns errors instead of throwing", () => {
  const bad = (patch: Record<string, unknown>) =>
    validateYouTubeMusicVideoDraft({ ...good, ...patch } as unknown as YouTubeMusicVideoDraft).errors.join(" ");
  assert.match(bad({ title: 42 }), /title must be text/);
  assert.match(bad({ tags: "abc" }), /tags must be a list/);
  assert.match(bad({ tags: [1] }), /tags must be a list/);
  assert.match(bad({ playlistId: 123 }), /playlist identifier must be text/);
  assert.throws(() => buildPrivateYouTubeMusicVideoMetadata({ ...good, title: 42 } as unknown as YouTubeMusicVideoDraft), /title must be text/);
});

test("leading or trailing tabs and line breaks in the raw title are rejected, not trimmed away", () => {
  for (const title of ["\tForest Ruins", "Forest Ruins\t", "\nForest Ruins", "Forest Ruins\r\n", "Forest\u2028Ruins", "Forest Ruins\u0085"])
    assert.match(validateYouTubeMusicVideoDraft({ ...good, title }).errors.join(" "), /unsupported/, JSON.stringify(title));
  assert.deepEqual(validateYouTubeMusicVideoDraft({ ...good, title: "  Forest Ruins  " }).errors, []);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "Forest \u061cRuins" }).errors.join(" "), /unsupported/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, tags: ["a\u2028b"] }).errors.join(" "), /tags must be/);
});

test("a title or description made only of invisible characters counts as empty", () => {
  assert.match(validateYouTubeMusicVideoDraft({ ...good, title: "\u200b\u2060" }).errors.join(" "), /title is required/);
  assert.match(validateYouTubeMusicVideoDraft({ ...good, description: "\u200b" }).errors.join(" "), /description is required/);
});

test("a Patreon slug ending in sentence punctuation is refused up front", () => {
  for (const url of ["https://www.patreon.com/posts/forest-ruins-123456.", "https://www.patreon.com/posts/forest-ruins-123456)"])
    assert.equal(validFreePatreonPostUrl(url), false, url);
  assert.ok(validFreePatreonPostUrl("https://www.patreon.com/posts/forest-ruins-123456/"));
});

test("emoji-heavy titles near the limit warn instead of passing silently", () => {
  const title = "\u{1F3B5}".repeat(60);
  const check = validateYouTubeMusicVideoDraft({ ...good, title });
  assert.deepEqual(check.errors, []);
  assert.match(check.warnings.join(" "), /emoji count double/);
});
