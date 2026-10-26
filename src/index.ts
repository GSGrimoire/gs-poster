/**
 * gs-poster: one Worker that is
 *  - an OAuth 2.1 authorization server (Claude connects through it),
 *  - an MCP server at /mcp (Claude's draft tools), and
 *  - the approval site (Gus signs in with GitHub and approves with his PIN).
 */
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env.ts";
import { buildServer } from "./mcp.ts";
import { handleWeb } from "./web.ts";
import { publishDueBluesky } from "./publish.ts";

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch(request: Request, env: Env, ctx: ExecutionContext) {
          return createMcpHandler(() => buildServer(env, origin))(request, env, ctx);
        },
      },
      defaultHandler: {
        fetch(request: Request, env: Env) {
          return handleWeb(request, env);
        },
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      // Access tokens last an hour; Claude refreshes them. Refresh tokens expire after 30 idle days.
      accessTokenTTL: 3600,
      refreshTokenIdleTTL: 30 * 24 * 3600,
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await publishDueBluesky(env);
  },
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    const origin = new URL(request.url).origin;
    if (env.PUBLIC_ORIGIN && origin !== env.PUBLIC_ORIGIN) return new Response("Not found", { status: 404 });
    return providerFor(origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
