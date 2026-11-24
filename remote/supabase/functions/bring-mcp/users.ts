// Friends who signed up with their own Bring account. Each gets a personal connector URL.
//
// Stored per person (table public.bring_users, see supabase/migrations):
// - a SHA-256 hash of their connector token, never the token itself;
// - their Bring refresh token, encrypted with the ENCRYPTION_KEY secret (AES-GCM).
// Their Bring password is used once at sign-up and never stored.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";
import { Bring, BringError, type GetEnv, passwordLogin, refreshLogin } from "./bring.ts";

interface UserRow {
  id: string;
  bring_uuid: string;
  public_uuid: string;
  refresh_token_enc: string;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export function newToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32))); // 64 hex characters
}

export class Users {
  private db: SupabaseClient;
  private keyPromise: Promise<CryptoKey> | null = null;
  private clients = new Map<string, { bring: Bring; tokenHash: string }>();

  constructor(private getEnv: GetEnv) {
    const url = getEnv("SUPABASE_URL");
    const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
    this.db = createClient(url, serviceKey, { auth: { persistSession: false } });
  }

  /** Sharing is on once ENCRYPTION_KEY is set. */
  static enabled(getEnv: GetEnv): boolean {
    return (getEnv("ENCRYPTION_KEY") ?? "").length >= 32;
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= (async () => {
      const secret = this.getEnv("ENCRYPTION_KEY") ?? "";
      if (secret.length < 32) throw new Error("ENCRYPTION_KEY is missing or too short.");
      // Derive a fixed-size AES key from whatever string the secret holds.
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    })();
    return this.keyPromise;
  }

  private async encrypt(text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), enc.encode(text));
    return `${b64(iv)}.${b64(new Uint8Array(data))}`;
  }

  private async decrypt(stored: string): Promise<string> {
    const [iv, data] = stored.split(".");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await this.key(), unb64(data));
    return new TextDecoder().decode(plain);
  }

  /**
   * Check a Bring login and give that account a new connector token. Signing up
   * again with the same Bring account replaces the old token, so the old URL stops working.
   */
  async signUp(email: string, password: string): Promise<string> {
    const auth = await passwordLogin(email, password);
    if (!auth.refreshToken) throw new BringError("Bring didn't return a refresh token. Try again later.");
    const token = newToken();
    const { error } = await this.db.from("bring_users").upsert(
      {
        bring_uuid: auth.uuid,
        public_uuid: auth.publicUuid,
        email: email.trim().toLowerCase(),
        token_hash: await sha256(token),
        refresh_token_enc: await this.encrypt(auth.refreshToken),
        created_at: new Date().toISOString(),
      },
      { onConflict: "bring_uuid" },
    );
    if (error) {
      console.error(error);
      throw new Error("Could not save the sign-up.");
    }
    this.clients.delete(auth.uuid); // drop the old token's cached session
    return token;
  }

  /** Delete the account that owns this token. Returns false if no account had it. */
  async revoke(token: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("bring_users").delete().eq("token_hash", await sha256(token)).select("bring_uuid");
    if (error) throw new Error("Could not remove the account.");
    for (const row of data ?? []) this.clients.delete(row.bring_uuid);
    return (data ?? []).length > 0;
  }

  /** The Bring client for a connector token, or null if the token is unknown. */
  async clientFor(token: string): Promise<Bring | null> {
    const tokenHash = await sha256(token);
    for (const c of this.clients.values()) if (c.tokenHash === tokenHash) return c.bring;

    const { data, error } = await this.db
      .from("bring_users")
      .select("id, bring_uuid, public_uuid, refresh_token_enc")
      .eq("token_hash", tokenHash)
      .maybeSingle<UserRow>();
    if (error) throw new Error("Could not look up the connector token.");
    if (!data) return null;

    const row = data;
    const bring = new Bring(async () => {
      const auth = await refreshLogin(await this.decrypt(row.refresh_token_enc), row.bring_uuid, row.public_uuid)
        .catch((err) => {
          if (err instanceof BringError && err.message === "SIGNIN_EXPIRED") {
            this.clients.delete(row.bring_uuid);
            throw new BringError(
              "Your Bring sign-in for this connector has expired. Sign up again on the " +
                "sign-up page to get a new connector URL.",
            );
          }
          throw err;
        });
      const update: Record<string, string> = { last_used_at: new Date().toISOString() };
      if (auth.refreshToken) {
        update.refresh_token_enc = await this.encrypt(auth.refreshToken);
        row.refresh_token_enc = update.refresh_token_enc;
      }
      await this.db.from("bring_users").update(update).eq("id", row.id);
      return auth;
    });
    this.clients.set(row.bring_uuid, { bring, tokenHash });
    return bring;
  }
}
