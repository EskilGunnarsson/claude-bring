// Stateless MCP server over Streamable HTTP (JSON responses, no SSE), exposing the
// same five Bring! tools as the local Python connector.
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
import { Users } from "./users.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MIN_TOKEN_LENGTH = 32;

const listName = {
  type: "string",
  description: "List name or UUID. Omit to use the account's default list.",
};

const TOOLS = [
  {
    name: "bring_get_lists",
    description: "List all Bring! shopping lists on the account.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "bring_show_list",
    description:
      "Show the items to buy on a shopping list (default list if list_name is omitted). " +
      "Set include_recent to also return recently bought items.",
    inputSchema: {
      type: "object",
      properties: {
        list_name: listName,
        include_recent: { type: "boolean", default: false },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "bring_add_items",
    description:
      "Add one or more items to a shopping list. Items already on the list without a new " +
      "spec are skipped. Giving a spec for an item already on the list updates it.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Item name, e.g. 'Milk'" },
              spec: { type: "string", description: "Optional quantity or note, e.g. '2 l'" },
            },
            required: ["name"],
          },
        },
        list_name: listName,
      },
      required: ["items"],
    },
  },
  {
    name: "bring_complete_items",
    description: "Mark items as bought (moves them to recently bought). Names match case-insensitively.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } }, list_name: listName },
      required: ["names"],
    },
  },
  {
    name: "bring_remove_items",
    description: "Remove items from a list without marking them bought. Names match case-insensitively.",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } }, list_name: listName },
      required: ["names"],
    },
    annotations: { destructiveHint: true },
  },
];

const INSTRUCTIONS =
  "Manage the user's Bring! shopping lists. Item names are shown in the list's language " +
  "(e.g. German 'Milch'); use the same language when adding or completing items. " +
  "When no list is given, the account's default list is used.";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

// deno-lint-ignore no-explicit-any
async function callTool(bring: Bring, name: string, args: any) {
  switch (name) {
    case "bring_get_lists":
      return { lists: await bring.getLists() };
    case "bring_show_list":
      return await bring.show(args.list_name, Boolean(args.include_recent));
    case "bring_add_items":
      return await bring.add(args.list_name, args.items ?? []);
    case "bring_complete_items":
      return await bring.complete(args.list_name, args.names ?? []);
    case "bring_remove_items":
      return await bring.remove(args.list_name, args.names ?? []);
    default:
      throw new BringError(`Unknown tool: ${name}`);
  }
}

async function handleMessage(bring: Bring, msg: RpcMessage) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
        capabilities: { tools: {} },
        serverInfo: { name: "bring", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      try {
        const result = await callTool(bring, msg.params?.name, msg.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        const text = err instanceof BringError ? err.message : "Unexpected error talking to Bring.";
        if (!(err instanceof BringError)) console.error(err);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

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

    let body: RpcMessage | RpcMessage[];
    try {
      body = await req.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }

    const messages = Array.isArray(body) ? body : [body];
    const requests = messages.filter((m) => m.id !== undefined && m.id !== null && m.method);
    if (!requests.length) return new Response(null, { status: 202 }); // notifications only

    const replies = await Promise.all(requests.map((m) => handleMessage(bring, m)));
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  };
}
