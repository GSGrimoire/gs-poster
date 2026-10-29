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
  const summary = id => $(id);
  const mainCaption = $("new-message"), bsCaption = $("new-bs"),ttCaption=$("new-tiktok-caption");
  const platformLimits={facebook:80,tiktok:35,bluesky:4};
  const selectedCount=name=>images.filter(item=>target(name)&&item.targets?.[name]?.checked).length;
  const mediaTargets=item=>["facebook","tiktok","bluesky"].filter(name=>target(name)&&item.targets?.[name]?.checked);
  const platformTotals=()=>["facebook","tiktok","bluesky"].filter(target).map(name=>
    name[0].toUpperCase()+name.slice(1)+" "+selectedCount(name)+"/"+platformLimits[name]).join(" · ");
  function updateProgress(done,total) {
    const pct=total ? Math.round(done/total*100) : 0;
    summary("new-upload-progress").setAttribute("aria-valuenow",String(pct));
    summary("new-progress-fill").style.width=pct+"%";
    summary("new-progress-caption").textContent=total ?
      done+" of "+total+" media files attached to this draft" :
      "Media will upload only after you save.";
  }
  function mediaCount(){
    const count=images.length;
    const warning=["facebook","tiktok","bluesky"].some(name=>target(name)&&selectedCount(name)>platformLimits[name]);
    $("new-image-count").textContent=count?
      count+" file"+(count!==1?"s":"")+" · "+platformTotals() :
      "No images selected · choose destination(s) per image";
    $("new-image-count").classList.toggle("media-error",warning);
    $("new-platform-counts").textContent=kind()==="images"?platformTotals():
      kind()==="video"?"The selected video will be attached only to chosen destinations":"Text-only";
  }
  function updateSummary() {
    const k=kind(),tt=target("tiktok"),bs=target("bluesky");
    const platforms=["facebook","bluesky","tiktok"].filter(target).map(x=>x==="facebook"?"Facebook":x==="bluesky"?"Bluesky":"TikTok");
    summary("summary-platforms").textContent=platforms.length ? platforms.join(" · ") : "None selected";
    summary("summary-format").textContent=k==="images"?"Image carousel":k==="video"?"Video":"Text";
    summary("summary-media").textContent=k==="images" ? images.length+" source images" :
      k==="video" ? (video ? video.name : "No video selected") : "Text only";
    summary("summary-timing").textContent=asap.value==="1" ? "Earliest available" :
      time.value ? time.value.replace("T"," ") : "Unscheduled";
    let warning="";
    if(!platforms.length)warning="Select a destination";
    else if(tt&&k==="text")warning="Choose images or video for TikTok";
    else if(tt&&(ttCaption.value.trim()||mainCaption.value).length>(k==="video"?2200:4000))warning="Shorten TikTok caption";
    else if(k==="images"&&!images.length)warning="Add artwork";
    else if(k==="images"&&["facebook","tiktok","bluesky"].some(name=>target(name)&&selectedCount(name)>platformLimits[name])) warning="Reduce images for the highlighted destination";
    else if(k==="images"&&["facebook","tiktok","bluesky"].some(name=>target(name)&&!selectedCount(name)&&
      !(name==="facebook"&&mainCaption.value.trim())&&!(name==="bluesky"&&bsCaption.value.trim())))
      warning="Assign media or write a text-only caption for each destination";
    else if(k==="images"&&bs&&images.some(x=>x.targets?.bluesky?.checked&&!x.alt?.value.trim()))warning="Describe selected Bluesky images";
    else if(k==="video"&&!video)warning="Add an MP4";
    else if(k==="video"&&bs&&!$("new-video-alt").value.trim())warning="Describe Bluesky video";
    summary("summary-readiness").textContent=created?"Draft saved, upload in progress":warning||"Ready to save";
    summary("new-tiktok-caption-advice").hidden=!tt;
    summary("new-tiktok-panel").hidden=!tt;
    summary("new-facebook-panel").hidden=!target("facebook");
    const max=63206;
    summary("new-main-count").textContent=mainCaption.value.length+" / "+max;
    summary("new-main-count").classList.toggle("media-error",mainCaption.value.length>max);
    summary("new-bs-count").textContent=bsCaption.value.length+" / 300";
    summary("new-tiktok-count").textContent=(ttCaption.value.trim()||mainCaption.value).length+" / "+(k==="video"?2200:4000);
    summary("new-tiktok-count").classList.toggle("media-error",tt && (ttCaption.value.trim()||mainCaption.value).length>(k==="video"?2200:4000));
    summary("new-timing-advice").textContent=tt?
      "The calendar time is for planning. TikTok does not publish automatically; later select an inbox upload or private test post and approve with your PIN." :
      "Saving is never approval. Facebook and Bluesky publish only after separate approval with your PIN.";
    mediaCount();
  }
  function renumberImages() {
    for(const [index,item] of images.entries()) {
      item.number.textContent="Image "+(index+1)+" of "+images.length;
      item.label.firstChild.textContent="Alternative text for image "+(index+1);
      item.up.disabled=index===0;
      item.down.disabled=index===images.length-1;
    }
    imageList.replaceChildren(...images.map(item=>item.wrap));
    updateSummary();
  }
  function moveImage(item,delta) {
    if(busy||created)return;
    const index=images.indexOf(item);
    const next=index+delta;
    if(index<0||next<0||next>=images.length)return;
    images.splice(index,1);
    images.splice(next,0,item);
    renumberImages();
    item.wrap.focus();
  }


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
    updateSummary();
  });
  time.addEventListener("input", () => {
    asap.value = "0"; asapButton.setAttribute("aria-pressed", "false");
    updateSummary();
  });
  $("new-clear-time").addEventListener("click", () => {
    time.value="";asap.value="0";
    asapButton.setAttribute("aria-pressed","false");
    updateSummary();
  });
  [mainCaption,bsCaption,ttCaption,$("new-video-alt")].forEach(input=>input.addEventListener("input",updateSummary));
  function visible() {
    let k=kind();
    const tt=target("tiktok"),fb=target("facebook"),bs=target("bluesky");
    if(tt&&k==="text") {
      form.querySelector('input[name="content_kind"][value="images"]').checked=true;
      k="images";
      statusText("TikTok needs images or video. Image carousel selected.");
    }
    $("new-images-panel").hidden=k!=="images";
    $("new-video-panel").hidden=k!=="video";
    $("new-facebook-panel").hidden=!fb;
    $("new-bluesky-panel").hidden=!bs;
    $("new-video-alt-label").hidden=!(bs&&k==="video");
    for(const item of images){
      item.alt.required=bs&&k==="images"&&!!item.targets?.bluesky?.checked;
      if(item.label)item.label.hidden=!item.alt.required;
      if(item.targetContainer)for(const [name,node] of Object.entries(item.targetLabels)) node.hidden=!target(name);
    }
    $("new-video-alt").required=bs&&k==="video";
    $("new-platform-advice").textContent=tt?
      "TikTok images and videos can go to your inbox for manual publication. Private direct posts are a separate, explicitly approved action. Calendar times never auto-publish to TikTok.":
      "Facebook and Bluesky publication requires your approval PIN. Save here only creates a draft.";
    updateSummary();
  }
  form.querySelectorAll('input[name="content_kind"],input[name="facebook"],input[name="bluesky"],input[name="tiktok"]')
    .forEach(el => el.addEventListener("change", visible));
  visible();

  function chooseImages(files) {
    if(busy||created)return;
    const offset=images.length;
    const additions=Array.from(files).map((file,index)=>({file,order:offset+index,attached:false,alt:null,targets:{}}));
    images.push(...additions);
    for(const item of additions){
      const wrap=document.createElement("article");
      wrap.className="new-file";
      wrap.tabIndex=-1;
      wrap.setAttribute("aria-label","Selected carousel image");
      const img=document.createElement("img");
      img.alt="Selected image preview";
      const temp=URL.createObjectURL(item.file);img.src=temp;
      img.addEventListener("load",()=>URL.revokeObjectURL(temp),{once:true});
      img.addEventListener("error",()=>URL.revokeObjectURL(temp),{once:true});
      const title=document.createElement("div");
      title.className="file-title";
      const number=document.createElement("div");number.className="gallery-number";
      const info=document.createElement("span");
      info.textContent=item.file.name+" ("+(item.file.size/1048576).toFixed(1)+" MB)";
      title.append(number,info);
      const controls=document.createElement("div");controls.className="gallery-controls";
      const action=(name,delta)=>{
        const button=document.createElement("button");button.type="button";
        button.textContent=name;
        button.setAttribute("aria-label",name+" "+item.file.name);
        button.addEventListener("click",()=>delta===null?remove():moveImage(item,delta));
        controls.append(button);return button;
      };
      const remove=()=>{
        if(busy||created)return;
        const index=images.indexOf(item);
        if(index>=0)images.splice(index,1);
        wrap.remove();renumberImages();
      };
      const up=action("Move up",-1),down=action("Move down",1);
      action("Remove",null);
      const destinations=document.createElement("div");
      destinations.className="new-target-choices";
      destinations.setAttribute("role","group");
      destinations.setAttribute("aria-label","Destinations for "+item.file.name);
      item.targetContainer=destinations;
      item.targetLabels={};
      for(const [name,title] of [["facebook","Facebook"],["tiktok","TikTok"],["bluesky","Bluesky"]]){
        const platformLabel=document.createElement("label");
        platformLabel.hidden=!target(name);
        const check=document.createElement("input");
        check.type="checkbox";
        check.checked=target(name)&&(name==="bluesky"?item.order<4:name==="tiktok"?item.order<35:true);
        check.setAttribute("aria-label",title+" for "+item.file.name);
        check.addEventListener("change",()=>{
          item.alt.required=target("bluesky")&&!!item.targets.bluesky.checked;
          item.label.hidden=!item.alt.required;
          updateSummary();
        });
        platformLabel.append(check,document.createTextNode(title));
        destinations.append(platformLabel);
        item.targets[name]=check;item.targetLabels[name]=platformLabel;
      }
      const label=document.createElement("label");
      label.textContent="Alternative text for image";
      const alt=document.createElement("input");
      alt.type="text";alt.maxLength=1000;
      alt.placeholder="Describe what is visible";
      alt.required=target("bluesky");
      alt.addEventListener("input",updateSummary);
      label.append(alt);
      wrap.append(img,title,destinations,controls,label);
      label.hidden=!item.targets.bluesky.checked;
      item.alt=alt;item.wrap=wrap;item.number=number;item.label=label;
      item.up=up;item.down=down;
    }
    renumberImages();
    visible();
  }

  function chooseVideo(file) {
    if (busy || created || !file) return;
    video = file; videoAttached = false;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file);
    videoPreview.src = videoUrl; videoPreview.hidden = false;
    $("new-video-name").textContent = file.name + " (" + (file.size/1048576).toFixed(1) + " MB)";
    updateSummary();
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
    if(target("tiktok") && !["video","images"].includes(k)) throw new Error("TikTok requires video or images.");
    if (k === "images") {
      if (!images.length) throw new Error("Choose at least one image.");
      for(const name of ["facebook","tiktok","bluesky"]){
        if(!target(name))continue;
        const count=selectedCount(name);
        if(!count){
          if(name==="facebook"&&mainCaption.value.trim())continue;
          if(name==="bluesky"&&bsCaption.value.trim())continue;
          throw new Error("Choose an image or provide a text-only caption for "+name+".");
        }
        if(count>platformLimits[name])throw new Error(name+" supports up to "+platformLimits[name]+" images.");
      }
      for(const [i,item] of images.entries()){
        if(!/\.(jpe?g|png|gif)$/i.test(item.file.name)||item.file.size<=0||item.file.size>10*1024*1024)
          throw new Error("Each image must be JPG, PNG or GIF and no more than 10 MB.");
        if(!mediaTargets(item).length)throw new Error("Select at least one destination for image "+(i+1)+".");
        if(bs&&item.targets.bluesky.checked&&!item.alt.value.trim())
          throw new Error("Describe image "+(i+1)+" for Bluesky.");
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
    updateProgress(0,k==="images"?images.length:k==="video"?1:0);
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
        statusText("Draft saved. Attaching its media now. To edit captions or scheduling after a failed upload, open the saved draft.");
        updateSummary();
      }
      if (k === "images") {
        for (const [i,item] of images.entries()) {
          if (item.attached) continue;
          statusText("Uploading image "+(i+1)+" of "+images.length+"...");
          await upload(item.file,"images",item.alt.value.trim(),fb&&item.targets.facebook.checked,bs&&item.targets.bluesky.checked,target("tiktok")&&item.targets.tiktok.checked);
          item.attached = true;
          updateProgress(images.filter(x=>x.attached).length,images.length);
        }
      } else if (k === "video" && !videoAttached) {
        statusText("Uploading and attaching video...");
        await upload(video,"video",$("new-video-alt").value.trim(),fb,bs,target("tiktok"));
        videoAttached = true;
        updateProgress(1,1);
      }
      window.location.assign("/post/" + encodeURIComponent(created.id));
    } catch(error) {
      statusText((error instanceof Error ? error.message : String(error)) +
        (created ? " Your draft is saved. You can retry or open it to finish uploading." : ""));
      recoveryLink();
    } finally {busy=false;save.disabled=false;updateSummary();}
  });
})();
`;