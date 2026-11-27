// The MCP protocol side, shared by the Supabase function (mcp.ts) and the Cloudflare
// Worker (remote/cloudflare): the five Bring! tools and a stateless Streamable HTTP
// handler (JSON responses, no SSE). Keep this file free of platform-specific imports.

import { type Bring, BringError } from "./bring.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

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

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

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

export async function handleMessage(bring: Bring, msg: RpcMessage) {
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

/** Answer one Streamable HTTP POST body (a JSON-RPC message or batch) with JSON. */
export async function handleRpc(bring: Bring, req: Request): Promise<Response> {
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
}
