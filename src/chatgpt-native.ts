/** Native ChatGPT file-parameter intake. No arbitrary URLs or model-visible base64.
 * Each file remains private, owner-scoped and draft-only after import.
 */
import type {Env} from "./env.ts";
import {createUpload,extensionOf,handleUploadPut,looksLike,uploadStatusForOwner,type UploadExt} from "./upload.ts";

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

const MIME:Record<UploadExt,string>={
  jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",mp4:"video/mp4",
};
const MIME_EXTENSION:Record<string,string>={
  "image/jpeg":"jpg","image/png":"png","image/gif":"gif","video/mp4":"mp4",
};

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
      method:"GET",redirect:"manual",referrerPolicy:"no-referrer",
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
  const bytes=new Uint8Array(total);
  let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  if(!looksLike(ext,bytes.subarray(0,Math.min(16,total))))
    throw new Error("ChatGPT attachment signature does not match its file type.");
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
  const saved=await handleUploadPut(new Request(grant.upload_url,{
    method:"PUT",headers:{"Content-Length":String(bytes.byteLength)},body:bytes,
  }),env);
  if(!saved.ok)throw new Error("Native media import could not be confirmed in private storage.");
  const ready=await uploadStatusForOwner(env.DB,grant.reference,login);
  if(ready?.status!=="stored"||ready.bytes!==bytes.byteLength)
    throw new Error("Private media readiness verification failed.");
  return {reference:grant.reference,filename,bytes:bytes.byteLength,sha256,status:"stored"};
}