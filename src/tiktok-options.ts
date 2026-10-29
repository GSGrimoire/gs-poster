/** Human-facing TikTok publishing choices, accessed only by a GitHub-authenticated editor. */
import type {Env} from "./env.ts";
import type {Session} from "./session.ts";
import {csrfToken} from "./session.ts";
import {getPost} from "./db.ts";
import {tiktokConnection,getTikTokCreatorOptions,type TikTokCreatorOptions} from "./tiktok.ts";
import {getTikTokInboxTransfer} from "./tiktok-inbox.ts";
import {esc,html,page} from "./html.ts";
import {TIKTOK_MEDIA_PREFIX} from "./tiktok-media.ts";

export async function tiktokOptionsPage(env:Env,session:Session,postId:string):Promise<Response> {
  const p=await getPost(env.DB,postId);
  if(!p||!p.tiktok_enabled)return html(page("Not found",
    "<p>This TikTok post does not exist.</p>",{login:session.login}),{status:404});
  const conn=await tiktokConnection(env.DB);
  if(!conn)return html(page("Connect TikTok",
    '<p><a href="/tiktok/settings">Connect TikTok first.</a></p>',{login:session.login}),{status:409});
  if(await getTikTokInboxTransfer(env.DB,postId))
    return html(page("Existing transfer",
      '<p>A TikTok transfer already exists. Review it on the post page before sending again.</p>'+
      '<p><a href="/post/'+esc(postId)+'">Back to post</a></p>',
      {login:session.login}),{status:409});
  const type=p.video?"VIDEO":p.images.length?"PHOTO":null;
  if(!type)return html(page("Attach media",
    '<p>Attach a video or images before sending to TikTok.</p><p><a href="/post/'+esc(postId)+'">Back</a></p>',
    {login:session.login}),{status:409});
  const post=p;
  const scopes=conn.scopes.split(",");
  let creator:TikTokCreatorOptions|null=null,creatorError="";
  if(scopes.includes("video.publish")) {
    try{creator=await getTikTokCreatorOptions(env);}
    catch(e){creatorError=e instanceof Error?e.message:"TikTok creator information unavailable.";}
  }
  const csrf=await csrfToken(env,session);
  const title=(p.label||p.release||"GS Grimoire").slice(0,90);
  const caption=(p.tiktok_caption ?? p.message).slice(0,type==="PHOTO"?4000:2200);
  const preview=type==="PHOTO"?
    '<div class="tiktok-carousel-preview">'+post.images.slice(0,35).map((_,i)=>
      '<figure class="tiktok-slide"><img src="/media/'+esc(p.id)+'/'+i+'" alt="Carousel image '+(i+1)+'" loading="lazy"><figcaption>'+String(i+1)+' / '+String(post.images.length)+'</figcaption></figure>').join("")+'</div>':
    '<video controls playsinline preload="metadata" style="width:100%;max-height:420px;border-radius:12px" src="/video/'+esc(p.id)+'/facebook"></video>';
  function fields(mode:"MEDIA_UPLOAD"|"DIRECT_POST") {
    return `
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <input type="hidden" name="expected_updated_at" value="${esc(post.updated_at)}">
      <input type="hidden" name="post_mode" value="${mode}">
      <input type="hidden" name="media_type" value="${type}">
      <label for="title-${mode}">TikTok title (up to 90 characters)</label>
      <input type="text" id="title-${mode}" name="tiktok_title" maxlength="90" value="${esc(title)}">
      <label for="caption-${mode}">TikTok ${type==="PHOTO"?"description (up to 4,000 characters)":"caption (up to 2,200 characters)"}</label>
      <textarea id="caption-${mode}" name="tiktok_caption" maxlength="${type==="PHOTO"?4000:2200}" style="min-height:120px">${esc(caption)}</textarea>
      <label><input type="checkbox" name="is_aigc" value="1"> AI-generated content (declare to TikTok)</label>
      <label><input type="checkbox" name="confirm_tiktok" value="1" required> I have rights to the media and explicitly authorize transferring it to TikTok now, not at the calendar time.</label>
      <label>Approval PIN<input type="password" name="pin" required autocomplete="off"></label>`;
  }
  const inbox=scopes.includes("video.upload")?`<form method="post" action="/post/${esc(p.id)}/tiktok-send" class="step-card">
      <div class="eyebrow">Option A · Controlled transfer</div>
      <h3 style="margin:9px 0">Send to TikTok inbox</h3>
      <p class="form-info">Send ${type==="PHOTO"?"this carousel":"the video"} to TikTok and finish its caption, privacy and publication in TikTok itself. No publication occurs from this choice until you finish it inside TikTok.</p>
      ${type==="VIDEO"?'<p class="hint">TikTok does not accept video inbox captions through this endpoint. Set the final caption inside TikTok.</p>':""}
      ${fields("MEDIA_UPLOAD")}
      <button class="primary" type="submit">Send to TikTok inbox</button>
    </form>`:
    '<p class="notice err">video.upload not granted. Reconnect with this permission in TikTok settings.</p>';
  const privacy=creator?.privacy_level_options.map(v=>
    '<option value="'+esc(v)+'"'+(v!=="SELF_ONLY"?' disabled':'')+'>'+
    esc(v==="SELF_ONLY"?"Only me (private test)":v+" (needs app audit)")+'</option>').join("")||"";
  const direct=creator&&creator.privacy_level_options.includes("SELF_ONLY")?
    `<form method="post" action="/post/${esc(p.id)}/tiktok-send" class="step-card">
      <div class="eyebrow">Option B · Immediate private publication</div>
      <h3 style="margin:9px 0">Direct Post test</h3>
      <p class="notice">This creates an actual TikTok post immediately. Unaudited testing is restricted to private, SELF_ONLY posts. It does not wait for a GS Poster calendar time.</p>
      <p>Creator: <strong>${esc(creator.creator_nickname)} (${esc(creator.creator_username)})</strong></p>
      ${fields("DIRECT_POST")}
      <label for="tt-privacy">Privacy choices reported by TikTok</label>
      <select name="privacy_level" id="tt-privacy" required>${privacy}</select>
      <p class="hint">Comments ${creator.comment_disabled?"disabled":"available"}, Duets ${creator.duet_disabled?"disabled":"available"}, Stitches ${creator.stitch_disabled?"disabled":"available"}.</p>
      <label><input type="checkbox" name="disable_comment" value="1" ${creator.comment_disabled?"checked":""}> Disable comments</label>
      ${type==="VIDEO"?`
        <label><input type="checkbox" name="disable_duet" value="1" ${creator.duet_disabled?"checked":""}> Disable Duets</label>
        <label><input type="checkbox" name="disable_stitch" value="1" ${creator.stitch_disabled?"checked":""}> Disable Stitches</label>`:
        '<label><input type="checkbox" name="auto_music" value="1"> Add TikTok recommended music</label>'}
      <label><input type="checkbox" name="brand_organic" value="1"> Promoting my own business</label>
      <label><input type="checkbox" name="brand_content" value="1"> Paid third-party partnership</label>
      <label><input type="checkbox" name="confirm_direct" value="1" required> I consent to creating a private TikTok post immediately.</label>
      <button class="primary" type="submit">Publish privately now</button>
    </form>`:
    '<p class="hint">'+esc(creatorError||"Direct Post requires video.publish consent and the SELF_ONLY option. Reconnect in TikTok settings if necessary.")+'</p>';
  const body=`<div class="hero">
    <div class="hero-kicker">GS Grimoire · Final review</div>
    <h2>Choose how to share on TikTok.</h2>
    <p>${type==="PHOTO"?p.images.length+" images in carousel order":"One MP4 video"} · ${esc(p.label||"Untitled post")}. Both methods require a separate approval PIN. Your calendar date does not trigger TikTok posting.</p>
    </div>
    <p><a href="/post/${esc(p.id)}">← Back to post</a></p>
    <style>
    .tiktok-carousel-preview{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;margin:14px 0 22px;padding-bottom:10px}
    .tiktok-slide{margin:0;flex:0 0 min(190px,45vw);scroll-snap-align:start;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel)}
    .tiktok-slide img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
    .tiktok-slide figcaption{font:750 12px system-ui,sans-serif;padding:8px 10px;color:var(--accent2)}
    </style>
    <section aria-label="Selected TikTok media">
      <div class="eyebrow">Your media · Final order</div>
      ${preview}
    </section>
    <p class="choice-advice">For photo carousels or link-based videos, TikTok must verify <code>${esc(TIKTOK_MEDIA_PREFIX)}</code> in your developer app. Original media stays private, and temporary links are created only after an explicit transfer.</p>
    <div class="step-heading" style="margin-top:23px"><span class="step-number">✓</span><div><h3>Select one publishing method</h3><p class="hint">These are independent choices. Nothing has been transferred yet.</p></div></div>
    ${inbox}${direct}`;
  return html(page("TikTok publishing options",body,{login:session.login}));
}
