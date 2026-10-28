/** Secure Login Kit integration. Does not publish TikTok content. */
import type { Env } from "./env.ts";
import type { Session } from "./session.ts";
import {getCookie,randomToken,safeEqual,sha256,cookie} from "./session.ts";

export const TIKTOK_STATE_COOKIE="__Host-gsp_tiktok_state";
export const TIKTOK_CALLBACK="https://gs-poster.goofyspook.workers.dev/tiktok/callback";
export const TIKTOK_SCOPES=["user.info.basic","video.upload"] as const;
const STATE_TTL=600;
const textEncoder=new TextEncoder(),textDecoder=new TextDecoder();
const aad=textEncoder.encode("gs-poster/tiktok/v1");
const encode64=(b:Uint8Array)=>btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const decode64=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const unix=()=>Math.floor(Date.now()/1000);

export interface TikTokTokens {
  access_token:string;refresh_token:string;open_id:string;scope:string;
  expires_in:number;refresh_expires_in:number;token_type:string;
}
export interface TikTokConnection {
  open_id:string;scopes:string;connected_by:string;
  access_expires_at:number;refresh_expires_at:number;updated_at:string;
}
interface TikTokRow extends TikTokConnection {token_cipher:string;lease_id:string|null;lease_until:number|null}
interface TikTokState {state_hash:string;actor:string;session_hash:string;scopes:string;expires_at:number}
export interface TikTokCreatorInfo {
  creator_username:string;creator_nickname:string;privacy_level_options:string[];
  comment_disabled:boolean;duet_disabled:boolean;stitch_disabled:boolean;
  max_video_post_duration_sec:number;
}

