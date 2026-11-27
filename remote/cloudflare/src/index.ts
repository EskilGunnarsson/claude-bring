// Bring! MCP server on Cloudflare Workers, always on, behind OAuth.
//
// - /mcp                 the MCP endpoint (Streamable HTTP). Needs an OAuth access token.
// - /authorize           sign-in page claude.ai opens when you connect. It accepts only the
//                        Bring login stored in the BRING_EMAIL / BRING_PASSWORD secrets.
// - /token, /register and the /.well-known metadata are served by workers-oauth-provider,
//   which keeps clients and grants in the OAUTH_KV namespace.
//
// The tools and their behaviour are the same code as the Supabase function (protocol.ts, bring.ts).

import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Bring, envLogin } from "../../supabase/functions/bring-mcp/bring.ts";
import { handleRpc, timingSafeEqual } from "../../supabase/functions/bring-mcp/protocol.ts";
import { loginPage } from "./page.ts";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  BRING_EMAIL?: string;
  BRING_PASSWORD?: string;
  BRING_LIST?: string;
}

const MAX_FAILURES = 10; // wrong sign-ins per IP address per hour
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

// One Bring session per Worker instance, reused while it stays warm.
let bring: Bring | null = null;
let currentEnv: Env;

const mcpHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    currentEnv = env;
    bring ??= new Bring(envLogin((key) => (currentEnv as unknown as Record<string, string | undefined>)[key]), env.BRING_LIST);
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    return await handleRpc(bring, req);
  },
};

function page(html: string, status = 200): Response {
  return new Response(html, { status, headers: PAGE_HEADERS });
}

const authHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response("Bring! MCP server. Add " + url.origin + "/mcp as a connector in claude.ai.\n");
    }
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });

    if (!env.BRING_EMAIL || !env.BRING_PASSWORD) {
      return page(loginPage({ error: "The server isn't set up: the BRING_EMAIL and BRING_PASSWORD secrets are missing." }), 503);
    }

    // The form posts back to this same URL, so the OAuth request is in the query both times.
    let authRequest;
    try {
      authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(req);
    } catch (err) {
      return page(loginPage({ error: `This sign-in link is invalid: ${(err as Error).message}` }), 400);
    }
    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    const clientName = client?.clientName ?? "An app";
    const redirectHost = new URL(authRequest.redirectUri).host;

    if (req.method === "GET") return page(loginPage({ clientName, redirectHost }));
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    const failKey = `login-failures:${ip}`;
    const failures = Number(await env.OAUTH_KV.get(failKey)) || 0;
    if (failures >= MAX_FAILURES) {
      return page(loginPage({ clientName, redirectHost, error: "Too many wrong attempts. Try again in an hour." }), 429);
    }

    const form = await req.formData();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    const ok =
      timingSafeEqual(email, env.BRING_EMAIL.trim().toLowerCase()) &&
      timingSafeEqual(password, env.BRING_PASSWORD);
    if (!ok) {
      await env.OAUTH_KV.put(failKey, String(failures + 1), { expirationTtl: 3600 });
      return page(loginPage({ clientName, redirectHost, error: "That's not the Bring login this connector uses." }), 401);
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: "owner",
      metadata: { label: clientName },
      scope: authRequest.scope,
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

// The resource URL must be this Worker's own address, which is only known once it's
// deployed, so the provider is built on the first request from that request's origin.
let provider: OAuthProvider<Env> | null = null;

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    provider ??= new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: authHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: { resource: new URL(req.url).origin + "/mcp", resource_name: "Bring! shopping lists" },
      accessTokenTTL: 3600,
      refreshTokenTTL: 60 * 60 * 24 * 365, // reconnect in claude.ai once a year
    });
    return provider.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
