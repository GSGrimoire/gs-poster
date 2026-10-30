/** Native ChatGPT file-parameter intake. No arbitrary URLs or model-visible base64.
 * Each file remains private, owner-scoped and draft-only after import.
 */
import type {Env} from "./env.ts";
import {createUpload,extensionOf,handleUploadPut,looksLike,uploadStatusForOwner,readUpload,type UploadExt} from "./upload.ts";

export interface ChatGPTFile {
  download_url:string;
  file_id:string;
  mime_type?:string;
  file_name?:string;
}
export interface NativeMediaImport {
  reference:string;
  filename:string;
  bytes:number;
  sha256:string;
  status:"stored";
}
/** A post-write failure must preserve a recovery reference for the owner. */
export class NativeMediaImportError extends Error{
  readonly reference:string;
  readonly storage_state:"unconfirmed";
  constructor(message:string,reference:string,storage_state:"unconfirmed"){
    super(message);
    this.reference=reference;
    this.storage_state=storage_state;
  }
}

const MIME:Record<UploadExt,string>={
  jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",mp4:"video/mp4",
};
const MIME_EXTENSION:Record<string,string>={
  "image/jpeg":"jpg","image/png":"png","image/gif":"gif","video/mp4":"mp4",
};

/** Reject recognizable truncated containers, not merely magic bytes. A genuine
 * original-file digest is checked separately during live acceptance.
 */
export function completeMedia(ext:UploadExt, bytes:Uint8Array):boolean{
  const n=bytes.length;
  if(!looksLike(ext,bytes.subarray(0,Math.min(16,n))))return false;
  if(ext==="jpg"||ext==="jpeg")
    return n>=16&&bytes[n-2]===0xff&&bytes[n-1]===0xd9;
  if(ext==="gif")
    return n>=14&&bytes[n-1]===0x3b;
  const read32=(i:number)=>((bytes[i]*0x1000000)+(bytes[i+1]<<16)+(bytes[i+2]<<8)+bytes[i+3])>>>0;
  if(ext==="png"){
    if(n<45||read32(8)!==13||String.fromCharCode(...bytes.subarray(12,16))!=="IHDR")return false;
    let offset=8,ended=false;
    while(offset+12<=n){
      const size=read32(offset);
      if(size>n-offset-12)return false;
      const tag=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
      offset+=12+size;
      if(tag==="IEND"){
        ended=size===0&&offset===n;
        break;
      }
    }
    return ended;
  }
  // MP4: walk complete top-level boxes; require ftyp, video data and metadata.
  if(n<24)return false;
  let offset=0,ftyp=false,meta=false,media=false;
  while(offset+8<=n){
    let size=read32(offset);
    const box=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    let header=8;
    if(size===1){
      if(offset+16>n)return false;
      const hi=read32(offset+8),lo=read32(offset+12);
      const length=hi*0x100000000+lo;
      if(!Number.isSafeInteger(length))return false;
      size=length;header=16;
    }else if(size===0)size=n-offset;
    if(size<header||size>n-offset)return false;
    if(box==="ftyp")ftyp=true;
    if(box==="moov"||box==="moof")meta=true;
    if(box==="mdat"&&size>header)media=true;
    offset+=size;
  }
  return offset===n&&ftyp&&meta&&media;
}

/** An explicit provider allowlist keeps this tool from becoming a server-side URL fetcher. */
export function validateChatGPTFile(input:ChatGPTFile):{url:string;filename:string;ext:UploadExt;limit:number}{
  if(!input||typeof input.file_id!=="string"||!/^file[-_][a-z0-9_-]+$/i.test(input.file_id)||
     input.file_id.length>256)
    throw new Error("ChatGPT did not supply an authorized file identifier. Use secure browser upload.");
  if(typeof input.download_url!=="string"||input.download_url.length>8192)
    throw new Error("ChatGPT did not supply a downloadable file. Use secure browser upload.");
  let url:URL;
  try{url=new URL(input.download_url);}
  catch{throw new Error("ChatGPT file download address is invalid.");}
  if(url.protocol!=="https:"||url.hostname!=="files.oaiusercontent.com"||
     url.username||url.password||url.port||url.hash)
    throw new Error("Unsupported ChatGPT file download origin. Use secure browser upload.");
  if(input.file_name!==undefined&&(typeof input.file_name!=="string"||input.file_name.length>200))
    throw new Error("ChatGPT file name was invalid.");
  const filename=input.file_name?.trim()||("attachment."+(MIME_EXTENSION[input.mime_type||""]||"unknown"));
  const ext=extensionOf(filename);
  if(!ext)throw new Error("Only JPG, PNG, GIF and MP4 files can be imported.");
  if(input.mime_type!==undefined&&input.mime_type!==MIME[ext])
    throw new Error("ChatGPT file type disagrees with its extension.");
  return {url:url.toString(),filename,ext,limit:ext==="mp4"?20_000_000:10*1024*1024};
}

