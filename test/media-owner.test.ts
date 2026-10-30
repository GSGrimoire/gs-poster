import {test} from "node:test";
import assert from "node:assert/strict";
import {checkOwnedDraftMedia,isCurrentEditor} from "../src/media-owner.ts";
import type {Env} from "../src/env.ts";
import {parseUploadRef} from "../src/upload.ts";
const alice="upload://"+"a".repeat(32)+".png";
const bob="upload://"+"b".repeat(32)+".mp4";
function fakeEnv():Env{
  const rows=[
    {id:"a".repeat(32),ext:"png",created_by:"Alice",status:"stored",expires_at:"",bytes:68,max_bytes:10485760},
    {id:"b".repeat(32),ext:"mp4",created_by:"Bob",status:"stored",expires_at:"",bytes:200,max_bytes:20000000},
  ];
  const db={
    async batch(){return [];},
    prepare(sql:string){
      return {bind(id:string){
        return {async first(){
          if(sql.includes("FROM uploads WHERE id=?"))return rows.find(row=>row.id===id)||null;
          return null;
        }};
      }};
    },
  };
  return {DB:db,ALLOWED_GITHUB_LOGINS:"Alice,Bob"} as unknown as Env;
}
test("OAuth editor permissions are checked against the current allowlist",()=>{
  const env=fakeEnv();
  assert.equal(isCurrentEditor(env,"ALICE"),true);
  assert.equal(isCurrentEditor(env,"BOB"),true);
  assert.equal(isCurrentEditor({...env,ALLOWED_GITHUB_LOGINS:"Alice"},"Bob"),false);
  assert.equal(isCurrentEditor(env,"FormerEditor"),false);
  assert.equal(isCurrentEditor(env,""),false);
});
test("two editors cannot attach each other's photos or video references",async()=>{
  const env=fakeEnv();
  assert.deepEqual(await checkOwnedDraftMedia(env,"Alice",[alice,alice]),[]);
  assert.deepEqual(await checkOwnedDraftMedia(env,"Bob",[bob]),[]);
  assert.match((await checkOwnedDraftMedia(env,"Alice",[alice,bob]))[0],/does not belong/);
  assert.match((await checkOwnedDraftMedia(env,"Bob",[alice]))[0],/does not belong/);
  assert.deepEqual(await checkOwnedDraftMedia(env,"Alice",["https://raw.githubusercontent.com/a/b/main/a.png"]),[]);
  assert.equal(parseUploadRef(alice)?.ext,"png");
});
test("unknown, unready or former-editor references fail closed",async()=>{
  const env=fakeEnv();
  assert.match((await checkOwnedDraftMedia(env,"Alice",["upload://"+"f".repeat(32)+".png"]))[0],/not stored/);
  assert.match((await checkOwnedDraftMedia(env,"Alice",["upload://invalid.png"]))[0],/Invalid/);
  const revoked={...env,ALLOWED_GITHUB_LOGINS:"Bob"};
  assert.match((await checkOwnedDraftMedia(revoked,"Alice",[alice]))[0],/no longer authorized/);
});