export function tiktokConfigured(env:Env):boolean {
  return !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET &&
    env.TIKTOK_TOKEN_ENCRYPTION_KEY && env.TIKTOK_TOKEN_ENCRYPTION_KEY.length>=32);
}
function configured(env:Env):{key:string;secret:string} {
  if(!tiktokConfigured(env))throw new Error("TikTok requires TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_TOKEN_ENCRYPTION_KEY Worker secrets.");
  return {key:env.TIKTOK_CLIENT_KEY!,secret:env.TIKTOK_CLIENT_SECRET!};
}
export function tiktokRedirect(env:Env):string {
  const uri=env.TIKTOK_REDIRECT_URI||TIKTOK_CALLBACK;
  const u=new URL(uri);
  if(u.protocol!=="https:"||u.search||u.hash||!u.pathname.endsWith("/tiktok/callback"))
    throw new Error("TikTok requires a fixed HTTPS callback URI ending in /tiktok/callback.");
  return uri;
}
async function key(env:Env):Promise<CryptoKey> {
  configured(env);
  const bytes=await crypto.subtle.digest("SHA-256",textEncoder.encode(env.TIKTOK_TOKEN_ENCRYPTION_KEY!));
  return crypto.subtle.importKey("raw",bytes,{name:"AES-GCM"},false,["encrypt","decrypt"]);
}
export async function sealTikTokTokens(env:Env,token:TikTokTokens):Promise<string> {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const bytes=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},
    await key(env),textEncoder.encode(JSON.stringify(token)));
  return "v1."+encode64(iv)+"."+encode64(new Uint8Array(bytes));
}
export async function unsealTikTokTokens(env:Env,value:string):Promise<TikTokTokens> {
  const [version,nonce,cipher]=value.split(".");
  if(version!=="v1"||!nonce||!cipher)throw Error("Invalid TikTok token format.");
  const plain=await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:decode64(nonce) as BufferSource,additionalData:aad},
    await key(env),decode64(cipher) as BufferSource);
  return JSON.parse(textDecoder.decode(plain)) as TikTokTokens;
}
export async function ensureTikTokSchema(db:D1Database):Promise<void> {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS tiktok_oauth_states (state_hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,actor TEXT NOT NULL,scopes TEXT NOT NULL,expires_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tiktok_accounts (account_key TEXT PRIMARY KEY CHECK(account_key='primary'),open_id TEXT NOT NULL,token_cipher TEXT NOT NULL,scopes TEXT NOT NULL,connected_by TEXT NOT NULL,access_expires_at INTEGER NOT NULL,refresh_expires_at INTEGER NOT NULL,updated_at TEXT NOT NULL,lease_id TEXT,lease_until INTEGER)"),
  ]);
}
export async function tiktokConnection(db:D1Database):Promise<TikTokConnection|null> {
  await ensureTikTokSchema(db);
  return await db.prepare("SELECT open_id,scopes,connected_by,access_expires_at,refresh_expires_at,updated_at FROM tiktok_accounts WHERE account_key='primary'")
    .first<TikTokConnection>()??null;
}
export function allowedTikTokScopes(values:string[]):string[] {
  const allowed=new Set(values.filter(v=>TIKTOK_SCOPES.includes(v as typeof TIKTOK_SCOPES[number])));
  allowed.add("user.info.basic");
  return [...TIKTOK_SCOPES].filter(v=>allowed.has(v));
}
export async function beginTikTokConnection(env:Env,session:Session,requested:string[]) {
  const client=configured(env);
  await ensureTikTokSchema(env.DB);
  const state=randomToken(),scopes=allowedTikTokScopes(requested);
  await env.DB.prepare("INSERT INTO tiktok_oauth_states (state_hash,session_hash,actor,scopes,expires_at) VALUES (?,?,?,?,?)")
    .bind(await sha256(state),await sha256(session.raw),session.login,scopes.join(","),unix()+STATE_TTL).run();
  const url=new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key",client.key);
  url.searchParams.set("response_type","code");
  url.searchParams.set("scope",scopes.join(","));
  url.searchParams.set("redirect_uri",tiktokRedirect(env));
  url.searchParams.set("state",state);
  return {url:url.toString(),state};
}
async function tokenRequest(env:Env,data:Record<string,string>):Promise<TikTokTokens> {
  const {key,secret}=configured(env);
  const response=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-store"},
    body:new URLSearchParams({client_key:key,client_secret:secret,...data}),redirect:"error",
  });
  const token=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok||typeof token.access_token!=="string"||typeof token.refresh_token!=="string"||
    typeof token.open_id!=="string"||typeof token.scope!=="string"||
    typeof token.expires_in!=="number"||typeof token.refresh_expires_in!=="number") {
    throw new Error("TikTok authorization failed. Verify app credentials, callback address and approved scopes.");
  }
  return token as unknown as TikTokTokens;
}
export async function finishTikTokConnection(env:Env,session:Session,req:Request) {
  const u=new URL(req.url),state=u.searchParams.get("state")||"",bound=getCookie(req,TIKTOK_STATE_COOKIE)||"";
  if(!state||!bound||!safeEqual(state,bound))
    throw new Error("TikTok authorization expired or was opened in a different browser.");
  await ensureTikTokSchema(env.DB);
  const hash=await sha256(state),sessionHash=await sha256(session.raw);
  const saved=await env.DB.prepare("SELECT * FROM tiktok_oauth_states WHERE state_hash=? AND session_hash=? AND actor=? AND expires_at>?")
    .bind(hash,sessionHash,session.login,unix()).first<TikTokState>();
  if(!saved)throw new Error("TikTok authorization state expired or was already used.");
  const deleted=await env.DB.prepare("DELETE FROM tiktok_oauth_states WHERE state_hash=? AND session_hash=? AND actor=? AND expires_at>?")
    .bind(hash,sessionHash,session.login,unix()).run();
  if(deleted.meta.changes!==1)throw new Error("TikTok authorization state already used.");
  if(u.searchParams.has("error"))throw new Error("TikTok authorization was cancelled.");
  const code=u.searchParams.get("code")||"";
  if(!code||code.length>2048)throw new Error("Missing TikTok authorization code.");
  const token=await tokenRequest(env,{grant_type:"authorization_code",code,redirect_uri:tiktokRedirect(env)});
  const consented=new Set(token.scope.split(",").map(x=>x.trim()));
  if(!consented.has("user.info.basic"))throw new Error("TikTok did not authorize basic account information.");
  const existing=await tiktokConnection(env.DB);
  if(existing&&existing.open_id!==token.open_id)
    throw new Error("Another TikTok account is connected. Disconnect it before switching accounts.");
  const sealed=await sealTikTokTokens(env,token),now=unix();
  await env.DB.prepare(
    "INSERT INTO tiktok_accounts (account_key,open_id,token_cipher,scopes,connected_by,access_expires_at,refresh_expires_at,updated_at,lease_id,lease_until) "+
    "VALUES ('primary',?,?,?,?,?,?,?,NULL,NULL) "+
    "ON CONFLICT(account_key) DO UPDATE SET token_cipher=excluded.token_cipher,scopes=excluded.scopes,connected_by=excluded.connected_by,access_expires_at=excluded.access_expires_at,refresh_expires_at=excluded.refresh_expires_at,updated_at=excluded.updated_at,lease_id=NULL,lease_until=NULL")
    .bind(token.open_id,sealed,token.scope,session.login,now+token.expires_in,
      now+token.refresh_expires_in,new Date().toISOString()).run();
  return {open_id:token.open_id,scopes:token.scope};
}
async function currentRow(env:Env) {
  await ensureTikTokSchema(env.DB);
  return await env.DB.prepare("SELECT * FROM tiktok_accounts WHERE account_key='primary'").first<TikTokRow>();
}
export async function tiktokAccessToken(env:Env,scope:string):Promise<string> {
  const row=await currentRow(env);
  if(!row)throw new Error("No TikTok account connected.");
  if(!row.scopes.split(",").includes(scope))throw new Error("TikTok has not granted "+scope+".");
  const now=unix();
  if(row.access_expires_at>now+180)return (await unsealTikTokTokens(env,row.token_cipher)).access_token;
  if(row.refresh_expires_at<=now+300)throw new Error("TikTok refresh token expired. Reconnect.");
  const lease=randomToken();
  const claim=await env.DB.prepare(
    "UPDATE tiktok_accounts SET lease_id=?,lease_until=? WHERE account_key='primary' AND token_cipher=? AND (lease_until IS NULL OR lease_until<?)")
    .bind(lease,now+45,row.token_cipher,now).run();
  if(claim.meta.changes!==1)throw new Error("TikTok credentials are being refreshed. Retry.");
  try {
    const old=await unsealTikTokTokens(env,row.token_cipher);
    const next=await tokenRequest(env,{grant_type:"refresh_token",refresh_token:old.refresh_token});
    if(next.open_id!==row.open_id)throw new Error("TikTok account identity changed during refresh.");
    const sealed=await sealTikTokTokens(env,next);
    const saved=await env.DB.prepare(
      "UPDATE tiktok_accounts SET token_cipher=?,scopes=?,access_expires_at=?,refresh_expires_at=?,updated_at=?,lease_id=NULL,lease_until=NULL WHERE account_key='primary' AND lease_id=? AND open_id=?")
      .bind(sealed,next.scope,unix()+next.expires_in,unix()+next.refresh_expires_in,new Date().toISOString(),lease,row.open_id).run();
    if(saved.meta.changes!==1)throw new Error("TikTok connection changed while refreshing.");
    if(!next.scope.split(",").includes(scope))throw new Error("TikTok no longer grants "+scope+".");
    return next.access_token;
  }finally{
    await env.DB.prepare("UPDATE tiktok_accounts SET lease_id=NULL,lease_until=NULL WHERE account_key='primary' AND lease_id=?")
      .bind(lease).run().catch(()=>undefined);
  }
}
export async function disconnectTikTok(env:Env):Promise<{revoked:boolean}> {
  const row=await currentRow(env);
  if(!row)return {revoked:true};
  const old=await unsealTikTokTokens(env,row.token_cipher);
  const {key,secret}=configured(env);
  let revoked=false;
  try {
    const res=await fetch("https://open.tiktokapis.com/v2/oauth/revoke/",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_key:key,client_secret:secret,token:old.access_token}),redirect:"error",
    });
    revoked=res.ok;
  }catch{/* local disconnection still removes the stored token */}
  await env.DB.prepare("DELETE FROM tiktok_accounts WHERE account_key='primary' AND token_cipher=?")
    .bind(row.token_cipher).run();
  return {revoked};
}
export async function queryTikTokCreatorInfo(env:Env) {
  const access=await tiktokAccessToken(env,"video.publish");
  const response=await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/",{
    method:"POST",headers:{"Authorization":"Bearer "+access,"Content-Type":"application/json; charset=UTF-8"},
    body:"{}",redirect:"error",
  });
  const data=await response.json().catch(()=>({})) as {data?:{creator_username?:string;creator_nickname?:string;privacy_level_options?:string[];max_video_post_duration_sec?:number};error?:{code?:string}};
  if(!response.ok||data.error?.code!=="ok"||!data.data)
    throw new Error("TikTok creator information unavailable. Check the video.publish permission.");
  return {
    creator_username:data.data.creator_username||"",
    creator_nickname:data.data.creator_nickname||"",
    privacy_level_options:data.data.privacy_level_options||[],
    max_video_post_duration_sec:data.data.max_video_post_duration_sec||0,
  };
}
export function tiktokStateCookie(state:string):string {return cookie(TIKTOK_STATE_COOKIE,state,STATE_TTL);}
export function clearTikTokStateCookie():string {return cookie(TIKTOK_STATE_COOKIE,"",0);}