export async function fetchChatGPTFile(
  input:ChatGPTFile,request:typeof fetch=fetch,
):Promise<{bytes:Uint8Array<ArrayBuffer>;filename:string;sha256:string}>{
  const {url,filename,ext,limit}=validateChatGPTFile(input);
  let response:Response;
  try {
    response=await request(url,{
      method:"GET",redirect:"manual",
      headers:{"Accept":"application/octet-stream","Cache-Control":"no-store"},
    });
  }catch{throw new Error("ChatGPT file download failed before an HTTP response. Use secure browser upload.");}
  if(response.status>=300&&response.status<400)
    throw new Error("ChatGPT file download redirected; refusing to follow it.");
  if(response.status!==200)
    throw new Error("ChatGPT file was unavailable (HTTP "+response.status+"). Use secure browser upload.");
  const declared=response.headers.get("content-length");
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))
    throw new Error("ChatGPT attachment exceeds the allowed media size.");
  if(!response.body)throw new Error("ChatGPT attachment contained no file bytes.");
  const reader=response.body.getReader();
  const parts:Uint8Array[]=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>limit)throw new Error("ChatGPT attachment exceeds the allowed media size.");
      parts.push(value);
    }
  }catch(e){await reader.cancel().catch(()=>{});throw e;}
  if(total===0)throw new Error("ChatGPT attachment was empty.");
  if(declared!==null&&Number(declared)!==total)
    throw new Error("ChatGPT attachment download ended before its declared length.");
  const bytes=new Uint8Array(total);
  let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  if(!completeMedia(ext,bytes))
    throw new Error("ChatGPT attachment is incomplete or does not match its media format.");
  const digest=await crypto.subtle.digest("SHA-256",bytes.buffer);
  const sha256=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,"0")).join("");
  return {bytes,filename,sha256};
}

export async function importChatGPTFile(
  env:Env,origin:string,login:string,input:ChatGPTFile,
  request:typeof fetch=fetch,
):Promise<NativeMediaImport>{
  if(!login.trim())throw new Error("Authenticated editor identity is required.");
  // Validate the complete original object before creating an upload reservation.
  const {bytes,filename,sha256}=await fetchChatGPTFile(input,request);
  const grant=await createUpload(env,origin,{filename,actor:login});
  // Supply verification to the upload handler BEFORE its database transition
  // to stored. A corruption/missing-object error keeps the record 'uploading',
  // which check_upload, check_uploads and draft ownership checks all reject.
  const saved=await handleUploadPut(new Request(grant.upload_url,{
    method:"PUT",headers:{"Content-Length":String(bytes.byteLength)},body:bytes,
  }),env,{
    verifyBeforeFinalize:async ref=>{
      const persisted=await readUpload(env,ref);
      if(persisted.byteLength!==bytes.byteLength)
        throw new Error("Persisted media length mismatch.");
      const persistedDigest=await crypto.subtle.digest("SHA-256",persisted);
      const persistedHash=Array.from(new Uint8Array(persistedDigest),
        v=>v.toString(16).padStart(2,"0")).join("");
      if(persistedHash!==sha256)throw new Error("Persisted media hash mismatch.");
    },
  });
  if(!saved.ok)
    throw new NativeMediaImportError("Private media write or verification was not confirmed; reference is not draft-ready.",grant.reference,"unconfirmed");
  try{
    const ready=await uploadStatusForOwner(env.DB,grant.reference,login);
    if(ready?.status!=="stored"||ready.bytes!==bytes.byteLength)
      throw new Error("Upload readiness did not match expected owner and byte count.");
  }catch{
    throw new NativeMediaImportError("Private media readiness could not be confirmed. Check upload status before reuse.",grant.reference,"unconfirmed");
  }
  return {reference:grant.reference,filename,bytes:bytes.byteLength,sha256,status:"stored"};
}
