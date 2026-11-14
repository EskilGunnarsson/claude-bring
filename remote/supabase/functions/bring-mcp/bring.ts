// Minimal Bring! API client: a TypeScript port of the parts of the `bring-api`
// Python package that the connector uses (login, lists, items, translations).

const API = "https://api.getbring.com/rest/";
const LOCALES_URL = "https://web.getbring.com/locale/";
// Bring stores catalog items under their de-CH names and translates per list locale.
const DEFAULT_LOCALE = "de-CH";
const SUPPORTED_LOCALES = [
  "de-AT", "de-CH", "de-DE", "en-AU", "en-CA", "en-GB", "en-US", "es-ES", "fr-CH", "fr-FR",
  "hu-HU", "it-CH", "it-IT", "nb-NO", "nl-NL", "pl-PL", "pt-BR", "ru-RU", "sv-SE", "tr-TR",
];
const LANG_TO_LOCALE: Record<string, string> = {
  de: "de-DE", en: "en-US", es: "es-ES", fr: "fr-FR", hu: "hu-HU", it: "it-IT", nb: "nb-NO",
  nl: "nl-NL", pl: "pl-PL", pt: "pt-BR", ru: "ru-RU", sv: "sv-SE", tr: "tr-TR",
};
const BASE_HEADERS: Record<string, string> = {
  "X-BRING-API-KEY": "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp",
  "X-BRING-CLIENT": "android",
  "X-BRING-APPLICATION": "bring",
  "X-BRING-COUNTRY": "DE",
};

/** An error whose message is safe and useful to show to the user. */
export class BringError extends Error {}

type Purchase = { itemId: string; specification: string; uuid: string };
type Change = { itemId: string; spec: string; uuid: string | null };
type Operation = "TO_PURCHASE" | "TO_RECENTLY" | "REMOVE";

interface Session {
  headers: Record<string, string>;
  uuid: string;
  userLocale: string;
  listLocales: Record<string, string>;
  defaultListUuid?: string;
  expiresAt: number;
}

// Kept across requests while the edge function instance stays warm.
let session: Session | null = null;
const translations = new Map<string, Record<string, string>>();
const reverseTranslations = new Map<string, Map<string, string>>();

export type GetEnv = (key: string) => string | undefined;

async function login(getEnv: GetEnv): Promise<Session> {
  const email = getEnv("BRING_EMAIL");
  const password = getEnv("BRING_PASSWORD");
  if (!email || !password) {
    throw new BringError("The BRING_EMAIL and BRING_PASSWORD secrets are not set.");
  }
  const r = await fetch(API + "v2/bringauth", {
    method: "POST",
    body: new URLSearchParams({ email, password }),
  });
  if (r.status === 400 || r.status === 401) {
    throw new BringError("Bring login failed. Check the BRING_EMAIL and BRING_PASSWORD secrets.");
  }
  if (!r.ok) throw new BringError(`Bring login failed (HTTP ${r.status}).`);
  const auth = await r.json();

  const s: Session = {
    headers: {
      ...BASE_HEADERS,
      Authorization: `${auth.token_type} ${auth.access_token}`,
      "X-BRING-USER-UUID": auth.uuid,
      "X-BRING-PUBLIC-USER-UUID": auth.publicUuid,
    },
    uuid: auth.uuid,
    userLocale: DEFAULT_LOCALE,
    listLocales: {},
    expiresAt: Date.now() + Math.max(60, (auth.expires_in ?? 3600) - 60) * 1000,
  };

  const account = await rawRequest(s, "GET", `v2/bringusers/${s.uuid}`);
  const loc = account.userLocale ?? {};
  if (loc.country) s.headers["X-BRING-COUNTRY"] = loc.country;
  const combined = `${loc.language}-${loc.country}`;
  s.userLocale = SUPPORTED_LOCALES.includes(combined)
    ? combined
    : LANG_TO_LOCALE[loc.language] ?? DEFAULT_LOCALE;

  const settings = await rawRequest(s, "GET", `bringusersettings/${s.uuid}`);
  for (const ls of settings.userlistsettings ?? []) {
    const lang = ls.usersettings?.find((e: { key: string }) => e.key === "listArticleLanguage");
    if (lang) s.listLocales[ls.listUuid] = lang.value;
  }
  s.defaultListUuid = settings.usersettings?.find(
    (e: { key: string }) => e.key === "defaultListUUID",
  )?.value;
  return s;
}

