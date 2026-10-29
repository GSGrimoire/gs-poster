/** Batch media helpers for chat clients. Each grant still uses the same secure,
 * short-lived, private, one-use uploader as the browser interface.
 */
import type {Env} from "./env.ts";
import {createUpload,uploadStatusForOwner,parseUploadRef,extensionOf} from "./upload.ts";

export const CHAT_BATCH_MAX_FILES=35;
export const CHAT_BATCH_CHECK_MAX=80;

export function validateChatFilenames(filenames:string[]):string[] {
  if(!filenames.length||filenames.length>CHAT_BATCH_MAX_FILES)
    throw new Error("Supply between 1 and "+CHAT_BATCH_MAX_FILES+" filenames.");
  const names=filenames.map(name=>name.trim());
  for(const name of names) {
    if(!name||name.length>200||!extensionOf(name))
      throw new Error("Every filename must end in JPG, JPEG, PNG, GIF or MP4 and contain at most 200 characters.");
  }
  return names;
}

export async function createChatUploadBatch(env:Env,origin:string,actor:string,filenames:string[]) {
  const names=validateChatFilenames(filenames);
  const uploads: Array<{index:number;filename:string;reference:string;upload_page_url:string;
    upload_url:string;expires_at:string;max_bytes:number}>=[];
  let stopped_reason:string|null=null;
  for(const [index,filename]of names.entries()){
    try {
      const grant=await createUpload(env,origin,{filename,actor});
      uploads.push({index:index+1,filename,reference:grant.reference,
        upload_page_url:grant.upload_url,upload_url:grant.upload_url,
        expires_at:grant.expires_at,max_bytes:grant.max_bytes});
    }catch(error){
      // Grants already returned remain valid. Report partial completion clearly.
      stopped_reason=error instanceof Error?error.message:String(error);
      break;
    }
  }
  return {
    requested:names.length,created:uploads.length,uploads,stopped_reason,
    note:"Each upload page expires after ten minutes. Upload files in carousel order, verify with check_uploads, and only then create an unapproved post draft. No media was published."
  };
}

export async function checkChatUploadBatch(db:D1Database,actor:string,references:string[]) {
  if(!references.length||references.length>CHAT_BATCH_CHECK_MAX)
    throw new Error("Supply between 1 and "+CHAT_BATCH_CHECK_MAX+" references.");
  if(!actor.trim())throw new Error("Your authenticated editor identity is required.");
  const results=[];
  for(const [i,reference] of references.entries()) {
    const parsed=parseUploadRef(reference);
    const result=parsed?await uploadStatusForOwner(db,reference,actor):null;
    results.push({index:i+1,reference,status:result?.status??"unavailable",
      ready:result?.status==="stored",bytes:result?.bytes??null,
      media_type:parsed?.ext==="mp4"?"video":parsed?"image":"unknown"});
  }
  return {count:results.length,ready_count:results.filter(x=>x.ready).length,
    all_ready:results.every(x=>x.ready),results,
    tiktok_limit:35,bluesky_image_limit:4,facebook_image_limit:80,
    note:"Only stored, owner-matched references should be attached to the draft. A successful upload is not approval or publication."};
}
