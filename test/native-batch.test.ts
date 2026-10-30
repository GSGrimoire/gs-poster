import {test} from "node:test";
import assert from "node:assert/strict";
import {runNativeBatch} from "../src/native-batch.ts";
import {NativeMediaImportError,type ChatGPTFile,type NativeMediaImport} from "../src/chatgpt-native.ts";
const source:ChatGPTFile={
  file_id:"file-testing",download_url:"https://files.oaiusercontent.com/download/test",
  file_name:"a.png",mime_type:"image/png",
};
const files=[source,{...source,file_id:"file-second"},{...source,file_id:"file-third"}];
const stored=(name:string):NativeMediaImport=>({
  reference:"upload://"+name.repeat(32)+".png",filename:name+".png",bytes:68,sha256:"f".repeat(64),status:"stored",
});
test("audit failure after storage does not hide the completed upload",async()=>{
  const imported:string[]=[];
  const result=await runNativeBatch(files,async file=>{
    imported.push(file.file_id);
    return stored("a");
  },async()=>{throw new Error("database audit failed");});
  assert.equal(result.imported_count,1);
  assert.equal(result.uploads[0].reference,stored("a").reference);
  assert.deepEqual(imported,["file-testing"]);
  assert.equal(result.audit_warnings.length,1);
  assert.equal(result.all_ready,false);
  assert.match(result.stopped_reason||"",/audit logging failed/i);
});
test("post-write ambiguity returns owner-checkable reference, not a false success",async()=>{
  const reference=stored("b").reference;
  const result=await runNativeBatch(files,
    async()=>{throw new NativeMediaImportError("Write could not be confirmed.",reference,"unconfirmed");},
    async()=>{throw new Error("audit must not run");});
  assert.equal(result.imported_count,0);
  assert.equal(result.recoverable[0].reference,reference);
  assert.equal(result.recoverable[0].storage_state,"unconfirmed");
  assert.equal(result.all_ready,false);
});
test("ordered successful batch preserves source order and audit status",async()=>{
  let index=0;
  const audited:string[]=[];
  const result=await runNativeBatch(files,async()=>stored("abc"[index++]),async item=>{audited.push(item.reference);});
  assert.equal(result.imported_count,3);
  assert.deepEqual(result.uploads.map(v=>v.index),[1,2,3]);
  assert.deepEqual(result.uploads.map(v=>v.reference),[stored("a").reference,stored("b").reference,stored("c").reference]);
  assert.deepEqual(audited,result.uploads.map(v=>v.reference));
  assert.equal(result.all_ready,true);
});
