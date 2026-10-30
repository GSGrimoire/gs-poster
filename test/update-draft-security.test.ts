import {test} from "node:test";
import assert from "node:assert/strict";
import {handleUpdateDraft} from "../src/mcp.ts";
import type {Env} from "../src/env.ts";

const owned="upload://"+"a".repeat(32)+".png";
function fixture(){
  let writes=0,reads=0;
  const post={
    id:"p_test",status:"draft",created_at:new Date().toISOString(),
    updated_at:new Date().toISOString(),label:null,release:null,
    message:"A new GS Grimoire illustration.",tiktok_caption:null,link:null,
    images:"[]",tiktok_images:"[]",tiktok_video:null,video:null,
    scheduled_at:null,fb_post_id:null,permalink:null,note:null,error:null,
    created_by:"Alice",approved_at:null,facebook_enabled:1,tiktok_enabled:1,
    bs_caption:null,bs_images:null,bs_video:null,bs_patreon:null,
    bs_facebook_enabled:null,bs_status:null,bs_uri:null,bs_cid:null,
    bs_card_uri:null,bs_permalink:null,bs_error:null,
  };
  const db={
    async batch(){return [];},
    prepare(sql:string){
      const obj=(args:unknown[]=[]):any=>({
        bind(...v:unknown[]){return obj(v);},
        async all(){
          if(sql.includes("PRAGMA table_info"))return {results:[
            {name:"video"},{name:"facebook_enabled"},{name:"tiktok_enabled"},
            {name:"tiktok_caption"},{name:"tiktok_images"},
          ]};
          return {results:[]};
        },
        async first(){
          reads++;
          if(sql.includes("FROM posts p LEFT JOIN bluesky_targets"))return post;
          if(sql.includes("FROM uploads WHERE id=?")){
            return args[0]==="a".repeat(32)
              ? {ext:"png",status:"stored",created_by:"Alice",
                 expires_at:"",bytes:68,max_bytes:10485760}
              :null;
          }
          return null;
        },
        async run(){writes++;return {meta:{changes:1}};},
      });
      return obj();
    },
  };
  const env={
    DB:db,ALLOWED_GITHUB_LOGINS:"Alice",TIMEZONE:"Europe/Copenhagen",
    UPLOADS:{async get(){throw new Error("Simulated R2 read outage");}},
  } as unknown as Env;
  return {env,get writes(){return writes;},get reads(){return reads;}};
}
async function rejected(
  input:Parameters<typeof handleUpdateDraft>[3],
  expected:RegExp,
){
  const state=fixture();
  const response=await handleUpdateDraft(state.env,"https://poster.test","Alice",{id:"p_test",...input});
  assert.equal(response.isError,true);
  const result=JSON.parse(response.content[0].text);
  const problems=(result.problems||[]).join(" ");
  assert.match(problems,expected);
  assert.ok(state.reads>0,"actual draft was loaded");
  assert.equal(state.writes,0,"invalid media must never cause a database mutation");
}
test("update_draft rejects a non-GitHub remote image host without DB mutation",async()=>{
  await rejected({id:"p_test",images:["https://example.invalid/x.png"]},/Not a GitHub file URL/);
});
test("update_draft rejects malformed private media reference without DB mutation",async()=>{
  await rejected({id:"p_test",images:["upload://not-valid.png"]},/Invalid private media reference/);
});
test("update_draft rejects failed private image read without DB mutation",async()=>{
  await rejected({id:"p_test",images:[owned]},/Simulated R2 read outage/);
});
test("update_draft rejects invalid Bluesky images without DB mutation",async()=>{
  await rejected({id:"p_test",bluesky:{
    caption:"A new creature from GS Grimoire.",
    images:[{url:"https://example.invalid/bs.png",alt:"Creature illustration"}],
    patreon:null,
  }},/Not a GitHub file URL/);
});
test("update_draft rejects invalid TikTok gallery images without DB mutation",async()=>{
  await rejected({id:"p_test",tiktok_images:["https://example.invalid/tiktok.png"]},/Not a GitHub file URL/);
});
