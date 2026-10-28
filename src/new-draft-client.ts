/** Progressive enhancement for creating a post and uploading its media in one flow.
 * A failed transfer retains the unapproved draft and permits resuming uploads.
 */
export const NEW_DRAFT_JS = String.raw`
(() => {
  const form = document.getElementById("new-draft-form");
  if (!form) return;
  const $ = id => document.getElementById(id);
  const status = $("new-draft-status"), save = $("new-draft-submit");
  const imageInput = $("new-images-input"), videoInput = $("new-video-input");
  const imageList = $("new-images-preview"), videoPreview = $("new-video-preview");
  const time = $("new-when"), asap = $("new-asap"), asapButton = $("new-asap-button");
  let images = [], video = null, videoUrl = null, busy = false, created = null, videoAttached = false;
  const csrf = form.querySelector('input[name="csrf"]').value;

  function kind() { return form.querySelector('input[name="content_kind"]:checked')?.value || "text"; }
  function target(name) { return !!form.querySelector('input[name="' + name + '"]:checked'); }
  function statusText(message) { status.textContent = message; }
  function soonestTime() {
    // Convert 12 minutes from now to the next whole minute in GS Poster's zone.
    const rounded = Math.ceil((Date.now() + 12 * 60000) / 60000) * 60000;
    const fields = new Intl.DateTimeFormat("en-GB", {
      timeZone: form.dataset.zone || "Europe/Copenhagen",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(rounded));
    const part = type => fields.find(x => x.type === type)?.value || "";
    return part("year") + "-" + part("month") + "-" + part("day") +
      "T" + part("hour") + ":" + part("minute");
  }
  asapButton.addEventListener("click", () => {
    asap.value = "1"; asapButton.setAttribute("aria-pressed", "true");
    time.value = soonestTime();
    statusText("Earliest possible release time selected. It will be refreshed when you save.");
  });
  time.addEventListener("input", () => {
    asap.value = "0"; asapButton.setAttribute("aria-pressed", "false");
  });
  function visible() {
    const k = kind(), fb = target("facebook"), bs = target("bluesky");
    $("new-images-panel").hidden = k !== "images";
    $("new-video-panel").hidden = k !== "video";
    $("new-facebook-panel").hidden = !fb;
    $("new-bluesky-panel").hidden = !bs;
    $("new-video-alt-label").hidden = !(bs && k === "video");
    imageList.querySelectorAll("input").forEach(input => input.required = bs && k === "images");
    $("new-video-alt").required = bs && k === "video";
  }
  form.querySelectorAll('input[name="content_kind"],input[name="facebook"],input[name="bluesky"],input[name="tiktok"]')
    .forEach(el => el.addEventListener("change", visible));
  visible();

  function chooseImages(files) {
    if (busy || created) return;
    images = Array.from(files).map(file => ({ file, attached: false, alt: null }));
    imageList.replaceChildren();
    for (const [i, item] of images.entries()) {
      const wrap = document.createElement("div"); wrap.className = "new-file";
      const img = document.createElement("img"); img.alt = "Selected image preview";
      const temp = URL.createObjectURL(item.file); img.src = temp;
      img.addEventListener("load", () => URL.revokeObjectURL(temp), {once:true});
      img.addEventListener("error", () => URL.revokeObjectURL(temp), {once:true});
      const info = document.createElement("div");
      info.textContent = item.file.name + " (" + (item.file.size / 1048576).toFixed(1) + " MB)";
      const label = document.createElement("label");
      label.textContent = "Alternative text for image " + (i+1);
      const alt = document.createElement("input");
      alt.type = "text"; alt.maxLength = 1000;
      alt.placeholder = "Describe what is visible";
      alt.required = target("bluesky");
      item.alt = alt;
      label.append(alt); wrap.append(img, info, label); imageList.append(wrap);
    }
  }
  function chooseVideo(file) {
    if (busy || created || !file) return;
    video = file; videoAttached = false;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file);
    videoPreview.src = videoUrl; videoPreview.hidden = false;
    $("new-video-name").textContent = file.name + " (" + (file.size/1048576).toFixed(1) + " MB)";
  }
  function bindDrop(drop, input, selector) {
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("drag-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", e => {
      e.preventDefault(); drop.classList.remove("drag-over");
      if (e.dataTransfer?.files) selector(e.dataTransfer.files);
    });
  }
  bindDrop($("new-images-drop"), imageInput, files => chooseImages(files));
  bindDrop($("new-video-drop"), videoInput, files => chooseVideo(files[0]));
  imageInput.addEventListener("change", () => chooseImages(imageInput.files || []));
  videoInput.addEventListener("change", () => chooseVideo(videoInput.files?.[0]));

  function verify(k,bs) {
    if (!target("facebook") && !bs && !target("tiktok")) throw new Error("Select Facebook, Bluesky, or TikTok.");
    if(target("tiktok") && k!=="video") throw new Error("TikTok currently supports video uploads only.");
    if (k === "images") {
      if (!images.length) throw new Error("Choose at least one image.");
      if (images.length > (bs ? 4 : 80))
        throw new Error(bs ? "Bluesky permits up to four images." : "Facebook permits up to 80 images.");
      for (const [i, item] of images.entries()) {
        if (!/\.(jpe?g|png|gif)$/i.test(item.file.name) || item.file.size <= 0 ||
            item.file.size > 10 * 1024 * 1024)
          throw new Error("Each image must be JPG, PNG or GIF and no more than 10 MB.");
        if (bs && !item.alt.value.trim())
          throw new Error("Provide alternative text for image " + (i+1) + ".");
      }
    } else if (k === "video") {
      if (!video) throw new Error("Choose an MP4 video.");
      if (!/\.mp4$/i.test(video.name) || video.size <= 0 || video.size > 20000000)
        throw new Error("Video must be an MP4 no larger than 20 MB.");
      if (bs && !$("new-video-alt").value.trim())
        throw new Error("Provide alternative text for your Bluesky video.");
    }
  }
  function recoveryLink() {
    if (!created) return;
    const link = document.createElement("a");
    link.href = "/post/" + encodeURIComponent(created.id);
    link.textContent = "Open the saved draft";
    status.append(" ", link);
  }
  async function api(route, payload) {
    const res = await fetch("/post/" + encodeURIComponent(created.id) + "/" + route, {
      method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({csrf, ...payload})
    });
    const response = await res.json().catch(() => ({}));
    if (!res.ok || response.error) throw new Error(response.error || "Upload request failed ("+res.status+").");
    return response;
  }
  async function upload(file, mediaKind, alt, fb, bs, tt=false) {
    const grant = await api(mediaKind === "video" ? "video-link" : "upload-link", {filename:file.name});
    const transfer = await fetch(grant.upload_url, {
      method:"PUT",credentials:"same-origin",body:file
    });
    const stored = await transfer.json().catch(() => ({}));
    if (!transfer.ok || !stored.ok) throw new Error(stored.error || "Private file transfer failed.");
    const attached = await api(mediaKind === "video" ? "attach-video" : "attach-image", {
      reference:stored.reference,alt,facebook:fb,bluesky:bs,tiktok:tt,
      expected_updated_at:created.version
    });
    created.version = attached.updated_at;
  }

  form.addEventListener("submit", async event => {
    // Native submission remains available for text-only posts.
    if (asap.value === "1") time.value = soonestTime();
    if (kind() === "text" && !created) return;
    event.preventDefault();
    if (busy) return;
    const k = kind(),fb = target("facebook"),bs = target("bluesky");
    try { verify(k,bs); }
    catch(error) { statusText(error.message);return; }
    busy = true; save.disabled = true;
    try {
      if (!created) {
        statusText("Creating unapproved draft...");
        const formBody = new FormData(form);
        formBody.set("content_kind",k);
        const res = await fetch("/new", {
          method:"POST",credentials:"same-origin",
          headers:{"Accept":"application/json"},body:formBody
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.id) throw new Error(body.error || "Could not create the draft.");
        created = {id:body.id,version:body.updated_at};
        form.querySelectorAll('input[name="content_kind"],input[name="facebook"],input[name="bluesky"],input[name="tiktok"]')
          .forEach(el => el.disabled = true);
      }
      if (k === "images") {
        for (const [i,item] of images.entries()) {
          if (item.attached) continue;
          statusText("Uploading image "+(i+1)+" of "+images.length+"...");
          await upload(item.file,"images",item.alt.value.trim(),fb,bs);
          item.attached = true;
        }
      } else if (k === "video" && !videoAttached) {
        statusText("Uploading and attaching video...");
        await upload(video,"video",$("new-video-alt").value.trim(),fb,bs,target("tiktok"));
        videoAttached = true;
      }
      window.location.assign("/post/" + encodeURIComponent(created.id));
    } catch(error) {
      statusText((error instanceof Error ? error.message : String(error)) +
        (created ? " Your draft is saved. You can retry or open it to finish uploading." : ""));
      recoveryLink();
    } finally {busy=false;save.disabled=false;}
  });
})();
`;