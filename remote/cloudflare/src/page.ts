// The sign-in page shown when claude.ai connects. No scripts, works on a phone.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function loginPage(o: { clientName?: string; redirectHost?: string; error?: string }): string {
  const form = o.clientName
    ? `<p class="muted"><strong>${esc(o.clientName)}</strong> (${esc(o.redirectHost ?? "")}) wants to read and change your Bring! shopping lists.</p>
      <form method="post">
        <label for="email">Bring! email</label>
        <input id="email" name="email" type="email" autocomplete="username" required>
        <label for="password">Bring! password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Allow access</button>
      </form>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bring for Claude</title>
<style>
  :root { --bg:#f6f5f1; --card:#fff; --text:#1d1c1a; --muted:#6b6862; --line:#e2dfd8; --accent:#c2412d; --on:#fff; --err:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1918; --card:#252321; --text:#f1efea; --muted:#a29e96; --line:#3a3733; --accent:#e0644f; --on:#1a1918; --err:#ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:420px; margin:0 auto; padding:40px 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }
  h1 { font-size:24px; margin:0 0 14px; }
  .muted { color:var(--muted); font-size:15px; margin:0 0 6px; }
  label { display:block; font-size:14px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; padding:11px 12px; font:inherit; color:var(--text); background:var(--bg); border:1px solid var(--line); border-radius:9px; }
  button { margin-top:18px; width:100%; padding:12px; font:inherit; font-weight:600; background:var(--accent); color:var(--on); border:0; border-radius:9px; }
  .error { color:var(--err); font-size:14px; margin:0 0 10px; }
</style></head>
<body><main><div class="card">
  <h1>Bring! for Claude</h1>
  ${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ""}
  ${form}
</div></main></body></html>`;
}
