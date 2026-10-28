import { esc } from "./html.ts";
import type { Post } from "./db.ts";

/** Does not grant approval or change media for already approved posts. */
export function draftMediaPanel(post: Post, csrf: string): string {
  if (!["draft","rejected"].includes(post.status) || post.approved_at) return "";
  return `
<style>
.media-drop{border:2px dashed var(--line);border-radius:9px;padding:18px;text-align:center;font:14px system-ui,sans-serif;cursor:pointer;transition:background .15s}
.media-drop:focus,.media-drop:hover,.media-drop.drag-over{border-color:var(--accent2);background:color-mix(in srgb,var(--accent2) 10%,var(--panel))}
.media-files{display:grid;gap:12px;margin:12px 0}
.media-upload-item{border:1px solid var(--line);padding:12px;border-radius:8px;display:grid;gap:7px}
.media-upload-item img{width:100px;height:100px;object-fit:contain;background:#0002;border-radius:6px}
.media-upload-item input[type=text]{width:100%}
.media-upload-item .media-status{font:13px system-ui,sans-serif;color:var(--muted)}
.media-targets{display:flex;gap:15px;flex-wrap:wrap}
.media-targets label{margin:0;display:flex;align-items:center;gap:7px}
</style>
<div class="card" id="draft-media-panel" data-post="${esc(post.id)}" data-csrf="${esc(csrf)}"
 data-version="${esc(post.updated_at)}" data-facebook="${post.facebook_enabled ? "1" : "0"}"
 data-bluesky="${post.bluesky ? "1" : "0"}" data-facebook-images="${post.images.length}" data-bluesky-images="${post.bluesky?.images.length ?? 0}">
  <h2>Add images to this draft</h2>
  <p class="hint">Drop JPG, PNG or GIF images here, or select files. Files go into GS Poster's private storage and are attached to the chosen draft targets. No GitHub image commit and no publishing.</p>
  <div id="media-drop" class="media-drop" tabindex="0" role="button" aria-label="Select or drop images">
    Drop images here, or click to choose
    <input type="file" id="media-files" accept=".jpg,.jpeg,.png,.gif,image/jpeg,image/png,image/gif" multiple hidden>
  </div>
  <div id="media-upload-items" class="media-files" aria-live="polite"></div>
  <p class="hint">Provide descriptive alternative text for each Bluesky image. Maximum 4 Bluesky images, 80 Facebook images. Private uploads expire after 45 days, so do not schedule posts using them more than 45 days out.</p>
  <div class="row"><button type="button" class="primary" id="media-upload-submit" disabled>Upload and attach images</button></div>
  <div role="status" id="media-upload-status" class="hint" aria-live="polite"></div>
  <h2>${post.video || post.bluesky?.video ? "Replace video in this draft" : "Add a video to this draft"}</h2>
  <p class="hint">MP4 up to 20 MB. Videos and image galleries cannot be combined on the same platform. Uploading a new video replaces the previous video only on the platforms you select. No publication takes place.</p>
  <div id="video-drop" class="media-drop" tabindex="0" role="button" aria-label="Select or drop MP4">
    Drop MP4 here, or click to choose
    <input type="file" id="video-file" accept=".mp4,video/mp4" hidden>
  </div>
  <video controls playsinline preload="metadata" id="video-preview" hidden style="max-width:100%;max-height:280px;margin-top:12px"></video>
  <p id="video-filename" class="hint"></p>
  <div class="media-targets">
    <label><input type="checkbox" id="video-facebook" ${post.facebook_enabled && !post.images.length ? "checked" : "disabled"}>Facebook</label>
    <label><input type="checkbox" id="video-bluesky" ${post.bluesky && !post.bluesky.images.length ? "checked" : "disabled"}>Bluesky</label>
  </div>
  <label for="video-alt">Bluesky video alternative text</label>
  <input type="text" id="video-alt" maxlength="1000" placeholder="Describe the visible action in this video">
  <div class="row"><button type="button" class="primary" id="video-upload-submit" disabled>${post.video || post.bluesky?.video ? "Upload and replace video" : "Upload and attach video"}</button></div>
  <div id="video-upload-status" class="hint" role="status" aria-live="polite"></div>
</div>
<script src="/draft-media.js" defer></script>
`;
}

