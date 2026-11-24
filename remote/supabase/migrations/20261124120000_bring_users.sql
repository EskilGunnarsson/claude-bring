-- Friends who use the Bring connector with their own Bring account (see functions/bring-mcp/users.ts).
-- Only the edge function reads this table, with the service role key. RLS is on with no
-- policies, so the public anon key can't read or change it.
create table if not exists public.bring_users (
  id uuid primary key default gen_random_uuid(),
  bring_uuid text not null unique,
  public_uuid text not null,
  email text not null,
  token_hash text not null unique,      -- SHA-256 of the connector token, never the token
  refresh_token_enc text not null,      -- Bring refresh token, AES-GCM with ENCRYPTION_KEY
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.bring_users enable row level security;
revoke all on public.bring_users from anon, authenticated;
