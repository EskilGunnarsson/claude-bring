// Supabase Edge Function handler: token-in-URL access control and friend sign-up.
// The tools and the MCP protocol live in protocol.ts.
//
// Access control: every connector URL ends in a secret token, e.g.
//   https://<project>.supabase.co/functions/v1/bring-mcp/<token>
// - CONNECTOR_TOKEN (secret) uses the owner's account from BRING_EMAIL / BRING_PASSWORD.
// - Tokens handed out by POST /signup use the Bring account of whoever signed up (users.ts).
// Anyone with a full URL can use that account's lists, so keep it private.
//
// Sign-up endpoints (called by docs/signup.html, so they allow cross-origin requests):
//   POST /bring-mcp/signup  {email, password, code}  -> {url}
//   POST /bring-mcp/revoke  {url}                    -> {removed}

import { Bring, BringError, envLogin, type GetEnv } from "./bring.ts";
import { handleRpc, timingSafeEqual } from "./protocol.ts";
import { Users } from "./users.ts";

const MIN_TOKEN_LENGTH = 32;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const corsJson = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

// deno-lint-ignore no-explicit-any
async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export function createHandler(getEnv: GetEnv, users?: Users | null) {
  const owner = new Bring(envLogin(getEnv), getEnv("BRING_LIST"));
  if (users === undefined) users = Users.enabled(getEnv) ? new Users(getEnv) : null;
  const baseUrl = `${(getEnv("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1/bring-mcp/`;

  async function signup(req: Request): Promise<Response> {
    if (!users) return corsJson({ error: "Sharing is not set up on this connector." }, 503);
    const { email, password, code } = await readJson(req);
    const invite = getEnv("SIGNUP_CODE") ?? "";
    if (!invite || typeof code !== "string" || !timingSafeEqual(code.trim(), invite)) {
      return corsJson({ error: "Wrong or missing invite code." }, 403);
    }
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
      return corsJson({ error: "Enter your Bring email and password." }, 400);
    }
    try {
      const token = await users.signUp(email.trim(), password);
      return corsJson({ url: baseUrl + token });
    } catch (err) {
      if (err instanceof BringError) return corsJson({ error: err.message }, 400);
      console.error(err);
      return corsJson({ error: "Sign-up failed. Try again later." }, 500);
    }
  }

  async function revoke(req: Request): Promise<Response> {
    if (!users) return corsJson({ error: "Sharing is not set up on this connector." }, 503);
    const { url } = await readJson(req);
    const token = typeof url === "string" ? url.trim().split("/").filter(Boolean).pop() ?? "" : "";
    if (!token) return corsJson({ error: "Paste your connector URL." }, 400);
    try {
      return corsJson({ removed: await users.revoke(token) });
    } catch (err) {
      console.error(err);
      return corsJson({ error: "Could not remove it. Try again later." }, 500);
    }
  }

  async function bringFor(token: string): Promise<Bring | null> {
    const ownerToken = getEnv("CONNECTOR_TOKEN") ?? "";
    if (ownerToken.length >= MIN_TOKEN_LENGTH && timingSafeEqual(token, ownerToken)) return owner;
    if (users && /^[0-9a-f]{64}$/.test(token)) return await users.clientFor(token);
    return null;
  }

  return async (req: Request): Promise<Response> => {
    const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";

    if (token === "signup" || token === "revoke") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method !== "POST") return corsJson({ error: "Method not allowed" }, 405);
      return token === "signup" ? await signup(req) : await revoke(req);
    }

    if (!users && (getEnv("CONNECTOR_TOKEN") ?? "").length < MIN_TOKEN_LENGTH) {
      return new Response(`CONNECTOR_TOKEN secret is missing or shorter than ${MIN_TOKEN_LENGTH} characters.`, { status: 503 });
    }
    let bring: Bring | null;
    try {
      bring = await bringFor(token);
    } catch (err) {
      console.error(err);
      return new Response("Server error", { status: 500 });
    }
    if (!bring) return new Response("Not found", { status: 404 });

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    return await handleRpc(bring, req);
  };
}
