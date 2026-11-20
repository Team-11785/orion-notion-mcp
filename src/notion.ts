export const NOTION_VERSION = "2026-03-11";
const BASE = "https://api.notion.com/v1";

export class NotionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class Notion {
  constructor(private token: string, private version = NOTION_VERSION) {}

  async request<T = any>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const url = new URL(BASE + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": this.version,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      // Notion allows ~3 requests/second. Back off on rate limits and transient errors.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 8000)));
        continue;
      }

      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { message: text };
      }
      if (!res.ok) {
        throw new NotionError(res.status, data?.code ?? "unknown_error", data?.message ?? `HTTP ${res.status}`);
      }
      return data as T;
    }
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>("GET", path, undefined, query);
  }
  post<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("POST", path, body ?? {}, query);
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body ?? {});
  }
  delete<T = any>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

/** Accepts a raw ID (with or without dashes) or any Notion URL and returns a dashed UUID. */
export function normalizeId(input: string): string {
  const trimmed = String(input ?? "").trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return trimmed.toLowerCase();

  const findHex = (s: string) => s.replace(/-/g, "").match(/[0-9a-f]{32}(?![0-9a-f])/i)?.[0];

  let hex: string | undefined;
  if (/^(https?:|collection:|view:)/i.test(trimmed)) {
    try {
      const u = new URL(trimmed.replace(/^(collection|view):\/\//i, "https://x/"));
      // A peeked page (?p=...) wins, then the last path segment, then the #block anchor.
      hex =
        findHex(u.searchParams.get("p") ?? "") ??
        findHex(u.pathname.split("/").filter(Boolean).pop() ?? "") ??
        findHex(u.hash.slice(1));
    } catch {
      /* fall through */
    }
  }
  hex ??= findHex(trimmed);
  if (!hex) throw new Error(`Could not find a Notion ID in "${input}"`);
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
