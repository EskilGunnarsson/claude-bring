// Checks a deployed (or `wrangler dev`) Worker the way claude.ai uses it: OAuth discovery,
// client registration, sign-in, token exchange and refresh, then the MCP tools.
//   node test-flow.mjs https://bring-mcp.<you>.workers.dev                 # OAuth only
//   node test-flow.mjs <url> <bring-email>          # plus sign-in and tools; password from $PW
//   LIVE="The Atelier" node test-flow.mjs <url> <bring-email>   # also add + remove a test item
// Set the password without it landing in your shell history (zsh):
//   read -s "PW?Bring password: "; export PW
import crypto from "node:crypto";
const base = process.argv[2], email = process.argv[3], password = process.argv[4] ?? process.env.PW;
const ok = (c, m) => { if (!c) { console.log("FAIL -", m); process.exitCode = 1; } else console.log("ok -", m); };

let r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const www = r.headers.get("www-authenticate") || "";
ok(r.status === 401 && www.includes("resource_metadata"), `/mcp without token -> ${r.status}, ${www.slice(0, 90)}`);

r = await fetch(base + "/.well-known/oauth-protected-resource/mcp");
if (r.status !== 200) r = await fetch(base + "/.well-known/oauth-protected-resource");
const prm = await r.json();
ok(prm.resource === base + "/mcp" && prm.authorization_servers?.length, "protected resource metadata " + JSON.stringify(prm));
r = await fetch(base + "/.well-known/oauth-authorization-server");
const as = await r.json();
ok(as.authorization_endpoint && as.token_endpoint && as.registration_endpoint, "authorization server metadata");

const redirect = "https://claude.ai/api/mcp/auth_callback";
r = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
const client = await r.json();
ok(r.status === 201 && client.client_id, "dynamic client registration");

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const authUrl = `${as.authorization_endpoint}?` + new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "st8", code_challenge: challenge, code_challenge_method: "S256", resource: base + "/mcp" });
r = await fetch(authUrl);
const html = await r.text();
ok(r.status === 200 && html.includes("Allow access") && html.includes("Claude"), "sign-in page renders");
ok((r.headers.get("x-frame-options") || "") === "DENY", "sign-in page can't be framed");

if (!email) { console.log("no credentials given, stopping before sign-in"); process.exit(); }

r = await fetch(authUrl, { method: "POST", body: new URLSearchParams({ email: "x@y.z", password: "nope" }), redirect: "manual" });
ok(r.status === 401 && (await r.text()).includes("not the Bring login"), "wrong login rejected");

r = await fetch(authUrl, { method: "POST", body: new URLSearchParams({ email, password }), redirect: "manual" });
if (r.status !== 302) {
  const msg = ((await r.text()).match(/class="error"[^>]*>([^<]*)</) || [])[1] || "(no message)";
  console.log(`Sign-in failed with HTTP ${r.status}: ${msg}`);
  if (r.status === 401) console.log("The email or password doesn't match the BRING_EMAIL / BRING_PASSWORD secrets. Set them again with `npx wrangler secret put BRING_EMAIL` and `npx wrangler secret put BRING_PASSWORD` in remote/cloudflare.");
  if (!password) console.log("No password given: set PW first (see the top of this file).");
  process.exit(1);
}
const loc = new URL(r.headers.get("location") || "http://x/");
ok(r.status === 302 && loc.href.startsWith(redirect) && loc.searchParams.get("state") === "st8" && loc.searchParams.get("code"), "right login redirects back with a code");

r = await fetch(as.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code"), redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: base + "/mcp" }) });
const tok = await r.json();
ok(tok.access_token && tok.refresh_token, "code exchanged for tokens");

const rpc = async (method, params = {}, at = tok.access_token) => {
  const res = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + at }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};
let x = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
ok(x.status === 200 && x.body.result.serverInfo.name === "bring", "initialize");
x = await rpc("tools/list");
ok(x.body.result?.tools?.map((t) => t.name).join(",") === "bring_get_lists,bring_show_list,bring_add_items,bring_complete_items,bring_remove_items", "tools/list has the five tools");
x = await rpc("tools/list", {}, "bogus");
ok(x.status === 401, "bad token rejected");

r = await fetch(as.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id }) });
const tok2 = await r.json();
ok(tok2.access_token, "refresh token works");

const call = async (name, args) => (await rpc("tools/call", { name, arguments: args }, tok2.access_token)).body.result;
if (process.env.LIVE) {
  const lists = await call("bring_get_lists", {});
  console.log(lists.content[0].text);
  const target = process.env.LIVE;
  const item = "Claude test item " + Date.now() % 10000;
  console.log((await call("bring_show_list", { list_name: target })).content[0].text.slice(0, 300));
  const add = await call("bring_add_items", { list_name: target, items: [{ name: item, spec: "test" }] });
  ok(!add.isError && add.content[0].text.includes(item), "added test item: " + add.content[0].text);
  const shown = await call("bring_show_list", { list_name: target });
  ok(shown.content[0].text.includes(item), "test item is on the list");
  const rem = await call("bring_remove_items", { list_name: target, names: [item] });
  ok(!rem.isError && rem.content[0].text.includes(item), "removed test item");
  ok(!(await call("bring_show_list", { list_name: target })).content[0].text.includes(item), "test item gone");
} else {
  const res = await call("bring_get_lists", {});
  console.log("tools/call reaches Bring code:", JSON.stringify(res).slice(0, 160));
}
