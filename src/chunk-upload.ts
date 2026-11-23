/** Private video multipart upload across multiple Worker requests.
 * Each secret bearer is bound to one D1 row, one R2 key and one ordered stream.
 * No client-supplied upload IDs or completion ETags are ever trusted.
 */
import type {Env} from "./env.ts";
import {safeEqual,sha256} from "./session.ts";
import {claimUploadReservation,looksLike,StoredUploadMismatch,verifyStoredUploadParts} from "./upload.ts";
import {PRIVATE_VIDEO_MAX_BYTES,SINGLE_REQUEST_VIDEO_MAX_BYTES,VIDEO_UPLOAD_PART_BYTES} from "./video-limits.ts";

interface GrantRow {id:string;token_hash:string;ext:string;max_bytes:number;status:string;expires_at:string}
interface PartState {partNumber:number;etag:string;bytes:number;sha256:string}
interface TransferRow {id:string;upload_id:string;expected_bytes:number;next_part:number;parts_json:string;busy:number;updated_at:string}
const ACTIVE=1, REAPING=2;
const RECOVERY_GRACE_MS=15*60_000;
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
      p.some((x,i)=>x.partNumber!==i+1||typeof x.etag!=="string"||x.etag.length<1||x.etag.length>1024||
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
async function abortMultipart(env:Env,state:TransferRow):Promise<boolean>{
  // A start with no durable upload ID cannot have accepted any parts.
  if(!state.upload_id)return true;
  try{
    await env.UPLOADS!.resumeMultipartUpload(objectKey(state.id),state.upload_id).abort();
    return true;
  }catch(error){
    // The multipart upload can be absent after an acknowledged or lost abort,
    // and after completion. Recovery separately checks the final object.
    return typeof error==="object" && error!==null &&
      (("code" in error && error.code===10024) || (error instanceof Error && /\(10024\)$/.test(error.message)));
  }
}

async function claimActiveSession(db:D1Database,state:TransferRow):Promise<string|null>{
  const now=new Date().toISOString();
  const claimed=await db.prepare(`UPDATE video_chunk_sessions SET busy=?,updated_at=?
    WHERE id=? AND busy=0 AND next_part=? AND updated_at=?
      AND EXISTS (SELECT 1 FROM uploads WHERE id=? AND status='uploading' AND expires_at>?)`)
    .bind(ACTIVE,now,state.id,state.next_part,state.updated_at,state.id,now).run();
  return claimed.meta.changes===1?now:null;
}

async function markUpload(db:D1Database,state:TransferRow,status:"stored"|"failed"):Promise<boolean>{
  const result=await db.prepare(`UPDATE uploads SET status=?,bytes=? WHERE id=? AND status='uploading'
    AND EXISTS (SELECT 1 FROM video_chunk_sessions WHERE id=? AND busy=? AND updated_at=?)`)
    .bind(status,status==="stored"?state.expected_bytes:null,state.id,state.id,state.busy,state.updated_at).run();
  return result.meta.changes===1;
}

async function verifyCompleted(env:Env,state:TransferRow,parts:PartState[]):Promise<boolean>{
  try{
    await verifyStoredUploadParts(env,{id:state.id,ext:"mp4"},parts);
    return true;
  }catch(error){
    // A transient read or an unclear storage response is recoverable. Only
    // a confirmed byte or digest mismatch permits deletion of the object.
    if(!(error instanceof StoredUploadMismatch))throw error;
    await env.UPLOADS!.delete(objectKey(state.id));
    await markUpload(env.DB,state,"failed");
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
  if(!grant||grant.ext!=="mp4"||
    !safeEqual(await sha256(token),grant.token_hash)||grant.expires_at<=new Date().toISOString()||
    (action==="start"?grant.status!=="pending"||grant.max_bytes!==PRIVATE_VIDEO_MAX_BYTES:grant.status!=="uploading"))
    return failure("This upload link is expired or already used.",404);
  if(action==="start"){
    const length=Number(request.headers.get("content-length"));
    if(!request.body||!Number.isSafeInteger(length)||length<1||length>128)return failure("Invalid start declaration.",413);
    let size:unknown;
    try{size=JSON.parse(new TextDecoder().decode(await boundedChunk(request.body,length)))?.size;}
    catch{return failure("Invalid multipart declaration.");}
    if(typeof size!=="number"||!Number.isSafeInteger(size)||size<=SINGLE_REQUEST_VIDEO_MAX_BYTES||size>PRIVATE_VIDEO_MAX_BYTES)
      return failure("Chunked MP4 size is outside the supported 50-300 MB range.",413);
    if(!await claimUploadReservation(env.DB,id,size))
      return failure("This link was already used or private storage cannot reserve the declared size.",409);
    const now=new Date().toISOString();
    try{
      // Create a recoverable reservation before starting the storage operation.
      await env.DB.prepare("INSERT INTO video_chunk_sessions "+
        "(id,upload_id,expected_bytes,next_part,parts_json,busy,created_at,updated_at) "+
        "VALUES (?,'',?,1,'[]',?,?,?)").bind(id,size,ACTIVE,now,now).run();
    }catch{
      await env.DB.prepare("UPDATE uploads SET status='failed' WHERE id=? AND status='uploading'").bind(id).run().catch(()=>{});
      return failure("Could not record the private upload. Obtain a new link.",500);
    }
    try{
      const upload=await env.UPLOADS.createMultipartUpload(objectKey(id),{httpMetadata:{contentType:"video/mp4"}});
      const saved=await env.DB.prepare(`UPDATE video_chunk_sessions SET upload_id=?,busy=0,updated_at=?
        WHERE id=? AND upload_id='' AND busy=? AND updated_at=?`).bind(upload.uploadId,new Date().toISOString(),id,ACTIVE,now).run();
      if(saved.meta.changes!==1){
        await upload.abort().catch(()=>{});
        return failure("The upload expired before it was ready. Obtain a new link.",409);
      }
      return json({ok:true,chunk_bytes:VIDEO_UPLOAD_PART_BYTES,total_parts:Math.ceil(size/VIDEO_UPLOAD_PART_BYTES)});
    }catch{
      // If the session update already committed, recovery can use its ID. An
      // unknown ID cannot have been given parts and expires in object storage.
      return failure("Could not start a verified private upload. Obtain a new link.",500);
    }
  }
  const state=await getSession(env.DB,id);
  if(!state?.upload_id)return failure("Multipart session not ready.",409);
  if(action==="abort"){
    const claim=await claimActiveSession(env.DB,state);
    if(!claim)return failure("Upload is busy or expired.",409);
    try{
      if(await abortMultipart(env,state) && !(await env.UPLOADS.head(objectKey(id))) &&
        await markUpload(env.DB,{...state,busy:ACTIVE,updated_at:claim},"failed"))
        return json({ok:true,aborted:true});
    }catch{ /* Expiry reconciliation retains the reservation until confirmed. */ }
    return failure("Abort was not confirmed. Check upload status before retrying.",502);
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
    const claim=await claimActiveSession(env.DB,state);
    if(!claim)return failure("Another part is in progress or the link expired.",409);
    let bytes:Uint8Array;
    try{bytes=await boundedChunk(request.body,expected);}
    catch{
      await env.DB.prepare(`UPDATE video_chunk_sessions SET busy=0,updated_at=? WHERE id=? AND busy=? AND updated_at=?`)
        .bind(new Date().toISOString(),id,ACTIVE,claim).run();
      return failure("The part was incomplete. Retry the same part.",400);
    }
    if(number===1 && (bytes.length<12 || !looksLike("mp4",bytes))){
      if(await abortMultipart(env,state))
        await markUpload(env.DB,{...state,busy:ACTIVE,updated_at:claim},"failed");
      return failure("Video does not have an MP4 header. Choose a valid MP4 and request a new link.");
    }
    try{
      const parts=validParts(state);
      const checksum=await hex(bytes);
      const part=await env.UPLOADS.resumeMultipartUpload(objectKey(id),state.upload_id).uploadPart(number,bytes);
      parts.push({partNumber:part.partNumber,etag:part.etag,bytes:expected,sha256:checksum});
      const saved=await env.DB.prepare(`UPDATE video_chunk_sessions SET parts_json=?,next_part=?,busy=0,updated_at=?
        WHERE id=? AND busy=? AND updated_at=? AND next_part=?`)
        .bind(JSON.stringify(parts),number+1,new Date().toISOString(),id,ACTIVE,claim,number).run();
      if(saved.meta.changes!==1)throw Error("Could not durably record the completed chunk.");
      return json({ok:true,part:number,received_bytes:expected,next_part:number+1});
    }catch{
      return failure("Part transfer is uncertain. The expired session will be reconciled before its reservation is released.",502);
    }
  }
  // Completion trusts ONLY durable server-recorded ETags and per-part hashes.
  const parts=validParts(state);
  const required=Math.ceil(state.expected_bytes/VIDEO_UPLOAD_PART_BYTES);
  if(state.busy||parts.length!==required||
      parts.reduce((n,p)=>n+p.bytes,0)!==state.expected_bytes)
    return failure("All video parts must be received before finalization.",409);
  const claim=await claimActiveSession(env.DB,state);
  if(!claim)return failure("Video finalization is already in progress or the link expired.",409);
  const active={...state,busy:ACTIVE,updated_at:claim};
  try{
    await env.UPLOADS.resumeMultipartUpload(objectKey(id),state.upload_id).complete(
      parts.map(p=>({partNumber:p.partNumber,etag:p.etag})));
  }catch{
    // R2 may have completed despite a lost response. Never abort or release quota.
    return failure("Multipart completion is uncertain. Check upload status before retrying.",502);
  }
  try{
    if(!await verifyCompleted(env,active,parts))
      return failure("Video integrity readback failed. The upload is unavailable.",502);
  }catch{
    return failure("Video integrity readback could not be confirmed. Check upload status before retrying.",502);
  }
  try{
    if(!await markUpload(env.DB,active,"stored"))throw Error("State changed.");
  }catch{return failure("Video was copied but final status is uncertain. Check upload before retrying.",502);}
  return json({ok:true,reference:"upload://"+id+".mp4",bytes:state.expected_bytes});
}

/** Reconcile expired sessions with storage before releasing bytes or making them usable. */
export async function cleanupExpiredChunkUploads(env:Env,at=new Date()):Promise<void>{
  if(!env.UPLOADS)return;
  await ensureChunkSchema(env.DB);
  const now=at.toISOString();
  const stale=new Date(at.getTime()-RECOVERY_GRACE_MS).toISOString();
  const rows=await env.DB.prepare(`SELECT s.* FROM video_chunk_sessions s JOIN uploads u ON u.id=s.id
    WHERE u.status='uploading' AND u.expires_at<=? AND (s.busy=0 OR s.updated_at<=?)
    ORDER BY s.updated_at LIMIT 10`).bind(now,stale).all<TransferRow>();
  for(const row of rows.results){
    const claimed=await env.DB.prepare(`UPDATE video_chunk_sessions SET busy=?,updated_at=?
      WHERE id=? AND busy=? AND updated_at=?
      AND EXISTS (SELECT 1 FROM uploads WHERE id=? AND status='uploading' AND expires_at<=?)`)
      .bind(REAPING,now,row.id,row.busy,row.updated_at,row.id,now).run();
    if(claimed.meta.changes!==1)continue;
    const lease={...row,busy:REAPING,updated_at:now};
    let objectFound=false;
    try{
      const aborted=await abortMultipart(env,row);
      const object=await env.UPLOADS.head(objectKey(row.id));
      objectFound=!!object;
      if(!object){
        if(aborted)await markUpload(env.DB,lease,"failed");
      }else{
        const parts=validParts(row);
        if(parts.reduce((n,part)=>n+part.bytes,0)===row.expected_bytes && await verifyCompleted(env,lease,parts))
          await markUpload(env.DB,lease,"stored");
      }
    }catch{
      // Retries keep the lease and reservation until storage confirms an outcome.
    }
    // A complete large video can need dozens of storage reads. Bound one run.
    if(objectFound)break;
  }
}