/** Single same-origin script; everything else is served by authenticated routes. */
export const DRAFT_MEDIA_JS = `
(() => {
  const panel = document.getElementById("draft-media-panel");
  if (!panel) return;
  const drop = document.getElementById("media-drop");
  const input = document.getElementById("media-files");
  const queue = document.getElementById("media-upload-items");
  const submit = document.getElementById("media-upload-submit");
  const status = document.getElementById("media-upload-status");
  let files = [];
  let running = false;
  let currentVersion = panel.dataset.version;
  const post = panel.dataset.post;
  const csrf = panel.dataset.csrf;

  const videoInput = document.getElementById("video-file");
  const videoDrop = document.getElementById("video-drop");
  const videoPreview = document.getElementById("video-preview");
  const videoName = document.getElementById("video-filename");
  const videoSubmit = document.getElementById("video-upload-submit");
  const videoStatus = document.getElementById("video-upload-status");
  const videoFacebook = document.getElementById("video-facebook");
  const videoBluesky = document.getElementById("video-bluesky");
  const videoAlt = document.getElementById("video-alt");
  let selectedVideo = null;
  let previewUrl = null;
  function chooseVideo(file) {
    if (running || !file) return;
    if (!file.name.toLowerCase().endsWith(".mp4") || file.size <= 0 || file.size > 20_000_000) {
      videoStatus.textContent = "Choose a nonempty MP4 up to 20 MB.";return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    selectedVideo = file;
    previewUrl = URL.createObjectURL(file);
    videoPreview.src = previewUrl;videoPreview.hidden = false;
    videoName.textContent = file.name+" ("+(file.size/1048576).toFixed(1)+" MB)";
    videoSubmit.disabled = videoFacebook.disabled && videoBluesky.disabled;
    videoStatus.textContent = "";
  }
  videoDrop.addEventListener("click", () => videoInput.click());
  videoDrop.addEventListener("keydown", e => {
    if(e.key==="Enter" || e.key===" ") {e.preventDefault();videoInput.click();}
  });
  videoDrop.addEventListener("dragover", e=>{e.preventDefault();videoDrop.classList.add("drag-over");});
  videoDrop.addEventListener("dragleave",()=>videoDrop.classList.remove("drag-over"));
  videoDrop.addEventListener("drop",e=>{
    e.preventDefault();videoDrop.classList.remove("drag-over");
    chooseVideo(e.dataTransfer?.files?.[0]);
  });
  videoInput.addEventListener("change",()=>{
    chooseVideo(videoInput.files?.[0]);videoInput.value="";
  });

  function showError(error) { status.textContent = error instanceof Error ? error.message : String(error); }
  function choose(fileList) {
    if (running) return;
    const selected = Array.from(fileList);
    for (const file of selected) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (ext === "mp4") {chooseVideo(file);continue;}
      if (!["jpg","jpeg","png","gif"].includes(ext) || file.size <= 0 || file.size > 10 * 1024 * 1024) {
        status.textContent = "Only JPG, PNG or GIF files between 1 byte and 10 MB can be uploaded.";
        continue;
      }
      const record = { file, node: null, alt: null, facebook: null, bluesky: null, result: null };
      const item = document.createElement("div");
      item.className = "media-upload-item";
      const preview = document.createElement("img");
      preview.alt = "Selected image preview";
      const blobUrl = URL.createObjectURL(file);
      preview.src = blobUrl;
      preview.onload = () => URL.revokeObjectURL(blobUrl);
      const name = document.createElement("strong");
      name.textContent = file.name + " (" + (file.size/1048576).toFixed(1) + " MB)";
      const targets = document.createElement("div");
      targets.className = "media-targets";
      for (const [kind, enabled, label] of [
        ["facebook",panel.dataset.facebook==="1","Facebook"],
        ["bluesky",panel.dataset.bluesky==="1","Bluesky"]
      ]) {
        if (!enabled) continue;
        const text = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";box.checked = true;
        if (kind === "facebook") record.facebook = box; else record.bluesky = box;
        text.append(box, document.createTextNode(label)); targets.append(text);
      }
      const altLabel = document.createElement("label");
      altLabel.textContent = "Alternative text for Bluesky";
      const alt = document.createElement("input");
      alt.type = "text";alt.maxLength = 1000;
      alt.placeholder = "Describe what is visible in this image";
      altLabel.append(alt);
      record.alt = alt;
      if (!record.bluesky) altLabel.hidden = true;
      else record.bluesky.addEventListener("change", () => { altLabel.hidden = !record.bluesky.checked; });
      const progress = document.createElement("span");
      progress.className = "media-status";progress.textContent = "Ready";
      record.result = progress;record.node = item;
      item.append(preview,name,targets,altLabel,progress);queue.append(item);
      files.push(record);
    }
    submit.disabled = files.length === 0;
  }
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", e => {if(e.key==="Enter"||e.key===" "){e.preventDefault();input.click();}});
  input.addEventListener("change", () => { choose(input.files);input.value=""; });
  drop.addEventListener("dragover",e => {e.preventDefault();drop.classList.add("drag-over");});
  drop.addEventListener("dragleave",()=>drop.classList.remove("drag-over"));
  drop.addEventListener("drop", e => {
    e.preventDefault();drop.classList.remove("drag-over");
    if(e.dataTransfer?.files) choose(e.dataTransfer.files);
  });

  async function api(route, payload) {
    const r = await fetch("/post/"+encodeURIComponent(post)+"/"+route, {
      method:"POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({csrf, ...payload})
    });
    const v = await r.json().catch(() => ({}));
    if (!r.ok || v.error) throw new Error(v.error || "Request failed ("+r.status+").");
    return v;
  }

  videoSubmit.addEventListener("click",async()=>{
    if(running || !selectedVideo)return;
    const facebook=!!videoFacebook.checked,bluesky=!!videoBluesky.checked;
    if (!facebook && !bluesky) {videoStatus.textContent="Choose at least one available platform.";return;}
    const alt=videoAlt.value.trim();
    if (bluesky && !alt) {videoStatus.textContent="Bluesky requires alternative text.";return;}
    running=true;videoSubmit.disabled=true;
    try {
      videoStatus.textContent="Creating private upload...";
      const grant=await api("video-link",{filename:selectedVideo.name});
      videoStatus.textContent="Uploading video...";
      const uploaded=await fetch(grant.upload_url,{method:"PUT",body:selectedVideo,credentials:"same-origin"});
      const body=await uploaded.json().catch(()=>({}));
      if (!uploaded.ok || !body.ok)throw new Error(body.error || "Video upload failed.");
      videoStatus.textContent="Attaching video to the draft...";
      const saved=await api("attach-video",{
        reference:body.reference,alt,facebook,bluesky,expected_updated_at:currentVersion
      });
      currentVersion=saved.updated_at;
      videoStatus.textContent="Video attached. Refreshing...";
      location.reload();
    } catch(error) {
      videoStatus.textContent="Could not attach: "+(error instanceof Error?error.message:String(error));
      videoSubmit.disabled=false;
    } finally {running=false;}
  });
  submit.addEventListener("click", async () => {
    if (running) return;
    running = true;submit.disabled = true;status.textContent = "";
    let completed = 0;
    for (const item of files) {
      if (item.result.textContent === "Attached") continue;
      try {
        const facebook = !!item.facebook?.checked;
        const bluesky = !!item.bluesky?.checked;
        const alt = item.alt.value.trim();
        if (!facebook && !bluesky) throw new Error("Choose at least one platform.");
        if (bluesky && !alt) throw new Error("Bluesky needs image alternative text.");
        item.result.textContent = "Creating private upload...";
        const grant = await api("upload-link", {filename:item.file.name});
        item.result.textContent = "Uploading image...";
        const uploaded = await fetch(grant.upload_url, {method:"PUT",body:item.file,credentials:"same-origin"});
        const uploadedBody = await uploaded.json().catch(() => ({}));
        if (!uploaded.ok || !uploadedBody.ok) throw new Error(uploadedBody.error || "Upload transfer failed.");
        item.result.textContent = "Attaching to draft...";
        const result = await api("attach-image", {reference:uploadedBody.reference, alt,facebook,bluesky,expected_updated_at:currentVersion});
        currentVersion = result.updated_at;
        item.result.textContent = "Attached";
        completed++;
      } catch (error) {
        item.result.textContent = "Could not attach: "+(error instanceof Error?error.message:String(error));
        status.textContent = "Some files could not be attached. Check each item before trying again.";
        // Stop after concurrency errors so subsequent files cannot clobber a newer draft.
        break;
      }
    }
    running = false;submit.disabled = false;
    if (completed && files.every(x=>x.result.textContent === "Attached")) {
      status.textContent = "All images attached. Refreshing post preview...";
      location.reload();
    }
  });
})();
`;
