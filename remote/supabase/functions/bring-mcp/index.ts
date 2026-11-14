// Supabase Edge Function entry point for the remote Bring! MCP connector.
// Secrets: BRING_EMAIL, BRING_PASSWORD, CONNECTOR_TOKEN (and optionally BRING_LIST).
// Deploy with JWT verification off; the secret token in the URL does the access control.

import { createHandler } from "./mcp.ts";

Deno.serve(createHandler((key) => Deno.env.get(key)));
