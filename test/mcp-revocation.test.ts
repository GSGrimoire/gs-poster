import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {handleDeleteDraft,handleListPosts,handleGetPost} from "../src/mcp.ts";
import type {Env} from "../src/env.ts";

function revokedFixture(){
  const calls:string[]=[];
  const db={
    prepare(sql:string){calls.push("DB.prepare:"+sql);throw new Error("Revoked editor reached the database");},
    async batch(){calls.push("DB.batch");throw new Error("Revoked editor reached schema migration");},
  };
  const env={DB:db,ALLOWED_GITHUB_LOGINS:"ActiveEditor",TIMEZONE:"Europe/Copenhagen",
    FB_PAGE_ID:"test-page",FB_PAGE_TOKEN:"test-token"} as unknown as Env;
  return {env,calls};
}
test("an editor removed from the current allowlist cannot delete drafts with an old OAuth identity",async()=>{
  const {env,calls}=revokedFixture();
  const result=await handleDeleteDraft(env,"FormerEditor","draft123");
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/no longer authorized/);
  assert.deepEqual(calls,[],"delete_draft must not reach the database");
});
test("an editor removed from the current allowlist cannot enumerate private posts",async()=>{
  const {env,calls}=revokedFixture();
  const result=await handleListPosts(env,"https://poster.test","FormerEditor",{status:"draft",limit:20});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/no longer authorized/);
  assert.deepEqual(calls,[],"list_posts must not refresh schedule or query posts");
});
test("an editor removed from the current allowlist cannot retrieve post details or media references",async()=>{
  const {env,calls}=revokedFixture();
  const result=await handleGetPost(env,"https://poster.test","FormerEditor","post123");
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/no longer authorized/);
  assert.deepEqual(calls,[],"get_post must not load post details");
});
test("every registered protected MCP tool has an explicit current-editor authorization gate",()=>{
  const source=readFileSync(new URL("../src/mcp.ts",import.meta.url),"utf8");
  const registration=/server\.registerTool\(\s*"([a-z_]+)"/g;
  const matches=[...source.matchAll(registration)];
  assert.ok(matches.length>=14,"Unexpected registration count: audit newly added tools");
  const permittedPatterns=[
    /currentOwner\(env\)/,
    /checkUploadForEditor\(env,currentOwner\(env\)/,
    /handleUpdateDraft\(env,origin,currentOwner\(env\)/,
    /handleDeleteDraft\(env,currentOwner\(env\)/,
    /handleListPosts\(env,origin,currentOwner\(env\)/,
    /handleGetPost\(env,origin,currentOwner\(env\)/,
  ];
  for(let i=0;i<matches.length;i++){
    const start=matches[i].index??0;
    const end=matches[i+1]?.index??source.indexOf("return server;",start);
    const registrationText=source.slice(start,end);
    assert.ok(permittedPatterns.some(pattern=>pattern.test(registrationText)),
      "Protected tool "+matches[i][1]+" lacks a current-allowlist guard");
  }
});
