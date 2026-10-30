/** Preserve completed private media imports independently of audit availability. */
import {NativeMediaImportError,type ChatGPTFile,type NativeMediaImport} from "./chatgpt-native.ts";
export interface NativeBatchResult{
  requested:number;
  imported_count:number;
  all_ready:boolean;
  uploads:Array<{index:number}&NativeMediaImport>;
  stopped_reason:string|null;
  audit_warnings:Array<{index:number;reason:string}>;
  recoverable:Array<{index:number;reference:string;storage_state:"unconfirmed"|"stored_but_unverified"}>;
}
export async function runNativeBatch(
  files:ChatGPTFile[],
  importOne:(file:ChatGPTFile)=>Promise<NativeMediaImport>,
  auditOne:(stored:NativeMediaImport)=>Promise<unknown>,
):Promise<NativeBatchResult>{
  const uploads:NativeBatchResult["uploads"]=[];
  const audit_warnings:NativeBatchResult["audit_warnings"]=[];
  const recoverable:NativeBatchResult["recoverable"]=[];
  let stopped_reason:string|null=null;
  for(const [position,file] of files.entries()){
    const index=position+1;
    let stored:NativeMediaImport;
    try{stored=await importOne(file);}
    catch(error){
      if(error instanceof NativeMediaImportError)
        recoverable.push({index,reference:error.reference,storage_state:error.storage_state});
      stopped_reason=error instanceof NativeMediaImportError
        ?error.message
        :"Attachment could not be imported or verified. Use secure browser fallback.";
      break;
    }
    // This MUST happen before audit, otherwise an audit outage hides stored bytes.
    uploads.push({index,...stored});
    try{await auditOne(stored);}
    catch{
      audit_warnings.push({index,reason:"Audit logging failed after confirmed private storage."});
      stopped_reason="Import stored successfully, but audit logging failed. Retain returned reference and stop further imports.";
      break;
    }
  }
  return {
    requested:files.length,imported_count:uploads.length,
    all_ready:uploads.length===files.length && stopped_reason===null,
    uploads,stopped_reason,audit_warnings,recoverable,
  };
}
