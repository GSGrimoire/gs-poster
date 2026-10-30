/** Shared authorization at all OAuth media intake and draft boundaries. */
import {allowedLogins,type Env} from "./env.ts";
import {isUploadRef,parseUploadRef,uploadStatusForOwner} from "./upload.ts";

export function isCurrentEditor(env:Env,login:string):boolean{
  return typeof login==="string" && login.trim().length>0 &&
    allowedLogins(env).includes(login.trim().toLowerCase());
}

/** Check every reference, including those beyond first-eight preflight batches.
 * A private upload:// identifier is not an authorization credential.
 */
export async function checkOwnedDraftMedia(
  env:Env,login:string,references:Iterable<string>,
):Promise<string[]>{
  const errors:string[]=[];
  if(!isCurrentEditor(env,login))return ["Editor access is no longer authorized."];
  const checked=new Set<string>();
  for(const url of references){
    if(!isUploadRef(url)||checked.has(url))continue;
    checked.add(url);
    if(!parseUploadRef(url)){
      errors.push("Invalid private media reference.");
      continue;
    }
    const status=await uploadStatusForOwner(env.DB,url,login);
    if(!status||status.status!=="stored")
      errors.push("A private media reference is not stored or does not belong to this editor.");
  }
  return errors;
}
