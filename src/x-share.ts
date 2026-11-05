/**
 * "Open in X": a manual, fee-free route to X. GS Poster holds no X credentials
 * and calls no X API. The button is a plain link to X's documented Post Web
 * Intent (docs.x.com/x-for-websites/post-button/guides/web-intent), which opens
 * X's composer with the text and link filled in. The owner presses Post in X
 * and attaches any media there; the intent has no media parameter.
 *
 * The link opens in a new tab, and the page then records the click once, so
 * the button stays greyed out on both the draft page and the published page.
 * A press only shows that X was opened, not that anything was posted, so a
 * separate Reopen in X link stays available with the current text. Reopening
 * keeps the first time and adds its own audit line.
 * Recording a click sends nothing anywhere, so it needs session, same-origin
 * and CSRF checks but no PIN.
 */
import { esc } from "./html.ts";
import type { Post } from "./db.ts";
import { formatLocal } from "./time.ts";

export interface XCompose { href: string; note: string; empty: boolean }

/**
 * Build the composer link. Self-contained (no outside references) because its
 * source text is also sent to the browser, so the live editor and the server
 * agree. Text over X's limit is still passed on so the owner can shorten it
 * in X, with a note saying so; only text past 1,000 characters is left out,
 * to keep the link a sensible length, and the note says that too.
 */
export function xCompose(text: string, link: string): XCompose {
  const chars = Array.from(text.trim());
  const body = chars.join("");
  const cleanLink = /^https?:\/\/\S+$/i.test(link.trim()) ? link.trim() : "";
  const url = cleanLink && !body.includes(cleanLink) ? cleanLink : "";
  const params = [
    ...(chars.length ? ["text=" + encodeURIComponent(chars.slice(0, 1000).join(""))] : []),
    ...(url ? ["url=" + encodeURIComponent(url)] : []),
  ];
  // An estimate of X's weighted count: links are 23, most characters 1, and
  // emoji and CJK 2. Emoji sequences can read a little high, hence "About".
  const plain = body.replace(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi, "x".repeat(23));
  let length = url ? (plain ? 24 : 23) : 0;
  for (const ch of plain) {
    const c = ch.codePointAt(0) ?? 0;
    length += c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247) ? 1 : 2;
  }
  const notes = [
    ...(length > 280 ? ["About " + length + " characters as X counts them, where emoji count double. X allows 280 on a free account, so shorten it there."] : []),
    ...(chars.length > 1000 ? ["Only the first 1,000 characters of the caption are passed to X."] : []),
  ];
  return { href: "https://x.com/intent/tweet" + (params.length ? "?" + params.join("&") : ""),
    note: notes.join(" "), empty: !params.length };
}

/** Bluesky comes first because its limit is closest to X's. */
export function xSource(p: Post): { text: string; link: string } {
  const captions = [
    p.bluesky?.caption,
    p.facebook_enabled ? p.message : "",
    p.instagram?.caption,
    p.tiktok_enabled ? p.tiktok_caption ?? p.message : "",
  ];
  return {
    text: captions.find((c) => c?.trim()) ?? "",
    link: p.bluesky?.patreon?.url || p.link || "",
  };
}

/** A rejected or cancelled post should not be offered for posting anywhere. */
export function xAvailable(p: Post): boolean {
  return p.status !== "rejected" && p.status !== "cancelled";
}

export function renderXCard(p: Post, csrf: string, tz: string): string {
  if (!xAvailable(p)) return "";
  const source = xSource(p);
  const x = xCompose(source.text, source.link);
  const opened = !!p.x_opened_at;
  const status = opened ? `Opened ${esc(formatLocal(new Date(p.x_opened_at!), tz))}. This records the click, not that it was posted.` : "";
  return `<section class="step-card" aria-label="X" data-x-share data-post="${esc(p.id)}" data-csrf="${esc(csrf)}" data-link="${esc(p.link ?? "")}"${opened ? " data-x-opened" : ""}${x.empty && !opened ? " hidden" : ""}>
    <div class="eyebrow">X · Manual posting</div>
    ${opened ? `<p data-x-spent><button type="button" disabled>Opened in X</button></p>` : ""}
    <p data-x-link${x.empty ? " hidden" : ""}><a class="btn" href="${esc(x.href)}" target="_blank" rel="noopener noreferrer" data-x-open>${opened ? "Reopen in X" : "Open in X"}</a></p>
    <p class="hint" data-x-status${opened ? "" : " hidden"}>${status}</p>
    <p class="hint">Fills in the text and link in a new tab. You attach any image or video and press Post in X.</p>
    <p class="hint" data-x-note${x.note ? "" : " hidden"}>${esc(x.note)}</p>
    <p class="hint media-error" data-x-error hidden></p>
  </section><script src="/x-share.js" defer></script>`;
}

export const X_SHARE_JS = `"use strict";
const xCompose = ${xCompose.toString()};
(() => {
  const card = document.querySelector("[data-x-share]");
  if (!card) return;
  const open = card.querySelector("[data-x-open]");
  const note = card.querySelector("[data-x-note]");
  const error = card.querySelector("[data-x-error]");
  const status = card.querySelector("[data-x-status]");
  const editor = document.getElementById("draft-editor");
  const field = (name) => editor.elements.namedItem(name);
  const value = (name) => field(name)?.value ?? "";
  const enabled = (name) => !!field("p_" + name)?.checked;

  // Keep the link on the unsaved text while the draft is being edited.
  const refresh = () => {
    if (!editor) return;
    const captions = [
      enabled("bluesky") ? value("bs_caption") : "",
      enabled("facebook") ? value("message") : "",
      enabled("instagram") ? value("ig_caption") : "",
      enabled("tiktok") ? value("tiktok_caption") || value("message") : "",
    ];
    const text = captions.find((c) => c.trim()) ?? "";
    const link = (enabled("bluesky") && value("bs_patreon_url")) || card.dataset.link || "";
    const x = xCompose(text, link);
    open.href = x.href;
    note.textContent = x.note;
    note.hidden = !x.note;
    open.closest("p").hidden = x.empty;
    card.hidden = x.empty && !card.hasAttribute("data-x-opened");
  };
  editor?.addEventListener("input", refresh);
  editor?.addEventListener("change", refresh);
  refresh();

  const firstPress = () => {
    const spent = document.createElement("p");
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = true;
    button.textContent = "Opened in X";
    spent.append(button);
    open.closest("p").before(spent);
    open.textContent = "Reopen in X";
    status.textContent = "Opened just now. This records the click, not that it was posted.";
    status.hidden = false;
    card.setAttribute("data-x-opened", "");
    return () => {
      spent.remove();
      open.textContent = "Open in X";
      status.hidden = true;
      card.removeAttribute("data-x-opened");
    };
  };

  const pressed = () => {
    refresh();
    const undo = card.hasAttribute("data-x-opened") ? () => {} : firstPress();
    error.hidden = true;
    const body = new URLSearchParams({ csrf: card.dataset.csrf });
    fetch("/post/" + encodeURIComponent(card.dataset.post) + "/x-opened", { method: "POST", body, keepalive: true })
      .then((res) => { if (!res.ok) throw new Error(String(res.status)); })
      .catch(() => {
        undo();
        error.textContent = "X opened, but GS Poster could not log it. Reload the page and check.";
        error.hidden = false;
      });
  };
  open.addEventListener("click", pressed);
  open.addEventListener("auxclick", (event) => { if (event.button === 1) pressed(); });
})();
`;
