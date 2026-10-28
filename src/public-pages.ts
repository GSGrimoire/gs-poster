/** Public information for platform review.
 * Operator should review the contact and legal wording before submission.
 */
import { html, page } from "./html.ts";
export type PublicPage = "about" | "terms" | "privacy";

const about = `
<main>
<h2>About GS Poster</h2>
<p>GS Poster is the content preparation and publishing management service for GS Grimoire, a tabletop roleplaying game project. Authorized editors prepare, review and schedule promotional posts, images and videos.</p>
<h3>How GS Poster works</h3>
<p>Authorized editors can draft captions, upload images and videos, preview posts in a weekly calendar, and approve or cancel scheduled posts. Draft creation does not publish content. Publication requires separate approval by an authorized editor.</p>
<p>GS Poster supports Facebook Pages and Bluesky publication. TikTok supports authorized inbox transfers for videos and photo carousels, and explicit private-only Direct Post testing where a user has granted video.publish. Direct publishing requires a separate editor approval. Automatic scheduled TikTok publication is not enabled.</p>
<h3>Who can use the editor?</h3>
<p>The editorial dashboard is restricted to authorized GS Grimoire users signing in through GitHub. The public pages can be read without an account.</p>
<h3>Learn more and contact us</h3>
<p>Read the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>. Questions and privacy requests can be directed to the GS Grimoire operator through the <a href="https://www.patreon.com/GSGrimoire" rel="noopener noreferrer">official GS Grimoire Patreon page</a>. Do not disclose account passwords or access tokens in public messages.</p>
</main>`;

const terms = `
<main>
<h2>Terms of Service</h2><p class="hint">Effective date: 28 October 2026</p>
<p>These terms apply to the GS Poster content preparation and publishing service operated for GS Grimoire. Access to the editing and publishing features is restricted to authorized personnel, not open public registration.</p>
<h3>Access</h3>
<p>Authorized editors must keep their account credentials confidential and use only accounts and features for which they have permission. Access may be restricted or revoked to protect connected services and content.</p>
<h3>Uploaded content</h3>
<p>Only submit text, images, video and music that you have the rights to use. You remain responsible for compliance with applicable laws, copyright rules and the terms of destination platforms. Uploading content does not by itself transfer ownership to GS Poster.</p>
<h3>Publication and approval</h3>
<p>Drafts do not publish automatically. Authorized editors separately approve publication. Delivery depends on external services including Facebook, Bluesky, and platforms connected in the future. Third-party processing and release may fail, be delayed or be rejected. Their respective terms and rules also apply.</p>
<h3>Security and acceptable use</h3>
<p>Do not evade access controls, upload malicious files, impersonate editors, or use connected accounts without authorization.</p>
<h3>Availability and retention</h3>
<p>The service is provided on an as-available basis and may change. Do not rely on it as the sole archive for irreplaceable work. Private uploads may be removed after a limited retention period, as explained in the <a href="/privacy">Privacy Policy</a>.</p>
<h3>Changes and contact</h3>
<p>The current version of these terms is posted here. For questions, contact GS Grimoire through the <a href="https://www.patreon.com/GSGrimoire" rel="noopener noreferrer">official Patreon page</a>.</p>
</main>`;

const privacy = `
<main>
<h2>Privacy Policy</h2><p class="hint">Effective date: 28 October 2026</p>
<p>This policy describes information processed by GS Poster when authorized GS Grimoire editors use the service. Public information pages can be accessed without logging in.</p>
<h3>Data collected and processed</h3>
<p><strong>Editor authentication:</strong> GitHub account identifiers needed for access authorization, and session cookies for signed-in use and request protection.</p>
<p><strong>Publishing workflow:</strong> Draft captions, post names, planned times, platform selections, approval status, errors, publication identifiers and an audit history of editorial actions.</p>
<p><strong>Media:</strong> Uploaded images, videos and alternative text are held in private object storage or referenced from authorized sources.</p>
<p><strong>Connected platforms:</strong> Account identifiers and authorization credentials used to perform approved actions on connected social media accounts. Secrets are managed on the server and are not intentionally exposed in public pages.</p>
<h3>Purposes</h3>
<p>This information is used to authenticate authorized editors, prepare and approve content, transfer approved media to selected platforms, schedule publishing, display status and history, and investigate failures or misuse. It is not sold to advertisers.</p>
<h3>Service providers and recipients</h3>
<p>GS Poster uses GitHub for editor sign-in, Cloudflare for hosting and storage, and connected publishing platforms, currently Facebook and Bluesky. If an editor connects TikTok, GS Poster processes the account identifier and encrypted authorization tokens needed for selected video and photo transfers. Inbox uploads require manual publication in TikTok. Direct Post testing requires separate video.publish permission and explicit approval, and is restricted to private visibility while unaudited. Temporary unguessable media URLs are served for approved TikTok fetches and expire after three hours. External providers maintain their own privacy policies.</p>
<h3>Retention</h3>
<p>Private media uploads currently have an approximately 45-day storage policy and are not a permanent archive. Post records, activity logs and published or cancelled post history may remain for operational and accountability purposes. Copies delivered to social platforms are subject to those platforms' separate retention practices.</p>
<h3>Security</h3>
<p>The dashboard is protected by restricted sign-in, publishing approval checks, request validation and private media storage. No internet-connected service can guarantee perfect security.</p>
<h3>Your requests and contact</h3>
<p>For access, correction or deletion requests where applicable, or questions about processing, contact the GS Grimoire operator through the <a href="https://www.patreon.com/GSGrimoire" rel="noopener noreferrer">official Patreon page</a>. Do not send passwords, tokens or other confidential information through public comments. Available rights depend on applicable law.</p>
<h3>Changes</h3>
<p>This policy can be updated if integrations or storage practices change. The current version and its effective date are available here.</p>
</main>`;

export function publicPage(which: PublicPage): Response {
  const pages = {
    about: {title:"GS Poster | About",body:about},
    terms: {title:"GS Poster | Terms of Service",body:terms},
    privacy: {title:"GS Poster | Privacy Policy",body:privacy},
  };
  const selected = pages[which];
  return html(page(selected.title,selected.body,{public:true}),{
    headers:{"Cache-Control":"public, max-age=3600"},
  });
}

/** Exact, public callback placeholder. Never logs or echoes auth codes or state. */
export function tiktokCallbackPlaceholder(request: Request): Response {
  if (request.method !== "GET") return new Response("Method not allowed",{
    status:405,headers:{"Allow":"GET","Cache-Control":"no-store"},
  });
  const url = new URL(request.url);
  // Bare URL is reachable for app registration checks, but an actual OAuth
  // redirect must never be treated as successful until state/token handling exists.
  const attemptedAuthorization = url.searchParams.has("code") || url.searchParams.has("state") ||
    url.searchParams.has("error");
  return html(page("TikTok connection not configured",
    '<main><h2>TikTok connection not configured</h2><p>This callback is reserved for the future TikTok integration. No account has been connected or authorized and no TikTok posting is enabled.</p><p><a href="/about">About GS Poster</a></p></main>',
    {public:true}),{status:attemptedAuthorization?503:200});
}
