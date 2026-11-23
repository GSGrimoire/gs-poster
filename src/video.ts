/**
 * Video transport: GitHub-hosted or private MP4 up to 300 MB.
 * Buffered legacy operations stay capped at 50 MB. Large consumers stream.
 */
import type { Env } from "./env.ts";
import { parseGitHubUrl } from "./media.ts";
import { isUploadRef, looksLike, parseUploadRef, readUpload } from "./upload.ts";
import { PRIVATE_VIDEO_MAX_BYTES, BUFFERED_VIDEO_MAX_BYTES } from "./video-limits.ts";

/** Compatibility ceiling for legacy buffer-returning calls. */
export const INITIAL_VIDEO_MAX_BYTES = BUFFERED_VIDEO_MAX_BYTES;

export function checkVideoUrl(value: string): string | null {
  if (isUploadRef(value)) {
    const ref = parseUploadRef(value);
    return ref?.ext === "mp4" ? null : "Bluesky video requires a valid private MP4 upload reference.";
  }
  const ref = parseGitHubUrl(value);
  if (!ref || !ref.path.toLowerCase().endsWith(".mp4")) {
    return "Bluesky video currently requires a GitHub MP4 file URL.";
  }
  return null;
}

/** Return the GitHub response body without materializing a 300 MB ArrayBuffer.
 * Used only for an already-saved, allowlisted GitHub MP4 source. */
export async function openGitHubVideoSource(env:Env,value:string):Promise<Response> {
  const ref = parseGitHubUrl(value);
  if (!ref || checkVideoUrl(value) || isUploadRef(value))
    throw new Error("Only GitHub MP4 files can be imported.");
  const path = ref.path.split("/").map(encodeURIComponent).join("/");
  let response = await fetch(
    "https://raw.githubusercontent.com/" + ref.owner + "/" + ref.repo + "/" +
      encodeURIComponent(ref.ref) + "/" + path,
    { headers: { "User-Agent": "gs-poster" }, redirect:"manual" },
  );
  if (!response.ok && env.GITHUB_READ_TOKEN) {
    await response.body?.cancel();
    response = await fetch("https://api.github.com/repos/" + ref.owner + "/" + ref.repo +
      "/contents/" + path + "?ref=" + encodeURIComponent(ref.ref), {
      headers: { Authorization: "Bearer " + env.GITHUB_READ_TOKEN,
        Accept: "application/vnd.github.raw+json", "User-Agent": "gs-poster" }, redirect:"manual",
    });
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Could not fetch MP4 video from the GitHub library.");
  }
  const header = response.headers.get("content-length");
  const length = header === null ? null : Number(header);
  if (length !== null && (!Number.isSafeInteger(length) || length <= 0 || length > PRIVATE_VIDEO_MAX_BYTES)) {
    await response.body.cancel();
    throw new Error("GitHub MP4 size is invalid or exceeds the 300 MB private video limit.");
  }
  return response;
}

export async function fetchVideo(env: Env, value: string): Promise<Uint8Array> {
  const bad = checkVideoUrl(value);
  if (bad) throw new Error(bad);
  if (isUploadRef(value)) {
    const upload = parseUploadRef(value);
    if (!upload || upload.ext !== "mp4") throw new Error("Invalid private MP4 upload reference.");
    const head = await env.UPLOADS?.head("uploads/" + upload.id + ".mp4");
    if (!head) throw new Error("Private MP4 is missing.");
    if (head.size > BUFFERED_VIDEO_MAX_BYTES)
      throw new Error("This video requires a streaming media operation; the buffered limit is 50 MB.");
    const raw = await readUpload(env, upload);
    const bytes = new Uint8Array(raw);
    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") {
      throw new Error("Private upload does not have an MP4 header.");
    }
    return bytes;
  }
  const response = await openGitHubVideoSource(env,value);
  const parts: Uint8Array[] = [];
  const reader = response.body!.getReader();
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > BUFFERED_VIDEO_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Buffered video operation exceeds 50 MB; use streaming transfer.");
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  // A Git LFS pointer is text, not video. Reject it before trying the API.
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") {
    throw new Error("GitHub returned a non-MP4 file (possibly a Git LFS pointer).");
  }
  return bytes;
}


