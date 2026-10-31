// Test-only worker entry: exposes the real handleWeb so route-level gates
// (session, allowlist, same-origin, CSRF, PIN, lockout) run in workerd.
import {handleWeb} from "../../src/web.ts";
import type {Env} from "../../src/env.ts";
export default {fetch:(req:Request,env:Env)=>handleWeb(req,env)};
