/**
 * The tools Claude gets. There is deliberately no publish tool: drafts only go
 * live when Gus approves them on the approval site with his PIN.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import type { Env } from "./env.ts";
import { missingSecrets } from "./env.ts";
import { audit, createPost, deletePost, getPost, listPosts, updatePost, type Post, type PostStatus } from "./db.ts";
import { checkPage, listPagePosts } from "./facebook.ts";
import { checkImageUrl, fetchImage } from "./media.ts";
import { refreshScheduled } from "./publish.ts";
import { formatLocal, parseWhen } from "./time.ts";
import { checkMessage, checkWhen, DRAFT_MIN_LEAD_MS, MAX_IMAGES } from "./validate.ts";
import { createUpload } from "./upload.ts";

const STATUSES = ["draft", "rejected", "publishing", "scheduled", "published", "failed", "cancelled"] as const;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string, extra?: Record<string, unknown>) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }] };
}

function actor(): string {
  const login = getMcpAuthContext()?.props?.login;
  return `claude (via ${typeof login === "string" ? login : "unknown"})`;
}

function view(env: Env, origin: string, p: Post) {
  return {
    id: p.id,
    status: p.status,
    label: p.label,
    release: p.release,
    message: p.message,
    images: p.images,
    link: p.link,
    publish_at: p.scheduled_at,
    publish_at_local: p.scheduled_at ? formatLocal(new Date(p.scheduled_at), env.TIMEZONE) : "on approval",
    review_url: `${origin}/post/${p.id}`,
    facebook_post_id: p.fb_post_id,
    permalink: p.permalink,
    gus_note: p.note,
    error: p.error,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

async function checkImages(env: Env, urls: string[]): Promise<string[]> {
  const errors: string[] = [];
  if (urls.length > MAX_IMAGES) errors.push(`At most ${MAX_IMAGES} images per post.`);
  for (const u of urls) {
    const bad = checkImageUrl(u);
    if (bad) {
      errors.push(bad);
      continue;
    }
    try {
      await fetchImage(env, u);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return errors;
}

function readWhen(env: Env, input: string | null | undefined): { when: Date | null; error?: string } {
  if (input == null || input === "") return { when: null };
  try {
    const when = parseWhen(input, env.TIMEZONE);
    const err = checkWhen(when, new Date(), DRAFT_MIN_LEAD_MS);
    return err ? { when, error: err } : { when };
  } catch (e) {
    return { when: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const imageList = z
  .array(z.string().min(1))
  .max(MAX_IMAGES)
  .describe(
    "Image URLs on GitHub, in display order. Use raw.githubusercontent.com links (e.g. from the GS Grimoire image library) or github.com/.../blob/... links. JPG, PNG or GIF, max 10 MB each.",
  );

export function buildServer(env: Env, origin: string): McpServer {
  const server = new McpServer({ name: "gs-poster", version: "0.1.0" });

  // OAuth-protected. The returned PUT URL is a short-lived bearer credential;
  // writing media never approves or publishes a post.
  server.registerTool(
    "request_upload",
    {
      title: "Get a private one-time file upload link",
      description: "Create one private JPG, PNG, GIF (up to 10 MB) or MP4 (up to 20 MB) upload link, valid for 10 minutes. Run the returned curl command, then use its upload:// reference in a draft. Uploaded files expire after 45 days. Uploading is NOT publishing.",
      inputSchema: z.object({
        filename: z.string().min(1).max(200).describe("File name with extension. Only extension is retained."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ filename }) => {
      try {
        const grant = await createUpload(env, origin, { filename, actor: actor() });
        await audit(env.DB, actor(), "upload-link", null, grant.reference);
        return ok({ ...grant, next: "Upload the local file with curl, then use the reference in draft_post." });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "draft_post",
    {
      title: "Draft a Facebook post",
      description:
        "Save a post for the GS Grimoire Facebook Page as a DRAFT for Gus to review. Nothing is published: Gus approves it on the review page (returned as review_url), and only then does it go to Facebook. Captions must follow the house rules (no em dashes, no prices, no Suno/Midjourney, current tier names); drafts that break them are refused with the reasons. Give publish_at in Copenhagen time like 2026-10-16T19:00, or full ISO 8601; omit it to post when Gus approves.",
      inputSchema: z.object({
        message: z.string().max(63206).describe("The caption, exactly as it should appear."),
        images: imageList.optional(),
        link: z.string().url().optional().describe("Optional link preview. Only used when the post has no images."),
        publish_at: z.string().optional().describe("When to publish. Copenhagen time (2026-10-16T19:00) or ISO 8601 with offset. 30 minutes to 30 days ahead."),
        label: z.string().max(120).optional().describe('Short name shown to Gus, e.g. "Day 1 creature reveal".'),
        release: z.string().max(120).optional().describe('Which product or release this belongs to, e.g. "Corvane Reckoning".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ message, images = [], link, publish_at, label, release }) => {
      const checks = checkMessage(message, { hasImages: images.length > 0 });
      const time = readWhen(env, publish_at);
      const imgErrors = await checkImages(env, images);
      const errors = [...checks.errors, ...(time.error ? [time.error] : []), ...imgErrors];
      if (errors.length) return fail("Draft not saved. Fix these and try again.", { problems: errors, warnings: checks.warnings });
      const p = await createPost(env.DB, {
        message,
        images,
        link: link ?? null,
        scheduled_at: time.when?.toISOString() ?? null,
        label: label ?? null,
        release: release ?? null,
        created_by: actor(),
      });
      await audit(env.DB, actor(), "drafted", p.id, label);
      return ok({ saved: true, note: "Waiting for Gus to approve. Not published.", warnings: checks.warnings, post: view(env, origin, p) });
    },
  );

  server.registerTool(
    "update_draft",
    {
      title: "Revise a draft",
      description:
        "Change a draft or a rejected post. A rejected post goes back to draft for Gus to review again; read gus_note first to see what he asked for. Only the fields you pass are changed. Pass publish_at as an empty string to post on approval instead of at a set time.",
      inputSchema: z.object({
        id: z.string(),
        message: z.string().max(63206).optional(),
        images: imageList.optional(),
        link: z.string().url().nullable().optional(),
        publish_at: z.string().nullable().optional(),
        label: z.string().max(120).optional(),
        release: z.string().max(120).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, message, images, link, publish_at, label, release }) => {
      const cur = await getPost(env.DB, id);
      if (!cur) return fail(`No post with id ${id}.`);
      if (cur.status !== "draft" && cur.status !== "rejected") return fail(`This post is ${cur.status}; only drafts and rejected posts can be changed.`);
      const nextMessage = message ?? cur.message;
      const nextImages = images ?? cur.images;
      const checks = checkMessage(nextMessage, { hasImages: nextImages.length > 0 });
      const time = publish_at === undefined ? { when: cur.scheduled_at ? new Date(cur.scheduled_at) : null } : readWhen(env, publish_at);
      const imgErrors = images ? await checkImages(env, images) : [];
      const errors = [...checks.errors, ...("error" in time && time.error ? [time.error] : []), ...imgErrors];
      if (errors.length) return fail("Not saved. Fix these and try again.", { problems: errors, warnings: checks.warnings });
      const changed = await updatePost(
        env.DB,
        id,
        {
          status: "draft",
          message: nextMessage,
          images: nextImages,
          link: link === undefined ? cur.link : link,
          scheduled_at: time.when?.toISOString() ?? null,
          label: label ?? cur.label,
          release: release ?? cur.release,
          note: cur.status === "rejected" ? cur.note : null,
        },
        ["draft", "rejected"],
      );
      if (!changed) return fail("The post changed status while saving. Fetch it again.");
      await audit(env.DB, actor(), cur.status === "rejected" ? "revised-rejected" : "edited", id);
      return ok({ saved: true, warnings: checks.warnings, post: view(env, origin, (await getPost(env.DB, id))!) });
    },
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete a draft",
      description: "Delete a draft or rejected post that should not go out. Cannot touch anything already approved.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const okDel = await deletePost(env.DB, id, ["draft", "rejected"]);
      if (!okDel) return fail("Not deleted: no draft or rejected post with that id.");
      await audit(env.DB, actor(), "deleted", id);
      return ok({ deleted: id });
    },
  );

  server.registerTool(
    "list_posts",
    {
      title: "List posts",
      description:
        "List posts in GS Poster, newest first: drafts waiting for Gus, rejected ones (with his note), scheduled, published and failed. Use it to check what is already queued before drafting a release.",
      inputSchema: z.object({
        status: z.enum(STATUSES).optional(),
        release: z.string().optional().describe("Only posts for this release."),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, release, limit }) => {
      await refreshScheduled(env).catch(() => undefined);
      let posts = await listPosts(env.DB, { status: status as PostStatus | undefined, limit: limit ?? 30 });
      if (release) posts = posts.filter((p) => (p.release ?? "").toLowerCase() === release.toLowerCase());
      return ok({ count: posts.length, review_site: origin, posts: posts.map((p) => view(env, origin, p)) });
    },
  );

  server.registerTool(
    "get_post",
    {
      title: "Get one post",
      description: "Full details of one post, including Gus's note if he rejected it and the Facebook error if it failed.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const p = await getPost(env.DB, id);
      return p ? ok(view(env, origin, p)) : fail(`No post with id ${id}.`);
    },
  );

  server.registerTool(
    "list_page_posts",
    {
      title: "Read the Facebook Page",
      description:
        "What is actually on the GS Grimoire Facebook Page: recent published posts with reactions, comments and shares, or the posts on Facebook's schedule (including ones Gus scheduled by hand). Read-only.",
      inputSchema: z.object({
        kind: z.enum(["published", "scheduled"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ kind, limit }) => {
      try {
        const k = kind ?? "published";
        const posts = await listPagePosts(env, k, limit ?? 10);
        return ok({
          kind: k,
          posts: posts.map((p) => ({
            ...p,
            scheduled_local: p.scheduled_publish_time ? formatLocal(new Date(p.scheduled_publish_time * 1000), env.TIMEZONE) : undefined,
          })),
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "check_setup",
    {
      title: "Check the connection",
      description: "Report which settings are missing and whether the Facebook Page token works. Use it first, or when something fails.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const missing = missingSecrets(env);
      let facebook: unknown = "skipped: FB_PAGE_ID or FB_PAGE_TOKEN missing";
      if (env.FB_PAGE_ID && env.FB_PAGE_TOKEN) {
        try {
          facebook = { ok: true, page: await checkPage(env) };
        } catch (e) {
          facebook = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return ok({
        review_site: origin,
        missing_secrets: missing,
        optional: { FB_APP_SECRET: !!env.FB_APP_SECRET, GITHUB_READ_TOKEN: !!env.GITHUB_READ_TOKEN, UPLOADS: !!env.UPLOADS },
        graph_version: env.GRAPH_VERSION,
        timezone: env.TIMEZONE,
        facebook,
      });
    },
  );

  return server;
}
