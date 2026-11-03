/** Isolated OAuth helper double running inside workerd, never production. */
import {handleWeb} from "../../src/web.ts";
import type {Env} from "../../src/env.ts";

type RequestDetails={clientId:string;scope:string[];redirectUri:string};
const state={begun:0,approved:0,denied:0,completed:0};
const handles=new Map<string,RequestDetails>();
const helpers={
  async parseAuthRequest(_req:Request){
    return {clientId:"example-app",scope:["draft:read"],
      redirectUri:"https://client.example/cb"} as RequestDetails;
  },
  async describeConsent(_request:RequestDetails){
    return {clientName:"Example client",clientDomain:null,redirectHost:"client.example",
      redirectIsLoopback:false,scope:["draft:read"]};
  },
  async beginConsent(request:RequestDetails){
    const handle="mock-consent-"+(++state.begun);
    handles.set(handle,request);
    return {handle,headers:new Headers({"Set-Cookie":
      "__Host-consent-handle="+handle+"; Secure; HttpOnly; SameSite=Lax; Path=/",
      "X-Frame-Options":"DENY"})};
  },
  async approveConsent(req:Request,handle:string,options:{scope:string[]}){
    if(!handles.has(handle) ||
       !req.headers.get("Cookie")?.includes("__Host-consent-handle="+handle))
      throw new Error("Provider rejected stale or unbound consent handle");
    const original=handles.get(handle)!;
    if(options.scope.join(" ")!=="draft:read")throw Error("Unsupported scope");
    handles.delete(handle);
    state.approved++;
    return {request:original,headers:new Headers({"Set-Cookie":"__Host-consent-handle=; Max-Age=0"})};
  },
  async denyConsent(req:Request,handle:string){
    if(!handles.has(handle) ||
       !req.headers.get("Cookie")?.includes("__Host-consent-handle="+handle))
      throw new Error("Provider rejected stale or unbound consent handle");
    handles.delete(handle);state.denied++;
    return {redirectTo:"https://client.example/cb?error=access_denied",
      headers:new Headers({"Set-Cookie":"__Host-consent-handle=; Max-Age=0"})};
  },
  async completeAuthorization(){
    state.completed++;
    return {redirectTo:"https://client.example/cb?code=only-for-tests"};
  },
};

export default {
  fetch(req:Request,env:Env){
    if(new URL(req.url).pathname==="/mock-state")
      return Response.json(state,{headers:{"Cache-Control":"no-store"}});
    return handleWeb(req,{...env,OAUTH_PROVIDER:helpers} as unknown as Env);
  },
};
