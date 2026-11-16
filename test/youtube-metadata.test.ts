import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrivateYouTubeMusicVideoMetadata,
  buildYouTubeReleaseUpdate,
  YOUTUBE_DEFAULT_VISIBILITY,
  YOUTUBE_OAUTH_SCOPE,
  YOUTUBE_INSERT_PARTS,
  validFreePatreonPostUrl,
  validateYouTubeMusicVideoDraft,
  youtubeStudioVideoUrl,
  youtubeTagCharacters,
  type YouTubeMusicVideoDraft,
  type YouTubeCurrentMutableStatus,
} from "../src/youtube-metadata.ts";

const good: YouTubeMusicVideoDraft = {
  title: "Forest Ruins Ambience | Free Song Sunday",
  description: "Atmospheric music for exploring ancient ruins.\nhttps://www.patreon.com/posts/forest-ruins-123456\n\nFree Song Sunday from GS Grimoire.",
  patreonPostUrl: "https://www.patreon.com/posts/forest-ruins-123456",
  playlistId: "PLabcdef123456",
  tags: ["tabletop roleplaying", "fantasy ambience", "background music"],
  visibility: "public",
  madeForKids: false,
  rightsConfirmed: true,
  containsSyntheticMedia: true,
};

const currentStatus: YouTubeCurrentMutableStatus = {
  privacyStatus: "private",
  license: "youtube",
  embeddable: true,
  publicStatsViewable: true,
  selfDeclaredMadeForKids: false,
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

test("D2: the insert is always private, whatever visibility was approved", () => {
  for (const visibility of ["public", "unlisted", "private"] as const)
    assert.equal(buildPrivateYouTubeMusicVideoMetadata({ ...good, visibility }).status.privacyStatus, "private");
});

test("D2: visibility is an explicit choice of public, unlisted or private; public is the default", () => {
  assert.equal(YOUTUBE_DEFAULT_VISIBILITY, "public");
  for (const visibility of [undefined, null, "", "Public", "scheduled"]) {
    const draft = { ...good, visibility } as unknown as YouTubeMusicVideoDraft;
    assert.match(validateYouTubeMusicVideoDraft(draft).errors.join(" "), /visibility explicitly/);
    assert.throws(() => buildPrivateYouTubeMusicVideoMetadata(draft), /visibility explicitly/);
    assert.throws(() => buildYouTubeReleaseUpdate(draft, "AbC_123-yZ9", currentStatus), /visibility explicitly/);
  }
});

test("D2: the release update applies the approved visibility and repeats the whole status", () => {
  assert.deepEqual(buildYouTubeReleaseUpdate(good, "AbC_123-yZ9", currentStatus), {
    id: "AbC_123-yZ9",
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true, license: "youtube", embeddable: true, publicStatsViewable: true },
  });
  assert.equal(buildYouTubeReleaseUpdate({ ...good, visibility: "unlisted" }, "AbC_123-yZ9", currentStatus)?.status.privacyStatus, "unlisted");
  assert.equal(buildYouTubeReleaseUpdate({ ...good, visibility: "private" }, "AbC_123-yZ9", currentStatus), null);
  assert.throws(() => buildYouTubeReleaseUpdate(good, "not-a-video-id!", currentStatus), /Invalid YouTube video identifier/);
  assert.throws(() => buildYouTubeReleaseUpdate({ ...good, rightsConfirmed: false }, "AbC_123-yZ9", currentStatus), /Confirm rights/);
});

test("D3: one OAuth scope, wide enough for the playlist step", () => {
  assert.equal(YOUTUBE_OAUTH_SCOPE, "https://www.googleapis.com/auth/youtube");
});

test("release preserves all mutable status preferences instead of resetting them", () => {
  const existing: YouTubeCurrentMutableStatus = {
    ...currentStatus, license: "creativeCommon", embeddable: false, publicStatsViewable: false,
  };
  assert.deepEqual(buildYouTubeReleaseUpdate(good, "AbC_123-yZ9", existing)?.status, {
    privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true,
    license: "creativeCommon", embeddable: false, publicStatsViewable: false,
  });
});

test("release fails closed on missing or changed video status", () => {
  const fails = (status: unknown) => assert.throws(
    () => buildYouTubeReleaseUpdate(good, "AbC_123-yZ9", status as YouTubeCurrentMutableStatus),
    /reconcile before release/,
  );
  fails(undefined);
  fails({ ...currentStatus, privacyStatus: "public" });
  fails({ ...currentStatus, privacyStatus: "unlisted" });
  fails({ ...currentStatus, license: undefined });
  fails({ ...currentStatus, embeddable: undefined });
  fails({ ...currentStatus, publicStatsViewable: undefined });
  fails({ ...currentStatus, publishAt: "2026-11-20T12:00:00Z" });
  fails({ ...currentStatus, selfDeclaredMadeForKids: true });
  fails({ ...currentStatus, containsSyntheticMedia: false });
  assert.equal(buildYouTubeReleaseUpdate({ ...good, visibility: "private" }, "AbC_123-yZ9", currentStatus), null);
});