async function rawRequest(s: Session, method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, {
    method,
    headers: body ? { ...s.headers, "Content-Type": "application/json" } : s.headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new BringError("UNAUTHORIZED");
  if (!r.ok) throw new BringError(`Bring request failed (HTTP ${r.status}).`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export class Bring {
  constructor(private getEnv: GetEnv) {}

  private async session(): Promise<Session> {
    if (!session || Date.now() > session.expiresAt) session = await login(this.getEnv);
    return session;
  }

  // deno-lint-ignore no-explicit-any
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    try {
      return await rawRequest(await this.session(), method, path, body);
    } catch (err) {
      if (!(err instanceof BringError) || err.message !== "UNAUTHORIZED") throw err;
      session = await login(this.getEnv); // token revoked or expired early: log in once more
      return await rawRequest(session, method, path, body);
    }
  }

  private async dictionary(locale: string): Promise<Record<string, string> | null> {
    if (locale === DEFAULT_LOCALE || !SUPPORTED_LOCALES.includes(locale)) return null;
    if (!translations.has(locale)) {
      const r = await fetch(`${LOCALES_URL}articles.${locale}.json`);
      if (!r.ok) throw new BringError(`Could not load Bring translations for ${locale}.`);
      const dict: Record<string, string> = await r.json();
      translations.set(locale, dict);
      reverseTranslations.set(
        locale,
        new Map(Object.entries(dict).map(([key, value]) => [value.toLowerCase(), key])),
      );
    }
    return translations.get(locale)!;
  }

  private async toLocal(itemId: string, locale: string): Promise<string> {
    return (await this.dictionary(locale))?.[itemId] ?? itemId;
  }

  private async fromLocal(name: string, locale: string): Promise<string> {
    if (!(await this.dictionary(locale))) return name;
    return reverseTranslations.get(locale)!.get(name.toLowerCase()) ?? name;
  }

  async getLists(): Promise<{ name: string; uuid: string }[]> {
    const s = await this.session();
    const data = await this.request("GET", `bringusers/${s.uuid}/lists`);
    return (data.lists ?? []).map((l: { name: string; listUuid: string }) => ({
      name: l.name,
      uuid: l.listUuid,
    }));
  }

  /** Pick a list by name/UUID, else BRING_LIST, else the account's default list. */
  private async resolveList(wanted?: string | null): Promise<{ uuid: string; name: string; locale: string }> {
    const lists = await this.getLists();
    if (!lists.length) throw new BringError("This Bring account has no lists.");
    const s = await this.session();
    const target = wanted || this.getEnv("BRING_LIST");
    let match = target
      ? lists.find((l) => [l.name.toLowerCase(), l.uuid.toLowerCase()].includes(target.trim().toLowerCase()))
      : lists.find((l) => l.uuid === s.defaultListUuid) ?? lists[0];
    if (!match) {
      throw new BringError(`No list named '${target}'. Available lists: ${lists.map((l) => l.name).join(", ")}`);
    }
    return { ...match, locale: s.listLocales[match.uuid] ?? s.userLocale };
  }

  private async items(list: { uuid: string; locale: string }) {
    const data = await this.request("GET", `v2/bringlists/${list.uuid}`);
    const localize = async (p: Purchase) => ({ ...p, itemId: await this.toLocal(p.itemId, list.locale) });
    return {
      purchase: await Promise.all((data.items?.purchase ?? []).map(localize)) as Purchase[],
      recently: await Promise.all((data.items?.recently ?? []).map(localize)) as Purchase[],
    };
  }

  private async update(list: { uuid: string; locale: string }, changes: Change[], operation: Operation) {
    const body = {
      changes: await Promise.all(changes.map(async (c) => ({
        accuracy: "0.0", altitude: "0.0", latitude: "0.0", longitude: "0.0",
        itemId: await this.fromLocal(c.itemId, list.locale),
        spec: c.spec,
        uuid: c.uuid,
        operation,
      }))),
      sender: "",
    };
    await this.request("PUT", `v2/bringlists/${list.uuid}/items`, body);
  }

  async show(listName?: string | null, includeRecent = false) {
    const list = await this.resolveList(listName);
    const items = await this.items(list);
    const toDict = (p: Purchase) => ({ name: p.itemId, spec: p.specification });
    return {
      list: list.name,
      to_buy: items.purchase.map(toDict),
      ...(includeRecent ? { recent: items.recently.map(toDict) } : {}),
    };
  }

  async add(listName: string | null | undefined, toAdd: { name: string; spec?: string }[]) {
    const list = await this.resolveList(listName);
    const onList = new Set((await this.items(list)).purchase.map((p) => p.itemId.toLowerCase()));
    const changes: Change[] = [];
    const skipped: string[] = [];
    for (const { name, spec = "" } of toAdd) {
      const n = name.trim();
      if (!n) continue;
      // Re-adding an item that's already there only makes sense to change its spec.
      if (onList.has(n.toLowerCase()) && !spec.trim()) {
        skipped.push(n);
        continue;
      }
      changes.push({ itemId: n, spec: spec.trim(), uuid: null });
    }
    if (changes.length) await this.update(list, changes, "TO_PURCHASE");
    return {
      list: list.name,
      added: changes.map((c) => ({ name: c.itemId, spec: c.spec })),
      already_on_list: skipped,
    };
  }

  private async change(listName: string | null | undefined, names: string[], op: Operation, key: string) {
    const list = await this.resolveList(listName);
    const byName = new Map((await this.items(list)).purchase.map((p) => [p.itemId.toLowerCase(), p]));
    const changes: Change[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const p = byName.get(name.trim().toLowerCase());
      if (!p) missing.push(name);
      else changes.push({ itemId: p.itemId, spec: p.specification, uuid: p.uuid });
    }
    if (changes.length) await this.update(list, changes, op);
    return { list: list.name, [key]: changes.map((c) => c.itemId), not_on_list: missing };
  }

  complete(listName: string | null | undefined, names: string[]) {
    return this.change(listName, names, "TO_RECENTLY", "completed");
  }

  remove(listName: string | null | undefined, names: string[]) {
    return this.change(listName, names, "REMOVE", "removed");
  }
}
