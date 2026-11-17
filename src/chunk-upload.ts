/** Private video multipart upload across multiple Worker requests.
 * Each secret bearer is bound to one D1 row, one R2 key and one ordered stream.
 * No client-supplied upload IDs or completion ETags are ever trusted.
 */
import type {Env} from "./env.ts";
import {safeEqual,sha256} from "./session.ts";
import {type UploadPartDigest,verifyStoredUploadParts} from "./upload.ts";
import {PRIVATE_VIDEO_MAX_BYTES,SINGLE_REQUEST_VIDEO_MAX_BYTES,VIDEO_UPLOAD_PART_BYTES} from "./video-limits.ts";

interface GrantRow {id:string;token_hash:string;ext:string;max_bytes:number;status:string;expires_at:string}
interface PartState {partNumber:number;etag:string;bytes:number;sha256:string}
interface TransferRow {id:string;upload_id:string;expected_bytes:number;next_part:number;parts_json:string;busy:number}
const objectKey=(id:string)=>"uploads/"+id+".mp4";
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{
  "Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"
}});
const failure=(msg:string,status=400)=>json({error:msg},status);
async function ensureChunkSchema(db:D1Database) {
  await db.prepare("CREATE TABLE IF NOT EXISTS video_chunk_sessions ("+
    "id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, expected_bytes INTEGER NOT NULL,"+
    "next_part INTEGER NOT NULL DEFAULT 1, parts_json TEXT NOT NULL DEFAULT '[]',"+
    "busy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)").run();
}
async function getSession(db:D1Database,id:string) {
  return db.prepare("SELECT * FROM video_chunk_sessions WHERE id=?").bind(id).first<TransferRow>();
}
const validParts=(state:TransferRow):PartState[]=>{
  const p=JSON.parse(state.parts_json) as PartState[];
  if(!Array.isArray(p)||p.length!==state.next_part-1||
      p.some((x,i)=>x.partNumber!==i+1||typeof x.etag!=="string"||x.etag.length<1||x.etag.length>160||
        !Number.isInteger(x.bytes)||x.bytes<1||x.bytes>VIDEO_UPLOAD_PART_BYTES||!(/^[a-f0-9]{64}$/.test(x.sha256))))
    throw Error("Invalid multipart record; manual reconciliation required.");
  return p;
};
async function boundedChunk(source:ReadableStream<Uint8Array>,expected:number):Promise<Uint8Array>{
  const out=new Uint8Array(expected);
  let total=0;
  const reader=source.getReader();
  try {
    while(true){
      const part=await reader.read();
      if(part.done)break;
      if(part.value.byteLength>expected-total)throw Error("Part exceeds declared length.");
      out.set(part.value,total);total+=part.value.byteLength;
    }
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  if(total!==expected)throw Error("Part length did not match the declaration.");
  return out;
}
const hex=async(bytes:Uint8Array)=>{
  const data=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return Array.from(data,n=>n.toString(16).padStart(2,"0")).join("");
};
async function failAfterAbort(env:Env,id:string,uploadId:string):Promise<boolean>{
  try{
    await env.UPLOADS!.resumeMultipartUpload(objectKey(id),uploadId).abort();
    await env.DB.prepare("UPDATE uploads SET status='failed' WHERE id=? AND status='uploading'").bind(id).run();
    return true;
  }catch{
    // An ambiguous abort retains the full storage reservation.
    return false;
  }
}

/** Secret-upload URL: the database, not the client, owns remote multipart state. */
export async function handleLargeVideoChunk(request:Request,env:Env):Promise<Response>{
  const path=new URL(request.url).pathname;
  const match=/^\/upload\/([a-f0-9]{32})\/([A-Za-z0-9_-]{20,64})\/multipart\/(start|part\/[1-9]\d{0,2}|finish|abort)$/.exec(path);
  if(!match)return failure("Not found.",404);
  if(!env.UPLOADS)return failure("Private storage is not configured.",503);
  const [,id,token,action]=match;
  if((action.startsWith("part/")&&request.method!=="PUT")||
     (!action.startsWith("part/")&&request.method!=="POST"))return failure("Unsupported method.",405);
  await ensureChunkSchema(env.DB);
  const grant=await env.DB.prepare("SELECT id,token_hash,ext,max_bytes,status,expires_at FROM uploads WHERE id=?")
    .bind(id).first<GrantRow>();
  if(!grant||grant.ext!=="mp4"||grant.max_bytes!==PRIVATE_VIDEO_MAX_BYTES||
    !safeEqual(await sha256(token),grant.token_hash)||grant.expires_at<=new Date().toISOString()||
    (action==="start"?grant.status!=="pending":grant.status!=="uploading"))
    return failure("This upload link is expired or already used.",404);
  if(action==="start"){
    const length=Number(request.headers.get("content-length"));
    if(!Number.isSafeInteger(length)||length<1||length>128)return failure("Invalid start declaration.",413);
    let size:number;
    try{const input=await request.json() as {size?:unknown};size=Number(input?.size);}
    catch{return failure("Invalid multipart declaration.");}
    if(!Number.isSafeInteger(size)||size<=SINGLE_REQUEST_VIDEO_MAX_BYTES||size>PRIVATE_VIDEO_MAX_BYTES)
      return failure("Chunked MP4 size is outside the supported 50-300 MB range.",413);
    const claimed=await env.DB.prepare(
      "UPDATE uploads SET status='uploading' WHERE id=? AND status='pending' AND expires_at>?")
      .bind(id,new Date().toISOString()).run();
    if(claimed.meta.changes!==1)return failure("Upload was already claimed.",409);
    let upload:R2MultipartUpload|null=null;
    try{
      upload=await env.UPLOADS.createMultipartUpload(objectKey(id),{httpMetadata:{contentType:"video/mp4"}});
      const now=new Date().toISOString();
      await env.DB.prepare("INSERT INTO video_chunk_sessions "+
        "(id,upload_id,expected_bytes,next_part,parts_json,busy,created_at,updated_at) "+
        "VALUES (?,?,?,1,'[]',0,?,?)").bind(id,upload.uploadId,size,now,now).run();
      return json({ok:true,chunk_bytes:VIDEO_UPLOAD_PART_BYTES,total_parts:Math.ceil(size/VIDEO_UPLOAD_PART_BYTES)});
    }catch{
      if(upload)await failAfterAbort(env,id,upload.uploadId);
      else await env.DB.prepare("UPDATE uploads SET status='failed' WHERE id=? AND status='uploading'").bind(id).run().catch(()=>{});
      return failure("Could not start a verified private upload. Obtain a new link.",500);
    }
  }
  const state=await getSession(env.DB,id);
  if(!state)return failure("Multipart session not found.",409);
  if(action==="abort"){
    const claim=await env.DB.prepare("UPDATE video_chunk_sessions SET busy=1 WHERE id=? AND busy=0")
      .bind(id).run();
    if(claim.meta.changes!==1)return failure("Upload is busy; its status may be uncertain.",409);
    const aborted=await failAfterAbort(env,id,state.upload_id);
    return aborted?json({ok:true,aborted:true}):failure("Abort was not confirmed; quota remains reserved.",502);
  }
  if(action.startsWith("part/")){
    const number=Number(action.slice(5));
    const total=Math.ceil(state.expected_bytes/VIDEO_UPLOAD_PART_BYTES);
    if(number!==state.next_part||number>total||state.busy)return failure("Part is out of order or already committed.",409);
    const remaining=state.expected_bytes-(number-1)*VIDEO_UPLOAD_PART_BYTES;
    const expected=Math.min(remaining,VIDEO_UPLOAD_PART_BYTES);
    const header=request.headers.get("content-length");
    if(header===null||!/^\d+$/.test(header)||Number(header)!==expected)
      return failure("Part Content-Length must equal the exact expected size.",413);
    if(!request.body)return failure("Empty part.",400);
    const claim=await env.DB.prepare(
      "UPDATE video_chunk_sessions SET busy=1 WHERE id=? AND busy=0 AND next_part=?")
      .bind(id,number).run();
    if(claim.meta.changes!==1)return failure("Another part is in progress.",409);
    try{
      const bytes=await boundedChunk(request.body,expected);
      if(number===1&&(bytes.length<12||String.fromCharCode(...bytes.subarray(4,8))!=="ftyp"))
        throw Error("Video is not a valid MP4 header.");
      const checksum=await hex(bytes);
      const part=await env.UPLOADS.resumeMultipartUpload(objectKey(id),state.upload_id).uploadPart(number,bytes);
      const parts=validParts(state);
      parts.push({partNumber:part.partNumber,etag:part.etag,bytes:expected,sha256:checksum});
      const saved=await env.DB.prepare(
        "UPDATE video_chunk_sessions SET parts_json=?,next_part=?,busy=0,updated_at=? WHERE id=? AND busy=1 AND next_part=?")
        .bind(JSON.stringify(parts),number+1,new Date().toISOString(),id,number).run();
      if(saved.meta.changes!==1)throw Error("Could not durably record the completed chunk.");
      return json({ok:true,part:number,received_bytes:expected,next_part:number+1});
    }catch{
      await failAfterAbort(env,id,state.upload_id);
      return failure("Part transfer failed or was uncertain. Obtain a new upload link.",502);
    }
  }
  // Completion trusts ONLY durable server-recorded ETags and per-part hashes.
  const parts=validParts(state);
  const required=Math.ceil(state.expected_bytes/VIDEO_UPLOAD_PART_BYTES);
  if(state.busy||parts.length!==required||
      parts.reduce((n,p)=>n+p.bytes,0)!==state.expected_bytes)
    return failure("All video parts must be received before finalization.",409);
  const claim=await env.DB.prepare("UPDATE video_chunk_sessions SET busy=1 WHERE id=? AND busy=0 AND next_part=?")
    .bind(id,required+1).run();
  if(claim.meta.changes!==1)return failure("Video finalization is already in progress.",409);
  try{
    await env.UPLOADS.resumeMultipartUpload(objectKey(id),state.upload_id).complete(
      parts.map(p=>({partNumber:p.partNumber,etag:p.etag})));
  }catch{
    // R2 may have completed despite a lost response. Never abort or release quota.
    return failure("Multipart completion is uncertain. Inspect storage before retrying.",502);
  }
  try{
    const fingerprints:UploadPartDigest[]=parts.map(p=>({bytes:p.bytes,sha256:p.sha256}));
    await verifyStoredUploadParts(env,{id,ext:"mp4"},fingerprints);
  }catch{
    try{
      await env.UPLOADS.delete(objectKey(id));
      await env.DB.prepare("UPDATE uploads SET status='failed' WHERE id=? AND status='uploading'")
        .bind(id).run();
    }catch{}
    return failure("Video integrity readback failed; the upload is not attachable.",502);
  }
  try{
    const saved=await env.DB.prepare(
      "UPDATE uploads SET status='stored',bytes=? WHERE id=? AND status='uploading'")
      .bind(state.expected_bytes,id).run();
    if(saved.meta.changes!==1)throw Error("State changed.");
  }catch{return failure("Video was copied but final status is uncertain. Check upload before retrying.",502);}
  return json({ok:true,reference:"upload://"+id+".mp4",bytes:state.expected_bytes});
}

/** Cleanup only idle expired multipart sessions; uncertain writes retain quota. */
export async function cleanupExpiredChunkUploads(env:Env):Promise<void>{
  if(!env.UPLOADS)return;
  await ensureChunkSchema(env.DB);
  const now=new Date().toISOString();
  const rows=await env.DB.prepare("SELECT s.id,s.upload_id FROM video_chunk_sessions s "+
    "JOIN uploads u ON u.id=s.id WHERE u.status='uploading' AND u.expires_at<? AND s.busy=0 LIMIT 10")
    .bind(now).all<{id:string;upload_id:string}>();
  for(const row of rows.results){
    const claimed=await env.DB.prepare("UPDATE video_chunk_sessions SET busy=1 WHERE id=? AND busy=0")
      .bind(row.id).run();
    if(claimed.meta.changes!==1)continue;
    await failAfterAbort(env,row.id,row.upload_id);
  }
}
