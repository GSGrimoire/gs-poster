/**
 * Explicit staging-only entry. Every release action is blocked regardless of
 * cookie, PIN, connected provider or request method; cron is disabled in code.
 */
import original from "./index.ts";
import type {Env} from "./env.ts";
import {pr90StagingAllowed} from "./pr90-staging-policy.ts";

export default {
  async fetch(request:Request,env:Env,context:ExecutionContext):Promise<Response> {
    if ((env as Env & {STAGING_NO_PUBLISH?:string}).STAGING_NO_PUBLISH!=="1")
      return new Response("Staging configuration incomplete.",{status:503});
    const path=new URL(request.url).pathname;
    if (!pr90StagingAllowed(request.method,path))
      return new Response("Publication and integration actions are disabled in isolated staging.",
        {status:403,headers:{"Cache-Control":"no-store","X-GS-Staging-No-Publish":"1"}});
    const response=await original.fetch(request,env,context);
    const copy=new Response(response.body,response);
    copy.headers.set("X-GS-Staging-No-Publish","1");
    copy.headers.set("Cache-Control","no-store");
    return copy;
  },
  async scheduled():Promise<void> {
    // Never enqueue, reconcile or publish anything in the staging Worker.
  },
} satisfies ExportedHandler<Env>;
