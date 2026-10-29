/** Private browser companion to a one-time MCP upload link. */
import type {Env} from "./env.ts";
import {esc,html,page} from "./html.ts";
import {pendingUploadPageInfo} from "./upload.ts";

export const CHAT_UPLOAD_JS=String.raw`
(() => {
  const form=document.getElementById("chat-upload-form");
  if(!form)return;
  const input=document.getElementById("chat-upload-file");
  const drop=document.getElementById("chat-upload-drop");
  const status=document.getElementById("chat-upload-status");
  const send=document.getElementById("chat-upload-submit");
  const success=document.getElementById("chat-upload-success");
  const reference=document.getElementById("chat-upload-reference");
  const copy=document.getElementById("chat-upload-copy");
  const hint=document.getElementById("chat-upload-fileinfo");
  const limit=Number(form.dataset.max);
  const ext=form.dataset.ext;
  let selected=null,busy=false;
  function message(text,problem=false){
    status.textContent=text;
    status.classList.toggle("media-error",problem);
  }
  function select(file){
    if(busy||!file)return;
    selected=null;send.disabled=true;
    const suffix=file.name.split(".").pop().toLowerCase();
    const valid=ext==="jpg"||ext==="jpeg"?["jpg","jpeg"].includes(suffix):suffix===ext;
    if(!valid){message("Choose a "+ext.toUpperCase()+" file. This link cannot accept a different format.",true);return;}
    if(file.size<=0||file.size>limit){
      message("File must be nonempty and at most "+(limit/1048576).toFixed(1)+" MB.",true);return;
    }
    selected=file;send.disabled=false;
    hint.textContent=file.name+" · "+(file.size/1048576).toFixed(2)+" MB";
    message("Ready to upload. Nothing will be published.");
  }
  input.addEventListener("change",()=>select(input.files?.[0]));
  drop.addEventListener("click",()=>input.click());
  drop.addEventListener("keydown",event=>{
    if(event.key==="Enter"||event.key===" "){event.preventDefault();input.click();}
  });
  drop.addEventListener("dragover",event=>{event.preventDefault();drop.classList.add("drag-over");});
  drop.addEventListener("dragleave",()=>drop.classList.remove("drag-over"));
  drop.addEventListener("drop",event=>{
    event.preventDefault();drop.classList.remove("drag-over");select(event.dataTransfer?.files?.[0]);
  });
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    if(!selected||busy)return;
    busy=true;send.disabled=true;input.disabled=true;
    message("Uploading securely to private GS Poster storage...");
    try {
      const result=await fetch(window.location.pathname,{
        method:"PUT",body:selected,credentials:"omit",redirect:"manual",referrerPolicy:"no-referrer",
      });
      const response=await result.json().catch(()=>({}));
      if(!result.ok||!response.ok||!response.reference)
        throw Error(response.error||"Upload was not confirmed ("+result.status+").");
      form.hidden=true;success.hidden=false;reference.value=response.reference;
      message("Upload complete. Return to your Claude or ChatGPT conversation and continue the draft.");
      if(window.history?.replaceState)window.history.replaceState(null,"","/upload-complete");
    }catch(error){
      message((error instanceof Error?error.message:String(error))+
        " If this link expired or was consumed, ask the assistant for a fresh upload link.",true);
    }finally{busy=false;}
  });
  copy.addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText(reference.value);copy.textContent="Copied";}
    catch{reference.focus();reference.select();copy.textContent="Select and copy the reference";}
  });
})();
`;

export async function browserUploadPage(req:Request,env:Env):Promise<Response> {
  if(req.method!=="GET")return new Response("Method not allowed",{status:405,headers:{Allow:"GET"}});
  const match=/^\/upload\/([a-f0-9]{32})\/([A-Za-z0-9_-]{20,64})$/.exec(new URL(req.url).pathname);
  if(!match)return new Response("Not found",{status:404});
  const info=await pendingUploadPageInfo(env.DB,match[1],match[2]);
  if(!info)return html(page("Upload link unavailable",
    '<div class="notice err">This upload link is expired, already used or invalid. Ask your chat assistant for a new one.</div>'),
    {status:404,headers:{"Referrer-Policy":"no-referrer"}});
  const accept=info.ext==="mp4"?".mp4,video/mp4":
    info.ext==="png"?".png,image/png":info.ext==="gif"?".gif,image/gif":
    ".jpg,.jpeg,image/jpeg";
  const body=`
    <div class="hero">
      <div class="hero-kicker">GS Grimoire · Private chat media intake</div>
      <h2>Send your creation to GS Poster.</h2>
      <p>Upload straight into private storage. No GitHub staging, no public image address, and no publishing until you approve separately.</p>
    </div>
    <style>
    #chat-upload-drop{padding:36px 16px;border:2px dashed var(--line);border-radius:12px;text-align:center;
      cursor:pointer;background:var(--bg);font:650 15px system-ui,sans-serif}
    #chat-upload-drop:hover,#chat-upload-drop:focus-visible,#chat-upload-drop.drag-over{
      border-color:var(--accent2);background:var(--surface2)}
    #chat-upload-form[hidden],#chat-upload-success[hidden]{display:none!important}
    #chat-upload-fileinfo{font:13px system-ui,sans-serif;margin:12px 0;color:var(--muted)}
    </style>
    <form class="step-card" id="chat-upload-form" data-ext="${esc(info.ext)}" data-max="${info.maxBytes}">
      <div class="step-heading"><span class="step-number">1</span><div><h3>Select your media</h3>
      <p class="hint">This one-use link accepts a ${esc(info.ext.toUpperCase())} file, up to ${(info.maxBytes/1048576).toFixed(1)} MB.</p></div></div>
      <div role="button" tabindex="0" id="chat-upload-drop" aria-label="Choose or drop the media file">Drop your file here or select it</div>
      <label for="chat-upload-file">Select file</label>
      <input type="file" id="chat-upload-file" accept="${esc(accept)}">
      <p id="chat-upload-fileinfo">No file selected</p>
      <button class="primary" type="submit" id="chat-upload-submit" disabled>Upload privately</button>
      <noscript><p class="notice err">JavaScript is required for the browser uploader. You may instead run the command returned by GS Poster.</p></noscript>
    </form>
    <section class="step-card" id="chat-upload-success" hidden>
      <div class="step-heading"><span class="step-number">2</span><div><h3>Media safely stored</h3>
      <p class="hint">Return to your chat. Your assistant can check this upload and attach it to a draft.</p></div></div>
      <label for="chat-upload-reference">Private media reference</label>
      <input id="chat-upload-reference" type="text" readonly>
      <button type="button" id="chat-upload-copy">Copy reference</button>
      <p class="choice-advice">This is not a public URL. The original file stays private until you separately approve publishing.</p>
    </section>
    <p role="status" aria-live="polite" id="chat-upload-status" class="form-info"></p>
    <script src="/upload-client.js" defer></script>
  `;
  const response=html(page("Upload media to GS Poster",body));
  response.headers.set("Referrer-Policy","no-referrer");
  response.headers.set("Cache-Control","no-store");
  response.headers.set("X-Robots-Tag","noindex, nofollow");
  return response;
}
