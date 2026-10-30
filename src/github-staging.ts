/** Import a GitHub private, uncommitted binary blob into GS Poster's private R2.
 * A staging blob must never be treated as a publishable reference. The only
 * successful result is a stored, owner-scoped upload:// reference.
 */
import type { Env } from "./env.ts";
import { createUpload, extensionOf, handleUploadPut, looksLike, type UploadExt } from "./upload.ts";

const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const PRIVATE_REPO = /^([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9._-]{0,99})$/i;

export interface GitHubBlobImport {
  filename: string;
  blob_sha: string;
  expected_sha256?: string;
}
export interface ImportedBlob {
  reference: string;
  bytes: number;
  sha256: string;
  status: "stored";
}

/** A separate private repository is configured server-side, never supplied by a chat client. */
export function getStagingRepo(env: Env): { owner: string; repo: string } {
  const match = PRIVATE_REPO.exec(env.GITHUB_STAGING_REPO?.trim() || "");
  if (!match) throw new Error("Private GitHub staging is not configured (GITHUB_STAGING_REPO).");
  if (!env.GITHUB_READ_TOKEN) throw new Error("Private GitHub staging requires GITHUB_READ_TOKEN.");
  if (!env.UPLOADS) throw new Error("GS Poster private upload storage is unavailable.");
  return { owner: match[1], repo: match[2] };
}

function maxBytes(ext: UploadExt): number {
  return ext === "mp4" ? 20_000_000 : 10 * 1024 * 1024;
}

/** Read-only configuration probe. Never returns or logs the GitHub token. */
export async function verifyPrivateStagingRepo(
  env: Env,
  request: typeof fetch = fetch,
): Promise<{ok:true; private:true}> {
  const {owner,repo} = getStagingRepo(env);
  let response: Response;
  try {
    response = await request("https://api.github.com/repos/" + owner + "/" + repo,{
      headers: {
        "Authorization": "Bearer " + env.GITHUB_READ_TOKEN,
        "User-Agent": "gs-poster",
        "X-GitHub-Api-Version": "2022-11-28",
        "Accept": "application/vnd.github+json",
      },
      // Do not follow a redirect while carrying a private-repository token.
      // A renamed repository must instead be corrected in Cloudflare Secrets.
      redirect:"manual",
    });
  } catch {
    throw new Error("GitHub staging HTTPS request failed before an HTTP response.");
  }
  if (!response.ok) {
    // Report only the HTTP category, never a URL, body or credential.
    const code = response.status;
    if (code >= 300 && code < 400)
      throw new Error("GitHub staging repository lookup redirected (HTTP " + code + "). Verify the exact repository slug in Cloudflare Secrets.");
    if (code === 401) throw new Error("GitHub staging token was rejected (HTTP 401).");
    if (code === 403) throw new Error("GitHub staging token lacks access or is rate-limited (HTTP 403).");
    if (code === 404) throw new Error("GitHub staging repository was not found for this token (HTTP 404). Verify its exact owner/repo and token repository selection.");
    throw new Error("GitHub staging repository check returned HTTP " + code + ".");
  }
  let metadata: unknown;
  try { metadata = await response.json(); }
  catch { throw new Error("GitHub staging repository metadata was not valid JSON."); }
  if (!metadata || typeof metadata !== "object" ||
      (metadata as {private?: unknown}).private !== true)
    throw new Error("GitHub staging repository metadata did not confirm a private repository.");
  return {ok:true,private:true};
}

export async function fetchStagedBlob(
  env: Env,
  input: GitHubBlobImport,
  request: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; sha256: string }> {
  const {owner, repo} = getStagingRepo(env);
  const ext = extensionOf(input.filename);
  if (!ext) throw new Error("Only JPG, PNG, GIF or MP4 files can be imported.");
  if (!SHA1.test(input.blob_sha)) throw new Error("Invalid GitHub blob SHA.");
  if (input.expected_sha256 && !SHA256.test(input.expected_sha256))
    throw new Error("Expected SHA-256 must contain 64 hexadecimal characters.");
  const limit = maxBytes(ext);
  const repositoryUrl = "https://api.github.com/repos/" + owner + "/" + repo;
  const authHeaders = {
    "Authorization": "Bearer " + env.GITHUB_READ_TOKEN,
    "User-Agent": "gs-poster",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Do not import media from an inaccessible or public staging repository.
  await verifyPrivateStagingRepo(env,request);
  // Cloudflare Workers supports redirect:"manual", not redirect:"error".
  // Never follow an authenticated GitHub request to another origin.
  let response: Response;
  try {
    response = await request(
      repositoryUrl + "/git/blobs/" + input.blob_sha.toLowerCase(),
      {
        headers: {...authHeaders, "Accept": "application/vnd.github.raw+json"},
        redirect: "manual",
      },
    );
  } catch {
    throw new Error("Private GitHub blob request failed before an HTTP response.");
  }
  if (response.status >= 300 && response.status < 400)
    throw new Error("Private GitHub blob download redirected; refusing to forward authorization.");
  if (!response.ok) throw new Error("Private GitHub blob could not be read (HTTP " + response.status + ").");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new Error("GitHub blob exceeds the permitted file size.");
  if (!response.body) throw new Error("GitHub returned an empty media response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("GitHub blob exceeds the permitted file size.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (total === 0) throw new Error("GitHub returned an empty blob.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  if (!looksLike(ext,bytes.subarray(0,Math.min(16,total))))
    throw new Error("GitHub blob content does not match its declared media type.");
  const digest = await crypto.subtle.digest("SHA-256",bytes.buffer);
  const sha256 = Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,"0")).join("");
  if (input.expected_sha256 && sha256 !== input.expected_sha256.toLowerCase())
    throw new Error("GitHub blob SHA-256 does not match the original attachment.");
  return {bytes,sha256};
}

export async function importStagedGitHubBlob(
  env: Env, origin: string, login: string, input: GitHubBlobImport,
  request: typeof fetch = fetch,
): Promise<ImportedBlob> {
  if (!login.trim()) throw new Error("Authenticated GitHub owner identity is required.");
  // Download and validate BEFORE reserving any upload or writing into R2.
  const {bytes,sha256} = await fetchStagedBlob(env,input,request);
  const grant = await createUpload(env,origin,{filename:input.filename,actor:login});
  // Reuse the identical one-use token, size, format and atomic storage checks
  // as the browser uploader. The temporary bearer URL never leaves this Worker.
  const stored = await handleUploadPut(new Request(grant.upload_url,{
    method:"PUT",
    headers:{"Content-Length":String(bytes.byteLength)},
    body:bytes,
  }),env);
  if (!stored.ok) throw new Error("GitHub media was read, but private storage could not confirm import.");
  return {reference:grant.reference,bytes:bytes.byteLength,sha256,status:"stored"};
}