/** Check the MP4 prefix and forward each chunk without retaining the full body. */
async function checkedVideoBody(source:ReadableStream<Uint8Array>,size:number):Promise<ReadableStream<Uint8Array>>{
  const reader=source.getReader();
  const prefix=new Uint8Array(12);
  const initial:Uint8Array[]=[];
  let received=0;
  try{
    while(received<prefix.length){
      const {done,value}=await reader.read();
      if(done || value.byteLength>size-received)throw Error("GitHub MP4 length does not match its declaration.");
      if(value.byteLength)initial.push(value);
      prefix.set(value.subarray(0,prefix.length-received),received);
      received+=value.byteLength;
    }
    if(!looksLike("mp4",prefix))throw Error("GitHub returned a non-MP4 file (possibly a Git LFS pointer).");
  }catch(error){
    await reader.cancel(error).catch(()=>{});
    reader.releaseLock();
    throw error;
  }
  return new ReadableStream({
    async pull(controller){
      const first=initial.shift();
      if(first){controller.enqueue(first);return;}
      try{
        const {done,value}=await reader.read();
        if(done){
          if(received!==size)throw Error("GitHub MP4 ended before its declared length.");
          reader.releaseLock();
          controller.close();
        }else{
          if(value.byteLength>size-received)throw Error("GitHub MP4 exceeds its declared length.");
          received+=value.byteLength;
          controller.enqueue(value);
        }
      }catch(error){
        await reader.cancel(error).catch(()=>{});
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason){
      try{await reader.cancel(reason);}finally{reader.releaseLock();}
    },
  });
}

/** Open media without allocating the complete MP4 in the Worker isolate. */
export async function openVideoStream(env:Env,value:string):Promise<{body:ReadableStream<Uint8Array>;size:number}>{
  const bad=checkVideoUrl(value);
  if(bad)throw Error(bad);
  if(isUploadRef(value)){
    const ref=parseUploadRef(value);
    if(!ref||ref.ext!=="mp4"||!env.UPLOADS)throw Error("Private video storage is unavailable.");
    const object=await env.UPLOADS.get("uploads/"+ref.id+".mp4");
    if(!object)throw Error("Video is missing or has expired.");
    if(!object.size || object.size>PRIVATE_VIDEO_MAX_BYTES){
      await object.body.cancel();
      throw Error("Private MP4 is outside the 300 MB bound.");
    }
    return {body:object.body,size:object.size};
  }
  const response=await openGitHubVideoSource(env,value);
  const length=response.headers.get("content-length");
  const encoding=response.headers.get("content-encoding");
  if(length===null || (encoding && encoding!=="identity")){
    await response.body!.cancel();
    throw Error("GitHub must provide a known MP4 size for streaming. Upload the file directly to GS Poster.");
  }
  const size=Number(length);
  return {body:await checkedVideoBody(response.body!,size),size};
}

/** Efficient R2 lookup for provider size fences and native byte-range playback. */
export async function privateVideoSize(env:Env,value:string):Promise<number|null>{
  const ref=parseUploadRef(value);
  if(!ref || ref.ext!=="mp4" || !env.UPLOADS)return null;
  const head=await env.UPLOADS.head("uploads/"+ref.id+".mp4");
  return head?.size??null;
}

/** Stream a bounded private range without materializing the chunk in Worker memory.
 * The caller must verify the returned stream's exact byte count using
 * FixedLengthStream before considering an outbound upload complete.
 */
export async function openPrivateVideoRangeStream(
  env:Env,value:string,offset:number,length:number,
):Promise<ReadableStream<Uint8Array>>{
  const ref=parseUploadRef(value);
  if(!ref || ref.ext!=="mp4" || !env.UPLOADS)throw Error("Expected private video.");
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||
     length<1||length>20*1024*1024||!Number.isSafeInteger(offset+length))
    throw Error("Invalid bounded private video range.");
  const object=await env.UPLOADS.get("uploads/"+ref.id+".mp4",{range:{offset,length}});
  if(!object)throw Error("Video range is missing.");
  return object.body;
}

/** A private video range is at most 20 MiB per read, even for a 300 MB file. */
export async function privateVideoRange(env:Env,value:string,offset:number,length:number):
  Promise<Uint8Array>{
  const ref=parseUploadRef(value);
  if(!ref || ref.ext!=="mp4" || !env.UPLOADS)throw Error("Expected private video.");
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||
     length<1||length>20*1024*1024)throw Error("Invalid bounded private video range.");
  const object=await env.UPLOADS.get("uploads/"+ref.id+".mp4",{range:{offset,length}});
  if(!object)throw Error("Video range is missing.");
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(bytes.length!==length)throw Error("Video range was truncated.");
  return bytes;
}
